"""Build a tour (route + frames + stops) from the precomputed data, and fill in its narration."""
import json
import math
from functools import lru_cache

import networkx as nx
from shapely.geometry import Point
from shapely.prepared import prep

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


def why(street, score, tags):
    """The one-line description shown under a photo, for stops and street clicks alike."""
    if score is None:
        return ""
    return f"{street or 'This block'} scored {score}/10" + (f" for {', '.join(tags)}" if tags else "")


def tour_id(mood, minutes, start):
    return f"{mood.replace('+', '_')}-{minutes}-{start}"


@lru_cache
def _frame_points():
    """Street pieces whose Street View frame is on disk: the only places a tour may start."""
    return [p for p in _load("points.json") if config.has_frame(p["id"])]


def snap(lat, lng, max_m=250):
    """The photo-backed street piece nearest (lat, lng), or ValueError if none is within max_m."""
    p = min(_frame_points(), key=lambda p: router.haversine_m((lat, lng), (p["lat"], p["lng"])))
    if router.haversine_m((lat, lng), (p["lat"], p["lng"])) > max_m:
        raise ValueError("no photo-covered street near that spot; pick a spot closer to a scored street")
    return p


VERSION = 6  # bump when the routing changes: stored tours from an older version are rebuilt, not served
TOP_N = 10


def build_options(mood, minutes, start, at=None, n=TOP_N):
    """The top-n one-way tours from `start` (a HOODS key, or `at=(lat, lng)` for a custom spot), best first.

    Each is stored as its own tour `<base>-r<rank>`; the returned doc lists their summaries.
    Routes under half the length of the longest candidate are dropped. Ranking: mean stop score (in half-point steps) first, then how much of the drive stays inside the
    Waymo service area (no crossing uncharted territory), then total drive time (shorter wins).
    Same (mood, minutes, start) returns the stored doc instead of rebuilding.
    """
    if at:
        start = f"pt{at[0]:.4f}_{at[1]:.4f}"
    base = tour_id(mood, minutes, start)
    if (existing := store.get(base)) and existing.get("v") == VERSION:
        return existing
    M, segs, G = matrix(mood), segments(), graph.get()
    nodes = M["nodes"]
    o = snap(*(at or config.HOODS[start]["start"]))
    # Drive minutes from the start to every candidate, live: the start can be anywhere, so it isn't in the matrix.
    secs = nx.single_source_dijkstra_path_length(G, o["u"], weight="travel_time")
    cands = [k for k in nodes if k in segs and config.has_frame(k) and nodes[k]["enter"] in secs]
    d = {k: secs[nodes[k]["enter"]] / 60 + nodes[k]["traverse"] for k in cands}
    K0 = "start"
    t = lambda a, b: d[b] if a == K0 else M["minutes"][a].get(b, router.INF)
    nodes = {**nodes, K0: {"enter": o["u"], "exit": o["u"]}}
    area = prep(graph.polygon())
    origin = {**{x: o[x] for x in ("id", "lat", "lng", "street")}, "photo": f"/static/frames/{o['id']}.jpg",
              "score": segs.get(o["id"], {}).get("score"), "tags": segs.get(o["id"], {}).get("tags", [])}
    origin["why"] = why(origin["street"], origin["score"], origin["tags"])

    def one(end):
        """A tour ending at `end`, or None if nothing fits. Stops come only from a narrow corridor along the
        direct route, and nothing before the start or past the end (along that direction) is searched."""
        direct = d[end]
        slack = min(0.2 * direct + 1, minutes - direct)  # ponytail: fixed 20% corridor, tune if tours feel too straight/loose
        S, E = G.nodes[o["u"]], G.nodes[nodes[end]["exit"]]  # `along`: 0 at the start, 1 at the end
        cx = math.cos(math.radians(S["y"]))
        ax, ay = (E["x"] - S["x"]) * cx, E["y"] - S["y"]
        if not (ax or ay):
            return None
        along = lambda x, y: ((x - S["x"]) * cx * ax + (y - S["y"]) * ay) / (ax * ax + ay * ay)
        margin = 150 / (math.hypot(ax, ay) * 111320)
        H = G.subgraph(n for n, v in G.nodes(data=True) if -margin <= along(v["x"], v["y"]) <= 1 + margin)
        ahead = [c for c in cands if c != end and 0 <= along(segs[c]["lng"], segs[c]["lat"]) <= 1
                 and t(c, end) < direct and d[c] + t(c, end) - direct <= slack]
        route, _ = router.build_loop(t, {k: segs[k]["score"] for k in cands}, K0, ahead, min(minutes, direct + slack), end)

        def drive(route):
            edges, cur = [], o["u"]
            for k in route[1:]:
                try:
                    p = nx.shortest_path(H, cur, nodes[k]["enter"], weight="travel_time")
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    p = nx.shortest_path(G, cur, nodes[k]["enter"], weight="travel_time")
                edges += zip(p, p[1:])
                if k in segs:
                    edges.append((nodes[k]["enter"], nodes[k]["exit"]))
                cur = nodes[k]["exit"]
            return edges, sum(graph.best_edge(G, a, b)["travel_time"] for a, b in edges) / 60

        # The matrix times are estimates; the real drive is measured on the built path and must fit the budget.
        edges, total = drive(route)
        while total > minutes and len(route) > 2:
            route.remove(min(route[1:-1], key=lambda k: segs[k]["score"]))  # drop the weakest stop
            edges, total = drive(route)
        if total > minutes:
            return None

        coords, frames, meters = [], [], 0
        for a, b in edges:
            e = graph.best_edge(G, a, b)
            meters += e["length"]
            pts = list(e["geometry"].coords) if "geometry" in e else [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[b]["x"], G.nodes[b]["y"])]
            coords += pts[1:] if coords and coords[-1] == pts[0] else pts
            frames += _frames_on(a, b)
        stops = []
        for k in route[1:]:
            sg = segs[k]
            idx = next((i for i, f in enumerate(frames) if f["segment"] == k), None)
            stops.append({
                "id": k, "lat": sg["lat"], "lng": sg["lng"], "street": sg["street"], "score": sg["score"], "tags": sg["tags"],
                "frame_idx": idx, "photo": frames[idx]["url"] if idx is not None else None,
                "why": why(sg["street"], sg["score"], sg["tags"]), "script": {}, "audio": {},
            })
        inside = sum(area.contains(Point(c)) for c in coords) / len(coords)
        return {
            "v": VERSION, "mood": mood, "minutes": minutes, "start": start, "origin": origin,
            "path": {"type": "LineString", "coordinates": [list(c) for c in coords]},
            "frames": frames, "stops": stops, "inside": inside,  # popped before saving
            "summary": {"distance_km": round(meters / 1000, 1), "drive_minutes": round(total, 1), "stops": len(stops), "businesses": []},
        }

    # Candidate destinations: within 55% of the budget, preferring the 35-55% window (15 min stays close to the
    # start, 30 min reaches further), best score first. Try the strongest 40, keep the best n by the ranking.
    reach = [c for c in cands if d[c] <= 0.55 * minutes]
    if not reach:
        raise ValueError("nothing scored is close enough for this mood and time budget from here")
    reach.sort(key=lambda c: (d[c] >= 0.35 * minutes, segs[c]["score"], d[c]), reverse=True)
    tours = [x for x in map(one, reach[:40]) if x]
    if not tours:
        raise ValueError("no route fits this mood and time budget from here")
    longest = max(x["summary"]["drive_minutes"] for x in tours)
    tours = [x for x in tours if x["summary"]["drive_minutes"] >= 0.5 * longest]  # no token 30-second "tours" winning on a tie
    rank = lambda x: (-round(2 * sum(s["score"] for s in x["stops"]) / len(x["stops"])) / 2, -round(x["inside"], 2), x["summary"]["drive_minutes"])
    tours.sort(key=rank)
    options = []
    for r, x in enumerate(tours[:n], 1):
        x["id"] = f"{base}-r{r}"
        x["score"] = round(sum(s["score"] for s in x["stops"]) / len(x["stops"]), 1)
        inside = x.pop("inside")
        store.save(x)
        options.append({"id": x["id"], "rank": r, "score": x["score"], "inside_pct": round(100 * inside), **x["summary"],
                        "start_street": origin["street"], "end_street": x["stops"][-1]["street"]})
    doc = {"v": VERSION, "id": base, "options": options}
    store.save(doc)
    return doc


def build(mood, minutes, start, at=None):
    """The best-ranked tour (what bake.py narrates)."""
    return store.get(build_options(mood, minutes, start, at)["options"][0]["id"])


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
