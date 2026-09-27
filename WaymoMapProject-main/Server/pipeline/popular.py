"""The "popular online" scenery source: rank every street by the places people map and look up online. No photos needed.

    python -m pipeline.popular        # a few minutes; free (Overpass, Wikidata, Wikimedia pageviews), no keys

Reads the street graph and the OpenStreetMap places inside the service area (attractions, museums, galleries, murals and
street art, monuments, theatres, parks, marinas, beaches, the waterfront, restaurants and cafes). A place with a
Wikipedia article counts more the more people read it (average monthly page views over the last 12 months). Each street
piece of at least MIN_LEN_M scores 1-10 from the places within PLACE_M of it, with mood tags from their kinds.

Writes, in the same shapes as the photo pipeline so the router can use either source:
    data/popular/segments.json          scored street pieces (only pieces with something nearby)
    data/popular/matrix_<mood>.json     drive minutes between each mood's candidates (top ones near every start, plus citywide)
    data/popular/pois.json              the places used, with their weight and page views (credits, map, narration facts)
"""
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import httpx
import networkx as nx
import osmnx as ox
import pyproj
from shapely.geometry import LineString
from shapely.ops import transform
from shapely.strtree import STRtree

from app import config, graph, router
from app.tour import MIN_STOP_SCORE

OUT = config.DATA / "popular"
PLACE_M = 60      # a place counts for a street if it is this close to it
WATER_M = 80      # a street this close to open water is "waterfront"
MIN_LEN_M = 40    # shorter pieces are intersections, not blocks worth stopping on
CUTOFF_S = 1500   # matrix: drive times beyond 25 min are never needed by a loop (tour.build's radius is 2.2 km at 30 min)
MONTHS = ("2025090100", "2026083100")  # page views averaged over these 12 full months
UA = {"User-Agent": "WaymoHaven/0.1 (https://github.com/LuisGandora/WaymoMapProject) python-httpx/0.28"}  # Wikimedia requires a contact URL

# How much one place adds to a street's raw popularity before its Wikipedia boost. These are the knobs.
W = {
    "attraction": 4, "museum": 4, "zoo": 4, "aquarium": 4, "viewpoint": 3, "beach": 3,
    "street_art": 3,  # murals, street art, graffiti
    "gallery": 2.5, "historic": 2.5, "theatre": 2, "arts_centre": 2, "marina": 2, "water": 2,
    "artwork": 1.5,   # sculptures, statues, installations
    "park": 1.5, "garden": 1.5,
    "restaurant": 0.6, "cafe": 0.6, "ice_cream": 0.5, "bar": 0.3,
}
FOOD = {"restaurant", "cafe", "ice_cream", "bar"}
FOOD_CAP = 3  # a row of restaurants must not outrank a museum
TAG_OF = {"street_art": "mural", "gallery": "mural", "historic": "historic", "marina": "waterfront", "beach": "waterfront",
          "water": "waterfront", "park": "greenery", "garden": "greenery", **{k: "food" for k in FOOD}}
OSM_TAGS = {"tourism": ["attraction", "museum", "zoo", "aquarium", "viewpoint", "gallery", "artwork"], "historic": True,
            "amenity": ["theatre", "arts_centre", "restaurant", "cafe", "ice_cream", "bar"], "leisure": ["park", "garden", "marina"],
            "natural": ["beach"], "building:architecture": ["art_deco"]}
WATER_TAGS = {"natural": ["water", "coastline", "bay"], "waterway": ["river", "canal", "riverbank"]}


def kind(r):
    """One place kind per OSM feature (the first that applies), or None for things that aren't sights (hotels, info boards)."""
    g = lambda k: r.get(k) if isinstance(r.get(k), str) else None
    if g("tourism") == "artwork":
        return "street_art" if g("artwork_type") in ("mural", "street_art", "graffiti") else "artwork"
    if g("tourism") in W:
        return g("tourism")
    if g("historic"):
        return "historic"
    if g("building:architecture") == "art_deco":
        return "art_deco"
    for k in ("amenity", "leisure", "natural"):
        if g(k) in W:
            return g(k)
    return None


def page_views(pois):
    """Average monthly English Wikipedia page views for every place with a wikidata/wikipedia tag (0 if unknown)."""
    qids = sorted({p["wikidata"] for p in pois if p.get("wikidata")})
    title = {}
    with httpx.Client(headers=UA, timeout=20) as c:
        for i in range(0, len(qids), 50):
            r = c.get("https://www.wikidata.org/w/api.php", params={"action": "wbgetentities", "ids": "|".join(qids[i:i + 50]),
                                                                  "props": "sitelinks", "sitefilter": "enwiki", "format": "json"})
            for q, e in r.json().get("entities", {}).items():
                if t := e.get("sitelinks", {}).get("enwiki", {}).get("title"):
                    title[q] = t
        for p in pois:  # a bare wikipedia=en:Title tag works too
            w = p.get("wikipedia") or ""
            if not title.get(p.get("wikidata")) and w.startswith("en:"):
                title[p.get("wikidata") or w] = w[3:]

        def views(t):
            url = (f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/"
                   f"{quote(t.replace(' ', '_'), safe='')}/monthly/{MONTHS[0]}/{MONTHS[1]}")
            try:
                items = c.get(url).json().get("items", [])
                return sum(x["views"] for x in items) / max(1, len(items))
            except Exception:
                return 0

        with ThreadPoolExecutor(8) as ex:
            got = dict(zip(title, ex.map(views, title.values())))
    for p in pois:
        p["views"] = round(got.get(p.get("wikidata")) or got.get(p.get("wikipedia") or "") or 0)
    return pois


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    G, poly = graph.get(), graph.polygon()
    to_m = pyproj.Transformer.from_crs(4326, 32617, always_xy=True).transform  # UTM 17N: metres around Miami

    feats = ox.features_from_polygon(poly, OSM_TAGS)
    pois = []
    for _, r in feats.iterrows():
        k = kind(r)
        if not k or k == "art_deco" and not isinstance(r.get("name"), str):
            continue
        c = r.geometry.representative_point()
        pois.append({"name": r["name"] if isinstance(r.get("name"), str) else None, "kind": k, "lat": round(c.y, 6), "lng": round(c.x, 6),
                     "wikidata": r.get("wikidata") if isinstance(r.get("wikidata"), str) else None,
                     "wikipedia": r.get("wikipedia") if isinstance(r.get("wikipedia"), str) else None, "_geom": transform(to_m, r.geometry)})
    try:
        pois = page_views(pois)
    except Exception as e:  # Wikimedia down or refusing: places still count, just without the page-view boost
        print(f"page views skipped: {e}")
        for p in pois:
            p["views"] = 0
    for p in pois:  # a well-read Wikipedia article can triple a place's weight (1 + up to 2)
        base = W.get(p["kind"], 2.5 if p["kind"] == "art_deco" else 0)
        p["weight"] = round(base * (1 + min(2.0, math.log10(1 + p["views"] / 50))) if p["views"] else base * (1.3 if p["wikidata"] else 1), 2)
    print(f"{len(pois)} places ({sum(1 for p in pois if p['views'])} with Wikipedia page views) in {time.time() - t0:.0f}s")

    water = [transform(to_m, g) for g in ox.features_from_polygon(poly.buffer(0.003), WATER_TAGS).geometry]
    ptree, wtree = STRtree([p["_geom"] for p in pois]), STRtree(water)

    segs, seen = [], set()
    for u, v, d in G.edges(data=True):
        if (v, u) in seen or (u, v) in seen or d.get("length", 0) < MIN_LEN_M:
            continue
        seen.add((u, v))
        line = d["geometry"] if "geometry" in d else LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
        lm = transform(to_m, line)
        near = [pois[i] for i in ptree.query(lm, predicate="dwithin", distance=PLACE_M)]
        wet = len(wtree.query(lm, predicate="dwithin", distance=WATER_M)) > 0
        if not near and not wet:
            continue
        food = min(FOOD_CAP, sum(p["weight"] for p in near if p["kind"] in FOOD))
        raw = food + sum(p["weight"] for p in near if p["kind"] not in FOOD) + (W["water"] if wet else 0)
        tags = sorted({TAG_OF[p["kind"]] for p in near if p["kind"] in TAG_OF} | ({"art_deco"} if any(p["kind"] == "art_deco" for p in near) else set())
                      | ({"waterfront"} if wet else set()))
        top = sorted((p for p in near if p["name"]), key=lambda p: -p["weight"])[:3]
        mid = line.interpolate(0.5, normalized=True)
        name = d.get("name") or ""
        segs.append({"id": f"p{u}_{v}", "u": u, "v": v, "i": 0, "lat": round(mid.y, 6), "lng": round(mid.x, 6),
                     "line": [[round(x, 6), round(y, 6)] for x, y in line.coords], "street": name[0] if isinstance(name, list) else name,
                     "score": round(1 + 9 * (1 - math.exp(-raw / 4)), 1), "tags": tags, "length_m": round(d["length"]),
                     "pois": [{"name": p["name"], "kind": p["kind"], "views": p["views"]} for p in top]})
    (OUT / "segments.json").write_text(json.dumps(segs), encoding="utf-8")
    (OUT / "pois.json").write_text(json.dumps([{k: v for k, v in p.items() if k != "_geom"} for p in pois], ensure_ascii=False), encoding="utf-8")
    print(f"{len(segs)} scored street pieces, {sum(s['score'] >= MIN_STOP_SCORE for s in segs)} worth stopping at ({time.time() - t0:.0f}s)")

    stops = [s for s in segs if s["score"] >= MIN_STOP_SCORE]
    for mood in config.MATRIX_MOODS:
        tags = config.mood_tags(mood)
        pool = [s for s in stops if tags is None or set(tags) & set(s["tags"])]
        cands = {s["id"]: s for s in router.top_candidates(pool, tags, n=60, sep_m=250)}  # citywide best
        for h in config.HOODS.values():  # plus each start's own best, so every neighborhood can fill a loop
            w, s_, e, n = h["bbox"]
            box = [s for s in pool if w - 0.006 <= s["lng"] <= e + 0.006 and s_ - 0.005 <= s["lat"] <= n + 0.005]
            cands.update({s["id"]: s for s in router.top_candidates(box, tags, n=40, sep_m=200)})
        f = OUT / f"matrix_{mood}.json"
        if not cands:
            f.unlink(missing_ok=True)
            print(f"{mood}: no candidates, skipped")
            continue
        nodes = {k: {"enter": s["u"], "exit": s["v"], "traverse": graph.best_edge(G, s["u"], s["v"])["travel_time"] / 60} for k, s in cands.items()}
        dist = {x: nx.single_source_dijkstra_path_length(G, x, cutoff=CUTOFF_S, weight="travel_time") for x in {n["exit"] for n in nodes.values()}}
        minutes = {a: {b: round(dist[na["exit"]][nb["enter"]] / 60 + nb["traverse"], 2) for b, nb in nodes.items() if nb["enter"] in dist[na["exit"]]}
                   for a, na in nodes.items()}  # sparse: pairs more than CUTOFF_S apart are left out (the router treats them as unreachable)
        f.write_text(json.dumps({"nodes": nodes, "minutes": minutes}), encoding="utf-8")
        print(f"{mood}: {len(cands)} candidates")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
