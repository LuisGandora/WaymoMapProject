"""Build a tour (route + frames + stops) from the precomputed data, and fill in its narration."""
import json
import threading
from functools import lru_cache

import networkx as nx

from . import config, graph, narrate, router, safety, store


def _load(name):
    return json.loads((config.DATA / name).read_text(encoding="utf-8"))


# Loop quality knobs. A loop only stops at blocks whose raw score is at least MIN_STOP_SCORE, so a
# long budget in a small neighborhood is not padded with 3/10 walls just to use the time. A stop whose leg out retraces
# its leg in for more than SPUR_M metres is an out-and-back spur and is dropped (see build).
MIN_STOP_SCORE = 4
SPUR_M = 60
# A stop's block may be driven either way where the street is two-way; the drawn route picks, per stop, the direction
# that makes the whole loop shortest (no more driving a block backwards to its sampled start and then forwards again).
# Planning still uses the matrix's fixed direction, so no matrix rebuild is needed. False = always the sampled direction.
TWO_WAY_BLOCKS = True
ROUTER_VERSION = 8  # bump when routing logic changes: a cached tour built by an older version is rebuilt on request (8: hin_driven + compare)


# Where a tour's scenic scores come from. "photo": Street View frames rated by AI (the original pipeline, data/).
# "popular": places people map and look up online, every street in the service area, no photos needed (pipeline.popular,
# data/popular/). Both have the same file shapes, so everything below works on either.
SOURCES = ("photo", "popular")


def _src(name, source):
    return name if source == "photo" else f"{source}/{name}"


@lru_cache
def segments(source="photo"):
    return {s["id"]: s for s in _load(_src("segments.json", source))}


@lru_cache
def matrix(mood, source="photo"):
    return _load(_src(f"matrix_{mood}.json", source))


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


def _why_popular(s):
    """One line for a popular-source stop: the places near it, the best-known first, with its Wikipedia readership."""
    named = [p for p in s.get("pois", []) if p.get("name")]
    if not named:
        what = {"historic": "a historic site", "greenery": "a park", "waterfront": "the waterfront", "food": "places to eat", "mural": "street art"}
        return "Near " + (" and ".join(what.get(t, t.replace("_", " ")) for t in s["tags"]) or "popular places")
    first = named[0]["name"] + (f" ({named[0]['views']:,} Wikipedia readers a month)" if named[0].get("views") else "")
    return "Near " + ", ".join([first] + [p["name"] for p in named[1:]])


def _hin_driven(G, edges):
    """The High Injury Network pieces a drive uses (each once, either direction), as GeoJSON for the Safer Route map."""
    feats, seen = [], set()
    for a, b in edges:
        s, key = safety.edge(a, b), ",".join(sorted((str(a), str(b))))
        if not s.get("hin") or key in seen:
            continue
        seen.add(key)
        d = graph.best_edge(G, a, b)
        name = d.get("name") or ""
        line = list(d["geometry"].coords) if "geometry" in d else [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[b]["x"], G.nodes[b]["y"])]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(c) for c in line]},
                      "properties": {"key": key, "street": name[0] if isinstance(name, list) else name, "km": round(d["length"] / 1000, 3),
                                     "ksi": s.get("ksi", 0), "ped": s.get("ped", 0)}})
    return {"type": "FeatureCollection", "features": feats}


# Ranked alternatives: a request for the same (mood, minutes, start, safe) can ask for rank 0..TOP_N-1. Each rank is a loop built
# around its own "anchor": the mood's top blocks are ranked by priority (scenic score, and how quick the round trip to reach them
# is: W_TIME is the share given to speed), kept APART_M apart, and rank r is the loop that must pass through anchor r while
# avoiding the areas of the higher-ranked anchors, so the offered loops really differ.
TOP_N = 10        # loops offered per request, best first; the rider skips through them
W_TIME = 0.4      # share of an anchor's priority that is "quick to reach"; the rest is its scenic score
APART_M = 500     # anchors are at least this far apart, and rank r avoids everything this close to the anchors ranked above it


def tour_id(mood, minutes, start, safe=False, at=None, to=None, rank=0, source="photo"):
    return (f"{mood.replace('+', '_')}-{minutes}-{start}" + ("-safe" if safe else "") + (f"-{source}" if source != "photo" else "")
            + (f"-from{at[0]:.4f}_{at[1]:.4f}" if at else "") + (f"-to{to[0]:.4f}_{to[1]:.4f}" if to else "")
            + (f"-r{rank}" if rank else ""))


@lru_cache
def _frame_points():
    """Street pieces whose Street View frame is on disk and whose street is in the loaded graph: the only places a tour may
    start or end. (Blocks scored on a bigger AREA_BUFFER_MILES graph than this machine's graph.graphml are skipped, not a 500.)"""
    G = graph.get()
    return [p for p in _load("points.json") if config.has_frame(p["id"]) and p["u"] in G]


@lru_cache
def _node_points():
    G = graph.get()
    return [(n, d["y"], d["x"]) for n, d in G.nodes(data=True)]


def snap_node(lat, lng, max_m=250):
    """The street-graph node nearest (lat, lng) as a start point, for the popular source (any street can be a start there)."""
    n, y, x = min(_node_points(), key=lambda p: (p[1] - lat) ** 2 + ((p[2] - lng) * 0.9) ** 2)  # cos(25.8°) ≈ 0.9
    if router.haversine_m((lat, lng), (y, x)) > max_m:
        raise ValueError("no street near that spot; pick a spot on a street")
    name = next((d.get("name") for *_, d in graph.get().out_edges(n, data=True) if d.get("name")), "")
    return {"id": f"node{n}", "u": n, "lat": y, "lng": x, "street": name[0] if isinstance(name, list) else name}


def snap(lat, lng, max_m=250, pts=None):
    """The photo-backed street piece (or the piece from `pts`) nearest (lat, lng), or ValueError if none is within max_m."""
    p = min(pts or _frame_points(), key=lambda p: router.haversine_m((lat, lng), (p["lat"], p["lng"])))
    if router.haversine_m((lat, lng), (p["lat"], p["lng"])) > max_m:
        raise ValueError("no photo-covered street near that spot; pick a spot closer to a photographed street")
    return p


def build(mood, minutes, start, safe=False, at=None, to=None, rank=0, source="photo"):
    """Same (mood, minutes, start, safe, at, to, rank, source) returns the stored tour instead of rebuilding.

    Two modes, told apart by whether the rider picked a destination (`to`):
    * Loop (default): the scenic blocks for this mood within reach of the start, inserted into a loop by best score per
      added minute until the time budget is used, and back to the start. 30 minutes means about a 30-minute ride.
    * One-way (`to` given): exactly the road from the start to that destination, past whatever scenic blocks it passes;
      the time budget is a ceiling on it. `dest_id` is set only in this mode.
    at=(lat, lng) starts from a spot picked on the map instead of the neighborhood's default start. Both snap to the
    nearest photographed street. safe=True draws the road on the road-safety weights (see app/safety.py) and, in a
    loop, discounts stops on High Injury Network corridors; every tour gets a safety score plus the comparisons.
    """
    tid = tour_id(mood, minutes, start, safe, at, to, rank, source)
    existing = store.get(tid)
    if existing and existing.get("router") == ROUTER_VERSION and bool(existing.get("dest_id")) == bool(to):  # same routing version and mode; anything older (or a loop cached as a one-way) is rebuilt
        return existing
    M, segs, G = matrix(mood, source), segments(source), graph.get()
    wx, live = safety.weather(), safety.closures()
    safety.apply(G, alert=wx["flood"], closures=live)
    weight = "safe_time" if safe else "travel_time"
    nodes = dict(M["nodes"])
    photo_src = source == "photo"
    o = (snap if photo_src else snap_node)(*(at or config.HOODS[start]["start"]))  # popular: any street can be the start
    K0 = "start"
    nodes[K0] = {"enter": o["u"], "exit": o["u"], "traverse": 0}
    minutes_of = lambda es: sum(graph.best_edge(G, a, b)["travel_time"] for a, b in es) / 60  # real minutes on the drawn road

    hops = {}

    def hop(w, a, b):
        """(cost, node path) of the cheapest road a -> b under w, remembered for this build; (INF, None) if unreachable."""
        if (w, a, b) not in hops:
            try:
                hops[(w, a, b)] = nx.bidirectional_dijkstra(G, a, b, weight=w)
            except (nx.NetworkXNoPath, nx.NodeNotFound):  # NodeNotFound: data built on a bigger graph than this one
                hops[(w, a, b)] = (router.INF, None)
        return hops[(w, a, b)]

    def ways(k):
        """How the block of route entry k may be driven: [(enter, exit)], sampled direction first; both if two-way."""
        n = nodes[k]
        out = [(n["enter"], n["exit"])]
        if TWO_WAY_BLOCKS and k in segs and n["enter"] != n["exit"] and G.has_edge(n["exit"], n["enter"]):
            out.append((n["exit"], n["enter"]))
        return out

    def legs_of(w):
        """One edge list per leg of `route` (start -> stop 1, ..., last stop -> end), each ending with that stop's own block.

        Each stop is driven in whichever of its ways() makes the whole route cheapest under w: a dynamic programme over
        the route with at most two states per stop (the start and a one-way destination have one).
        """
        opts = [ways(k) for k in route]
        cost, back = [[0.0]], [[None]]  # cost[i][j]: cheapest way to have driven route[:i+1] ending on opts[i][j]
        for i in range(1, len(route)):
            ci, bi = [], []
            for enter, exit_ in opts[i]:
                trav = graph.best_edge(G, enter, exit_)[w] if enter != exit_ else 0.0
                best = (router.INF, None)
                for j, (_, prev_exit) in enumerate(opts[i - 1]):
                    c = cost[i - 1][j] + hop(w, prev_exit, enter)[0] + trav
                    if c < best[0]:
                        best = (c, j)
                ci.append(best[0])
                bi.append(best[1])
            cost.append(ci)
            back.append(bi)
        if min(cost[-1]) == router.INF:
            raise ValueError("no drivable route between the start and that spot")
        choice = [0] * len(route)  # which way each entry is driven, read back from the cheapest end state
        choice[-1] = min(range(len(cost[-1])), key=lambda j: cost[-1][j])
        for i in range(len(route) - 1, 0, -1):
            choice[i - 1] = back[i][choice[i]]
        legs = []
        for i in range(1, len(route)):
            enter, exit_ = opts[i][choice[i]]
            p = hop(w, opts[i - 1][choice[i - 1]][1], enter)[1]
            leg = list(zip(p, p[1:]))
            if enter != exit_:
                leg.append((enter, exit_))
            legs.append(leg)
        return legs

    flat = lambda legs: [e for leg in legs for e in leg]
    drive = lambda w: flat(legs_of(w))

    def spur_m(leg_in, leg_out):
        """Metres the leg out of a stop spends retracing the leg into it (its opening edges driven the other way)."""
        back = {(b, a) for a, b in leg_in}
        m = 0
        for a, b in leg_out:
            if (a, b) not in back:
                break
            m += graph.best_edge(G, a, b)["length"]
        return m

    options = 1  # a loop sets this to how many ranked loops exist; a one-way to a picked destination is the only option
    if to:
        # One-way (the rider picked a destination on the map): exactly the road from the start to it. Nothing before
        # the start, nothing after the destination, no detours; a shortest path never revisits a spot, so no cycles.
        e = snap(*to) if photo_src else snap(*to, pts=list(segs.values()))
        if e["id"] not in segs:
            raise ValueError("that end point is on a street with no scenic score; pick another")
        if e["u"] == o["u"]:
            raise ValueError("the start and the destination are the same spot")
        END = e["id"]
        nodes[END] = {"enter": e["u"], "exit": e["u"], "traverse": 0}  # the path stops at the block's near end
        route = [K0, END]
        edges = drive(weight)
        total = minutes_of(edges)
        if total > minutes:
            raise ValueError(f"that destination is about {total:.0f} min from the start, more than your {minutes}-minute budget")
        quality = None  # spurs are a loop thing
    else:
        # Loop (default): the mood's best blocks near the start, inserted by score per added minute until the budget is
        # used, and back to the start (router.build_loop). Candidates come from the mood's matrix; the radius grows with
        # the budget (15 min -> 1.5 km, 30 min -> 2.2 km) so a tour never crosses the city for one more stop.
        END = None
        radius_m = 800 + 45 * minutes
        cands = [k for k in M["nodes"] if k in segs and k != o["id"] and (config.has_frame(k) or not photo_src)  # not the block the tour starts on
                 and M["nodes"][k]["enter"] in G and M["nodes"][k]["exit"] in G  # a matrix built on a bigger graph than this one
                 and router.haversine_m((o["lat"], o["lng"]), (segs[k]["lat"], segs[k]["lng"])) <= radius_m]
        # Block-to-block minutes are precomputed (pipeline.matrix); start-to-block and block-to-start are computed here,
        # out from the start and back to it on the reversed graph, so a start picked on the map works too.
        # Same definition as the matrix: leave a's exit, reach b's enter, drive b.
        out = nx.single_source_dijkstra_path_length(G, o["u"], weight="travel_time")
        back = nx.single_source_dijkstra_path_length(G.reverse(copy=False), o["u"], weight="travel_time")

        def t(a, b):
            if a == K0:
                n = nodes[b]
                return out[n["enter"]] / 60 + n["traverse"] if n["enter"] in out else router.INF
            if b == K0:
                x = nodes[a]["exit"]
                return back[x] / 60 if x in back else router.INF
            return M["minutes"].get(a, {}).get(b, router.INF)

        # safe mode: a stop on a High Injury Network corridor keeps 60% of its score (safety.W["stop_on_hin"])
        stop_score = {k: segs[k]["score"] * (safety.stop_factor(segs[k]) if safe else 1.0) for k in cands}
        cands = [k for k in cands if segs[k]["score"] >= MIN_STOP_SCORE]  # worth stopping for, or not a stop at all (raw score: the safe-mode discount only re-ranks)
        spurs = lambda: [(spur_m(legs[i - 1], legs[i]), route[i]) for i in range(1, len(route) - 1) if route[i] != anchor]  # the anchor is never dropped as a spur  # (metres retraced, stop)
        # Ranked alternatives: anchors by priority, then rank r = the loop through anchor r that avoids the higher anchors' areas.
        pt = lambda k: (segs[k]["lat"], segs[k]["lng"])
        roundtrip = {k: t(K0, k) + t(k, K0) for k in cands}
        prio = lambda k: (1 - W_TIME) * segs[k]["score"] / 10 + W_TIME * (1 - roundtrip[k] / minutes)  # both terms ~0..1
        anchors = []
        for k in sorted((k for k in cands if roundtrip[k] <= 0.9 * minutes), key=prio, reverse=True):  # the anchor itself must fit the budget
            if all(router.haversine_m(pt(k), pt(a)) >= APART_M for a in anchors):
                anchors.append(k)
                if len(anchors) == TOP_N:
                    break
        options = len(anchors)
        if not options:
            raise ValueError("no scored stops for this mood fit that time budget near the start; try more minutes or another mood")
        if rank >= options:
            raise ValueError(f"there are only {options} routes for these settings")
        anchor = anchors[rank]
        cands = [k for k in cands if all(router.haversine_m(pt(k), pt(a)) >= APART_M for a in anchors[:rank])]
        stop_score[anchor] = 1e6  # planning only: the loop is built around its anchor, whatever the discount or the other blocks' value
        dropped, spurs_before, last = set(), None, None
        while True:
            route, _ = router.build_loop(t, stop_score, K0, [k for k in cands if k not in dropped], minutes)
            if len(route) == 2:
                if last is None:
                    raise ValueError("no scored stops for this mood fit that time budget near the start; try more minutes or another mood")
                route, legs = last  # nothing else fits: keep the last loop that did
                break
            legs = legs_of(weight)
            while minutes_of(flat(legs)) > minutes * 1.1 and len(route) > 3:  # the safer road is longer; drop the weakest stop until it fits
                route.remove(min((k for k in route[1:-1] if k != anchor), key=lambda k: segs[k]["score"], default=route[1]))
                legs = legs_of(weight)
            worst = max(spurs(), default=(0, None)) if len(route) > 3 else (0, None)  # a lone remaining stop is allowed to be an out-and-back
            if spurs_before is None:
                spurs_before = sum(m > SPUR_M for m, _ in spurs())
            if worst[0] <= SPUR_M:
                break
            last = (route, legs)
            dropped.add(worst[1])  # an out-and-back spur from here: plan the loop again without that block, so its minutes go to other stops
        edges = flat(legs)
        total = minutes_of(edges)
        quality = {"spurs_before": spurs_before, "spurs_after": sum(m > SPUR_M for m, _ in spurs()), "blocks_dropped": len(dropped),
                   "u_turns": sum((c, d) == (b, a) for (a, b), (c, d) in zip(edges, edges[1:])),  # an edge driven and immediately driven back
                   "min_stop_score": MIN_STOP_SCORE, "two_way_blocks": TWO_WAY_BLOCKS}
    fastest = drive("travel_time") if safe else edges

    coords, frames, dist = [], [], 0
    for a, b in edges:
        d = graph.best_edge(G, a, b)
        dist += d["length"]
        pts = list(d["geometry"].coords) if "geometry" in d else [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[b]["x"], G.nodes[b]["y"])]
        coords += pts[1:] if coords and coords[-1] == pts[0] else pts
        frames += _frames_on(a, b)

    if to:
        want = config.mood_tags(mood)  # the numbered stops are the best blocks the road passes; None = any
        onpath = [k for k in dict.fromkeys(f["segment"] for f in frames) if k in segs and k not in (o["id"], END)] if photo_src else \
            [k for k in dict.fromkeys(f"p{x}_{y}" for a, b in edges for x, y in ((a, b), (b, a))) if k in segs and k != END and segs[k]["score"] >= MIN_STOP_SCORE]
        ids = [k for k in onpath if want is None or set(want) & set(segs[k]["tags"])] or onpath
        ids.append(END)
    else:
        ids = route[1:-1]  # the loop's stops in driving order; the start is not a stop
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
        if not photo_src:  # popular: the places that earned the score, and a Street View frame of the same street if one exists
            on = (f"{s['u']}_{s['v']}_", f"{s['v']}_{s['u']}_")  # photo pieces are named <u>_<v>_<i>
            stop["frame_idx"] = next((i for i, f in enumerate(frames) if f["segment"].startswith(on)), None)
            stop["photo"] = frames[stop["frame_idx"]]["url"] if stop["frame_idx"] is not None else None
            stop["pois"], stop["why"] = s.get("pois", []), _why_popular(s)
        stops.append(stop)
    sc = safety.score(G, edges, alert=wx["flood"], closures=live)
    hin_driven = _hin_driven(G, edges)
    compare = None
    if sc and safe:
        fast = safety.score(G, fastest, alert=wx["flood"], closures=live)
        fast_min = sum(graph.best_edge(G, a, b)["travel_time"] for a, b in fastest) / 60
        sc["vs_fastest"] = {"minutes": round(total - fast_min, 1), "hin_km": round(sc["hin_km"] - fast["hin_km"], 2),
                            "score": sc["score"] - fast["score"], "arterial_pct": sc["arterial_pct"] - fast["arterial_pct"]}
        try:
            base = build(mood, minutes, start, safe=False, at=at, to=to, rank=rank, source=source)  # the same request with Safer Route off (cached after the first time)
        except ValueError:  # e.g. Safer Route off has fewer ranked loops than this rank: no comparison, but the safe tour stands
            base = None
        if base and (bs := base["summary"].get("safety")):
            sc["vs_default"] = {"minutes": round(total - base["summary"]["drive_minutes"], 1), "hin_km": round(sc["hin_km"] - bs["hin_km"], 2),
                                "score": sc["score"] - bs["score"], "calm_pct": sc["calm_pct"] - bs["calm_pct"], "stops": len(stops) - base["summary"]["stops"]}
        if base:
            mine = {f["properties"]["key"] for f in hin_driven["features"]}
            avoided = [f for f in (base.get("hin_driven") or {"features": []})["features"] if f["properties"]["key"] not in mine]
            compare = {  # for the map: the Safer-OFF tour (its own loop, so some stops may differ) drawn in gray under this one
                "base_id": base["id"], "path": base["path"],
                "avoided_hin": {"type": "FeatureCollection", "features": avoided},  # High Injury Network pieces it drives and this tour doesn't
                "avoided_km": round(sum(f["properties"]["km"] for f in avoided), 2),  # distinct pieces; vs_default.hin_km is the per-trip net
                "avoided_ksi": sum(f["properties"]["ksi"] for f in avoided),  # killed/seriously-injured crash sites on those pieces
                "corridors": sorted({f["properties"]["street"] for f in avoided if f["properties"]["street"]}),
            }
    tour = {
        "id": tid, "mood": mood, "minutes": minutes, "start": start, "safe": safe, "router": ROUTER_VERSION, "source": source,
        "rank": rank, "options": options,  # rank r of `options` ranked loops (1 option for a one-way to a picked destination)
        "origin": {"id": o["id"], "lat": o["lat"], "lng": o["lng"], "street": o["street"],
                   "photo": f"/static/frames/{o['id']}.jpg" if config.has_frame(o["id"]) else None},  # popular starts may have no photo
        "dest_id": END,  # one-way only: the destination stop, where the path ends; None for a loop (the UI keys off this)
        "path": {"type": "LineString", "coordinates": [list(c) for c in coords]},
        "frames": frames, "stops": stops,
        "hin_driven": hin_driven,  # High Injury Network pieces this drive uses (GeoJSON), so a Safer tour can diff against it
        "compare": compare,  # Safer Route on only: {base_id, path, avoided_hin, avoided_km, avoided_ksi, corridors}; None otherwise
        "summary": {"distance_km": round(dist / 1000, 1), "drive_minutes": round(total, 1), "stops": len(stops), "businesses": [],
                    "safety": sc, "weather": {"flood": wx["flood"], "storm": wx["storm"], "alerts": [a["event"] for a in wx["alerts"]]},
                    "spurs": quality},
    }
    store.save(tour, fresh=True)  # a rebuilt tour must not keep the previous build's narration clips (they are keyed by stop position)
    return tour


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # a flaky Places/Wikipedia call shouldn't kill the narration
        print(f"narrate lookup failed: {e}")


_narrate_lock = threading.Lock()  # ponytail: one narration at a time (each read-modify-writes the tour json); per-tour locks if it becomes a bottleneck


def narrate_stop(tid, stop_id, lang):
    """Script + MP3 for this one stop in `lang`, saved on the tour. ElevenLabs is only called if the stop has no audio
    in `lang` yet, so revisiting a spot is free. Returns the stop; KeyError if the tour or stop doesn't exist."""
    with _narrate_lock:
        t = store.get(tid)
        i, s = next((i, s) for i, s in enumerate(t["stops"]) if s["id"] == stop_id)  # StopIteration -> KeyError below
        if lang not in s["audio"]:
            if "place" not in s:
                s["place"], s["wiki"] = _safe(narrate.place_near, s["lat"], s["lng"]), _safe(narrate.wiki_near, s["lat"], s["lng"])
            s["script"][lang] = narrate.script(s, lang)
            f = config.MEDIA / "audio" / f"{tid}-{i}-{lang}.mp3"
            narrate.tts(s["script"][lang], f)
            s["audio"][lang] = f"/static/audio/{f.name}"
            store.save_audio(tid, f"{i}-{lang}", f.read_bytes())  # the MP3 bytes ride along in the Mongo tour document too
            t["summary"]["businesses"] = [x["place"]["name"] for x in t["stops"] if x.get("place")]
            store.save(t)
        return s


def narrate_tour(tid, lang):
    """Every stop in `lang` (bake / the whole-tour language toggle); saved per stop so a polling client sees progress."""
    for s in store.get(tid)["stops"]:
        narrate_stop(tid, s["id"], lang)
