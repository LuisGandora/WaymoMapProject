"""Build a tour (route + frames + stops) from the precomputed data, and fill in its narration."""
import json
from functools import lru_cache

import networkx as nx

from . import config, graph, narrate, router, safety, store


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


def tour_id(mood, minutes, start, safe=False, at=None, to=None):
    return (f"{mood.replace('+', '_')}-{minutes}-{start}" + ("-safe" if safe else "")
            + (f"-from{at[0]:.4f}_{at[1]:.4f}" if at else "") + (f"-to{to[0]:.4f}_{to[1]:.4f}" if to else ""))


@lru_cache
def _frame_points():
    """Street pieces whose Street View frame is on disk: the only places a tour may start or end."""
    return [p for p in _load("points.json") if config.has_frame(p["id"])]


def snap(lat, lng, max_m=250):
    """The photo-backed street piece nearest (lat, lng), or ValueError if none is within max_m."""
    p = min(_frame_points(), key=lambda p: router.haversine_m((lat, lng), (p["lat"], p["lng"])))
    if router.haversine_m((lat, lng), (p["lat"], p["lng"])) > max_m:
        raise ValueError("no photo-covered street near that spot; pick a spot closer to a photographed street")
    return p


def build(mood, minutes, start, safe=False, at=None, to=None):
    """Same (mood, minutes, start, safe, at, to) returns the stored tour instead of rebuilding.

    at=(lat, lng) starts from a spot the user picked instead of the neighborhood's default start; to=(lat, lng) is the
    destination the user picked (otherwise the most scenic block within reach is chosen).
    Both snap to the nearest photographed street. With `to`, the path is exactly the road from the start to the
    destination (nothing before the start, nothing after the end, no detours); the time budget is a ceiling on it.
    """
    tid = tour_id(mood, minutes, start, safe, at, to)
    if (existing := store.get(tid)) and "summary" in existing and existing.get("dest_id"):  # older cached docs (loops): rebuild
        return existing
    M, segs, G = matrix(mood), segments(), graph.get()
    wx, live = safety.weather(), safety.closures()
    safety.apply(G, alert=wx["flood"], closures=live)
    weight = "safe_time" if safe else "travel_time"
    nodes = dict(M["nodes"])
    o = snap(*(at or config.HOODS[start]["start"]))
    K0 = "start"
    nodes[K0] = {"enter": o["u"], "exit": o["u"], "traverse": 0}
    minutes_of = lambda es: sum(graph.best_edge(G, a, b)["travel_time"] for a, b in es) / 60  # real minutes on the drawn road

    def drive(w):
        edges, cur = [], o["u"]
        for k in route[1:]:
            try:
                p = nx.shortest_path(G, cur, nodes[k]["enter"], weight=w)
            except nx.NetworkXNoPath:
                raise ValueError("no drivable route between the start and that spot")
            edges += zip(p, p[1:])
            if k in segs and nodes[k]["enter"] != nodes[k]["exit"]:
                edges.append((nodes[k]["enter"], nodes[k]["exit"]))
            cur = nodes[k]["exit"]
        return edges

    # Every tour is one-way and simple: exactly the road from the start to the destination. Nothing before the
    # start, nothing after the destination, no detours, and a shortest path never revisits a spot, so no cycles.
    if to:
        e = snap(*to)
        if e["id"] not in segs:
            raise ValueError("that end point is on a street with no scenic score; pick another")
    else:
        # No destination picked: a scenic block for this mood that the road reaches with time to spare.
        fwd = nx.single_source_dijkstra_path_length(G, o["u"], weight="travel_time")
        want = config.mood_tags(mood)  # None = any
        reach = [k for k, g in segs.items() if k != o["id"] and config.has_frame(k) and (want is None or set(want) & set(g["tags"]))
                 and fwd.get(g["u"], router.INF) / 60 <= 0.85 * minutes]
        if not reach:
            raise ValueError("no scenic block for this mood is within reach of the start in that time; try more minutes or another mood")
        # The budget sets how far: best-scored block 50-85% of it away; if the scored area is smaller than that,
        # the best of the five farthest.
        mins = lambda k: fwd[segs[k]["u"]] / 60
        pool = [k for k in reach if mins(k) >= 0.5 * minutes] or sorted(reach, key=mins)[-5:]
        e = segs[max(pool, key=lambda k: (segs[k]["score"], mins(k)))]
    if e["u"] == o["u"]:
        raise ValueError("the start and the destination are the same spot")
    END = e["id"]
    nodes[END] = {"enter": e["u"], "exit": e["u"], "traverse": 0}  # the path stops at the block's near end
    route = [K0, END]
    edges = drive(weight)
    fastest = drive("travel_time") if safe else edges
    total = minutes_of(edges)
    if total > minutes:
        raise ValueError(f"that destination is about {total:.0f} min from the start, more than your {minutes}-minute budget")

    coords, frames, dist = [], [], 0
    for a, b in edges:
        d = graph.best_edge(G, a, b)
        dist += d["length"]
        pts = list(d["geometry"].coords) if "geometry" in d else [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[b]["x"], G.nodes[b]["y"])]
        coords += pts[1:] if coords and coords[-1] == pts[0] else pts
        frames += _frames_on(a, b)

    want = config.mood_tags(mood)  # the numbered stops are the best blocks the road passes; None = any
    onpath = [k for k in dict.fromkeys(f["segment"] for f in frames) if k in segs and k not in (o["id"], END)]
    ids = [k for k in onpath if want is None or set(want) & set(segs[k]["tags"])] or onpath
    ids.append(END)
    stops = []
    for k in ids:
        s = segs[k]
        idx = next((i for i, f in enumerate(frames) if f["segment"] == k), None)
        stop = {
            "id": k, "lat": s["lat"], "lng": s["lng"], "street": s["street"], "score": s["score"], "tags": s["tags"],
            "frame_idx": idx, "photo": frames[idx]["url"] if idx is not None else (f"/static/frames/{k}.jpg" if config.has_frame(k) else None),
            "why": f"{s['street'] or 'This block'} scored {s['score']}/10" + (f" for {', '.join(s['tags'])}" if s["tags"] else ""),
            "script": {}, "audio": {},
        }
        if s.get("place"):
            stop["place"] = s["place"]  # from pipeline.check; narrate_tour skips a second Places call
        stops.append(stop)
    sc = safety.score(G, edges, alert=wx["flood"], closures=live)
    if sc and safe:
        fast = safety.score(G, fastest, alert=wx["flood"], closures=live)
        fast_min = sum(graph.best_edge(G, a, b)["travel_time"] for a, b in fastest) / 60
        sc["vs_fastest"] = {"minutes": round(total - fast_min, 1), "hin_km": round(sc["hin_km"] - fast["hin_km"], 2),
                            "score": sc["score"] - fast["score"], "arterial_pct": sc["arterial_pct"] - fast["arterial_pct"]}
        base = build(mood, minutes, start, safe=False, at=at, to=to)  # the same request with Safer Route off (cached after the first time)
        if bs := base["summary"].get("safety"):
            sc["vs_default"] = {"minutes": round(total - base["summary"]["drive_minutes"], 1), "hin_km": round(sc["hin_km"] - bs["hin_km"], 2),
                                "score": sc["score"] - bs["score"], "calm_pct": sc["calm_pct"] - bs["calm_pct"], "stops": len(stops) - base["summary"]["stops"]}
    tour = {
        "id": tid, "mood": mood, "minutes": minutes, "start": start, "safe": safe,
        "origin": {"id": o["id"], "lat": o["lat"], "lng": o["lng"], "street": o["street"], "photo": f"/static/frames/{o['id']}.jpg"},
        "dest_id": END,  # the last stop; the path ends there
        "path": {"type": "LineString", "coordinates": [list(c) for c in coords]},
        "frames": frames, "stops": stops,
        "summary": {"distance_km": round(dist / 1000, 1), "drive_minutes": round(total, 1), "stops": len(stops), "businesses": [],
                    "safety": sc, "weather": {"flood": wx["flood"], "storm": wx["storm"], "alerts": [a["event"] for a in wx["alerts"]]}},
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
