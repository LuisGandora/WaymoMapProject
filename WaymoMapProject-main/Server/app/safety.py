"""Road-safety layer at request time: edge weights for a safer route, live weather + closures, and a per-tour score.

Data comes from pipeline.safety (data/safety.json). Everything degrades gracefully: with no safety.json every street
is neutral, with no FL511 key there are simply no closures, and if api.weather.gov is unreachable there is no alert.
"""
import json
import time
from functools import lru_cache

import httpx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from . import config, graph

# How much each hazard stretches an edge's travel time when routing in safe mode. These are the knobs.
W = {
    "hin": 1.0,          # on a High Injury Network corridor: +100%
    "stop_on_hin": 0.6,  # safe mode only: a candidate STOP on a High Injury Network corridor keeps 60% of its score, so
                         # the tour prefers the murals on calmer streets (a robotaxi slowing for a photo op on Biscayne is the risk)
    "ksi": 0.2,          # per killed/seriously-injured crash on the piece, capped at +100%
    "ksi_cap": 1.0,
    "arterial": 0.4,     # 4+ lanes or 40+ mph: +40%
    "calm": -0.1,        # residential / slow two-lane: -10%
    "flood_alert": 1.0,  # in a FEMA flood zone while a flood alert is active: +100%
    "closure": 9.0,      # a live FL511 closure/incident on the piece: effectively blocked
}
CLOSURE_NEAR_DEG = 0.0004  # ~40 m


@lru_cache
def data():
    f = config.DATA / "safety.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"meta": {}, "edges": {}}


def edge(u, v, k=0):
    return data()["edges"].get(f"{u},{v},{k}") or data()["edges"].get(f"{v},{u},{k}") or {}


def apply(G, alert=False, closures=None):
    """Set d['safe_time'] on every edge for the current weather/closures. The static part is computed once per process."""
    blocked = closed_edges(G, closures) if closures else set()
    for u, v, k, d in G.edges(keys=True, data=True):
        if "_safe_static" not in d:
            s = edge(u, v, k)
            d["_safe_static"] = (1 + W["hin"] * s.get("hin", 0) + min(W["ksi_cap"], W["ksi"] * s.get("ksi", 0))
                                 + W["arterial"] * s.get("arterial", 0) + W["calm"] * s.get("calm", 0), s.get("flood", 0))
        f, flood = d["_safe_static"]
        if alert:
            f += W["flood_alert"] * flood
        if (u, v, k) in blocked:
            f += W["closure"]
        d["safe_time"] = d["travel_time"] * f
    return G


def stop_factor(seg):
    """Score multiplier for a candidate stop in safe mode: discounted when its block is on a high-injury corridor."""
    return W["stop_on_hin"] if edge(seg["u"], seg["v"]).get("hin") else 1.0


def score(G, edges, alert=False, closures=None):
    """Explainable safety summary for a driven edge list [(u, v), ...]: km on hazards + a 0-100 score."""
    km = hin_km = art_km = calm_km = flood_km = 0.0
    ksi = ped = 0
    blocked = closed_edges(G, closures) if closures else set()
    hit_closures = 0
    for u, v in edges:
        d = graph.best_edge(G, u, v)
        s, L = edge(u, v), d["length"] / 1000
        km += L
        hin_km += L * s.get("hin", 0)
        art_km += L * s.get("arterial", 0)
        calm_km += L * s.get("calm", 0)
        flood_km += L * s.get("flood", 0)
        ksi += s.get("ksi", 0)
        ped += s.get("ped", 0)
        hit_closures += any((u, v, k) in blocked for k in G[u][v])
    if not km:
        return None
    pct = lambda x: round(100 * x / km)
    ksi_per_km = ksi / km
    # Crash exposure is judged against the area's average street (dense commercial districts have more crashes than
    # suburbs whatever you do): at the average -6 pts, at 4x the average the full -25.
    avg = data()["meta"].get("ksi_per_km_avg") or ksi_per_km or 1
    rel = ksi_per_km / avg
    points = 100 - 45 * hin_km / km - 25 * min(1.0, rel / 4) - 20 * art_km / km - (10 * flood_km / km if alert else 0) - 15 * min(1, hit_closures)
    points = max(0, min(100, round(points)))
    return {
        "score": points, "grade": "A" if points >= 85 else "B" if points >= 70 else "C" if points >= 55 else "D",
        "km": round(km, 1), "hin_km": round(hin_km, 2), "hin_pct": pct(hin_km), "arterial_pct": pct(art_km), "calm_pct": pct(calm_km),
        "flood_km": round(flood_km, 2), "flood_alert": bool(alert), "ksi_crashes": ksi, "ksi_pedestrian": ped,
        "ksi_per_km": round(ksi_per_km, 2), "ksi_vs_area": round(rel, 1), "closures": hit_closures,
    }


# ---- live feeds ------------------------------------------------------------------------------------------------------

_cache = {}
FEED_RETRY_S = 60  # after a failed fetch, try again this soon instead of waiting out the whole cache TTL
FEED_TIMEOUT = httpx.Timeout(4.0, connect=6.0)  # feeds run inside a new tour's build: a slow one must not stall Generate


def _cached(key, ttl, fn):
    now = time.time()
    if key not in _cache or now - _cache[key][0] > ttl:
        try:
            _cache[key] = (now, fn())
        except Exception as e:  # never let a feed outage break routing
            print(f"safety feed {key} failed: {e}")
            _cache[key] = (now - ttl + FEED_RETRY_S, _cache.get(key, (0, None))[1])  # keep the last value, but retry soon
    return _cache[key][1]


def weather():
    """Active NWS alerts at the service area's centre: {alerts: [...], flood: bool, storm: bool}. Cached 10 min."""
    def fetch():
        c = graph.polygon().centroid
        r = httpx.get("https://api.weather.gov/alerts/active", params={"point": f"{c.y:.4f},{c.x:.4f}"}, timeout=FEED_TIMEOUT,
                      headers={"User-Agent": "WaymoMapProject (hackathon; contact via github)", "Accept": "application/geo+json"})
        r.raise_for_status()
        alerts = [{k: f["properties"].get(k) for k in ("event", "severity", "urgency", "headline", "onset", "expires")}
                  for f in r.json().get("features", [])]
        ev = " ".join((a["event"] or "") for a in alerts).lower()
        return {"alerts": alerts, "flood": "flood" in ev, "storm": any(w in ev for w in ("thunderstorm", "tornado", "hurricane", "tropical")),
                "checked": time.strftime("%H:%M")}
    return _cached("weather", 600, fetch) or {"alerts": [], "flood": False, "storm": False, "checked": None}


def closures():
    """Live FL511 incidents/closures inside the service area (needs FL511_API_KEY). Cached 2 min. [] without a key."""
    key = config.FL511_KEY
    if not key:
        return []

    def fetch():
        r = httpx.get("https://fl511.com/api/v2/get/event", params={"key": key, "format": "json"}, timeout=FEED_TIMEOUT)
        r.raise_for_status()
        x0, y0, x1, y1 = graph.polygon().bounds
        out = []
        for e in r.json():
            lat, lng = e.get("Latitude"), e.get("Longitude")
            if lat is None or lng is None or not (y0 <= lat <= y1 and x0 <= lng <= x1):
                continue
            if e.get("IsFullClosure") or e.get("EventType") in ("closures", "accidentsAndIncidents"):
                out.append({"lat": lat, "lng": lng, "road": e.get("RoadwayName"), "type": e.get("EventType"), "desc": e.get("Description"), "full": bool(e.get("IsFullClosure"))})
        return out
    return _cached("closures", 120, fetch) or []


@lru_cache
def _edge_tree(G):
    keys, geoms = [], []
    for u, v, k, d in G.edges(keys=True, data=True):
        keys.append((u, v, k))
        geoms.append(d["geometry"] if "geometry" in d else LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])]))
    return keys, geoms, STRtree(geoms)


def closed_edges(G, events):
    """Edge keys within ~40 m of a live closure/incident."""
    keys, geoms, tree = _edge_tree(G)
    hit = set()
    for e in events:
        p = Point(e["lng"], e["lat"])
        for i in tree.query(p.buffer(CLOSURE_NEAR_DEG)):
            if geoms[i].distance(p) <= CLOSURE_NEAR_DEG:
                hit.add(keys[i])
    return hit
