"""Build a tour (route + frames + stops) from the precomputed data, and fill in its narration."""
import json
from functools import lru_cache

import networkx as nx

from . import config, graph, narrate, router, store


def _load(name):
    return json.loads((config.DATA / name).read_text(encoding="utf-8"))


@lru_cache
def segments():
    return {s["id"]: s for s in _load("segments.json")}


@lru_cache
def matrix(mood):
    return _load(f"matrix_{mood}.json")


@lru_cache
def _by_edge():
    d = {}
    for s in segments().values():
        d.setdefault((s["u"], s["v"]), []).append(s)
    for lst in d.values():
        lst.sort(key=lambda s: s["i"])
    return d


def _frames_on(a, b):
    e = _by_edge()
    # ponytail: driving an edge against its sampled direction reuses the same frames, reversed
    segs = e.get((a, b)) or e.get((b, a), [])[::-1]
    for s in segs:
        if (config.MEDIA / "frames" / f"{s['id']}.jpg").exists():
            yield {"lat": s["lat"], "lng": s["lng"], "url": f"/static/frames/{s['id']}.jpg", "segment": s["id"]}


def tour_id(mood, minutes, start):
    return f"{mood.replace('+', '_')}-{minutes}-{start}"


def build(mood, minutes, start):
    """Same (mood, minutes, start) returns the stored tour instead of rebuilding."""
    tid = tour_id(mood, minutes, start)
    if existing := store.get(tid):
        return existing
    M, segs, G = matrix(mood), segments(), graph.get()
    nodes, k0 = M["nodes"], f"start:{start}"
    # --- Radius filter ---------------------------------------------------------------------------
    # Problem: the matrix holds the best-scored blocks for this mood across EVERY scored neighborhood.
    # Once the router has used up the blocks near the start and still has minutes left, the only
    # candidates remaining are far away, so it drives across the city for one or two more stops
    # (e.g. a Wynwood tour crossing the Miami River for two Little Havana blocks).
    # Fix: a tour may only use blocks within a radius of its start point. The radius grows with the
    # time budget: 15 min -> 1.5 km, 30 min -> 2.2 km, 45 min -> 2.8 km. Wynwood and Little Havana are
    # 3.3 km apart, so at these sizes a tour always stays in the neighborhood it started in.
    origin = config.HOODS[start]["start"]                    # (lat, lng) of the loop's start point
    radius_m = 800 + 45 * minutes                             # metres; the formula above
    cands = [
        k for k in nodes                                      # every candidate block in the matrix
        if k in segs                                          # ...that is a scored street piece (not a start node)
        and router.haversine_m(origin, (segs[k]["lat"], segs[k]["lng"])) <= radius_m  # ...within reach
    ]
    # ----------------------------------------------------------------------------------------------
    route, total = router.build_loop(lambda a, b: M["minutes"][a].get(b, router.INF),
                                     {k: segs[k]["score"] for k in cands}, k0, cands, minutes)
    if len(route) == 2:
        raise ValueError("no scored stops fit this mood and time budget")

    edges, cur = [], nodes[k0]["exit"]
    for k in route[1:]:
        p = nx.shortest_path(G, cur, nodes[k]["enter"], weight="travel_time")
        edges += zip(p, p[1:])
        if k in segs:
            edges.append((nodes[k]["enter"], nodes[k]["exit"]))
        cur = nodes[k]["exit"]

    coords, frames, dist = [], [], 0
    for a, b in edges:
        d = graph.best_edge(G, a, b)
        dist += d["length"]
        pts = list(d["geometry"].coords) if "geometry" in d else [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[b]["x"], G.nodes[b]["y"])]
        coords += pts[1:] if coords and coords[-1] == pts[0] else pts
        frames += _frames_on(a, b)

    stops = []
    for k in route[1:-1]:
        s = segs[k]
        idx = next((i for i, f in enumerate(frames) if f["segment"] == k), None)
        stop = {
            "id": k, "lat": s["lat"], "lng": s["lng"], "street": s["street"], "score": s["score"], "tags": s["tags"],
            "frame_idx": idx, "photo": frames[idx]["url"] if idx is not None else None,
            "why": f"{s['street'] or 'This block'} scored {s['score']}/10" + (f" for {', '.join(s['tags'])}" if s["tags"] else ""),
            "script": {}, "audio": {},
        }
        if s.get("place"):
            stop["place"] = s["place"]  # from pipeline.check; narrate_tour skips a second Places call
        stops.append(stop)
    tour = {
        "id": tid, "mood": mood, "minutes": minutes, "start": start,
        "path": {"type": "LineString", "coordinates": [list(c) for c in coords]},
        "frames": frames, "stops": stops,
        "summary": {"distance_km": round(dist / 1000, 1), "drive_minutes": round(total, 1), "stops": len(stops), "businesses": []},
    }
    store.save(tour)
    return tour


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # a flaky Places/Wikipedia call shouldn't kill the narration
        print(f"narrate lookup failed: {e}")


def narrate_tour(tid, lang):
    """Script + MP3 per stop in `lang`, saved after each stop so a polling client sees progress."""
    t = store.get(tid)
    for i, s in enumerate(t["stops"]):
        if lang in s["audio"]:
            continue
        if "place" not in s:
            s["place"], s["wiki"] = _safe(narrate.place_near, s["lat"], s["lng"]), _safe(narrate.wiki_near, s["lat"], s["lng"])
        s["script"][lang] = narrate.script(s, lang)
        f = config.MEDIA / "audio" / f"{tid}-{i}-{lang}.mp3"
        narrate.tts(s["script"][lang], f)
        s["audio"][lang] = f"/static/audio/{f.name}"
        t["summary"]["businesses"] = [x["place"]["name"] for x in t["stops"] if x.get("place")]
        store.save(t)
