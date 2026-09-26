"""Step 7: road-safety layer -> data/safety.json (per street edge) + data/safety/*.geojson (raw hazards for the map).

python -m pipeline.safety            # downloads the three public GIS layers (no key needed), then computes
python -m pipeline.safety --skip-download   # recompute from the geojson already in data/safety/
python -m pipeline.safety --fake     # invents hazards so the API/frontend can be built offline. NOT for the demo.

Sources (Miami-Dade County, public ArcGIS layers):
  hin    Vision Zero High Injury Network: corridors with the most fatal + serious-injury crashes (2018-2022)
  ksi    KSI crashes 2019-2023: every killed / seriously-injured crash as a point (Signal4 data)
  flood  FEMA flood zones: only the special flood hazard areas (zones A*/V*)
Road design (lanes, speed limit, road class) comes from the OSM graph itself: no download.

What "safety" means here is ROAD safety: crash history, road design, flooding. Deliberately not crime data:
routing tourists around neighborhoods by crime stats is redlining, contradicts the whole point of the tour,
and says nothing about the risk to a passenger inside a locked robotaxi.
"""
import argparse
import json
import random
import re

import httpx
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree

from app import config, graph

OUT_DIR = config.DATA / "safety"
OUT = config.DATA / "safety.json"

ARCGIS = "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services"
SOURCES = {
    "hin": (f"{ARCGIS}/High_Injury_Network/FeatureServer/0", "1=1"),
    "ksi": (f"{ARCGIS}/KSI_Crash_Events_Public/FeatureServer/0", "1=1"),
    "flood": (f"{ARCGIS}/FEMAFloodZone_gdb/FeatureServer/0", "FZONE LIKE 'A%' OR FZONE LIKE 'V%'"),
}
# Fields worth keeping per layer (the rest is dropped to keep the geojson small).
KEEP = {
    "hin": ["CorrName", "Classi", "KSIRank", "FatalCrash", "SerInjCra", "EffecperMi", "Municipal"],
    "ksi": ["CRASH_YEAR", "S4_CRASH_SEVERITY", "S4_DAY_OR_NIGHT", "S4_IS_PEDESTRIAN_INVOLVED", "S4_IS_BICYCLIST_INVOLVED",
            "S4_IS_SPEEDING_RELATED", "S4_FATALITY_COUNT", "S4_INCAPACITATING_INJURY_COUNT", "CITY_NAME"],
    "flood": ["FZONE", "ZONESUBTY", "ELEV"],
}

KSI_NEAR_M = 25     # a crash within this distance of a street piece counts against it
HIN_NEAR_M = 20     # a street piece this close to a High Injury Network corridor is "on" it
TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform  # UTM 17N: metres in Miami


def fetch(layer, where, bbox):
    """Every feature of an ArcGIS layer inside bbox (minLng, minLat, maxLng, maxLat), paged; GeoJSON in WGS84."""
    feats, offset, seen = [], 0, set()
    while True:
        r = httpx.get(f"{layer}/query", timeout=120, params={
            "where": where, "geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "outSR": 4326, "f": "geojson",
            "resultOffset": offset, "resultRecordCount": 2000})
        r.raise_for_status()
        gj = r.json()
        if "error" in gj:
            raise RuntimeError(f"{layer}: {gj['error']}")
        got = gj.get("features", [])
        ids = {f.get("id") or f["properties"].get("OBJECTID") for f in got}
        if not got or ids <= seen:  # empty page, or the server ignored the offset
            break
        seen |= ids
        feats += got
        offset += len(got)
        print(f"  {layer.rsplit('/', 2)[-2]}: {len(feats)} features")
    return {"type": "FeatureCollection", "features": feats}


def download(bbox):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, (layer, where) in SOURCES.items():
        gj = fetch(layer, where, bbox)
        for f in gj["features"]:
            f["properties"] = {k: f["properties"].get(k) for k in KEEP[name]}
        (OUT_DIR / f"{name}.geojson").write_text(json.dumps(gj), encoding="utf-8")


def fake(G, bbox):
    """Synthetic hazards for offline development: 12 random streets become 'HIN corridors', 300 crashes land near
    random streets, one flood polygon covers the south-west quarter. Loud on purpose."""
    print("!!! --fake: inventing hazards. Run without --fake before the demo. !!!")
    rng = random.Random(7)
    edges = list(G.edges(keys=True, data=True))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    hin = [{"type": "Feature", "geometry": json.loads(json.dumps(_geom(G, u, v, d).__geo_interface__)),
            "properties": {"CorrName": d.get("name") if isinstance(d.get("name"), str) else "FAKE CORRIDOR", "Classi": "FAKE",
                           "KSIRank": i, "FatalCrash": rng.randint(1, 5), "SerInjCra": rng.randint(5, 30), "EffecperMi": rng.uniform(5, 40), "Municipal": "FAKE"}}
           for i, (u, v, k, d) in enumerate(rng.sample(edges, 12), 1)]
    ksi = []
    for u, v, k, d in rng.sample(edges, 300):
        p = _geom(G, u, v, d).interpolate(rng.random(), normalized=True)
        ksi.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [p.x + rng.uniform(-1e-4, 1e-4), p.y + rng.uniform(-1e-4, 1e-4)]},
                    "properties": {"CRASH_YEAR": rng.randint(2019, 2023), "S4_CRASH_SEVERITY": "Incapacitating Injury", "S4_DAY_OR_NIGHT": rng.choice(["Day", "Night"]),
                                   "S4_IS_PEDESTRIAN_INVOLVED": rng.choice(["Y", "N"]), "S4_IS_BICYCLIST_INVOLVED": "N", "S4_IS_SPEEDING_RELATED": "N",
                                   "S4_FATALITY_COUNT": 0, "S4_INCAPACITATING_INJURY_COUNT": 1, "CITY_NAME": "FAKE"}})
    x0, y0, x1, y1 = bbox
    flood = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x0, (y0 + y1) / 2], [x0, y0]]]},
              "properties": {"FZONE": "AE", "ZONESUBTY": "FAKE", "ELEV": 7}}]
    for name, feats in (("hin", hin), ("ksi", ksi), ("flood", flood)):
        (OUT_DIR / f"{name}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")


def ksi_layer():
    """data/safety/ksi_map.geojson: every KSI crash as a bare point with year / pedestrian / fatal flags, for the map."""
    gj = json.loads((OUT_DIR / "ksi.geojson").read_text(encoding="utf-8"))
    feats = [{"type": "Feature", "geometry": f["geometry"], "properties": {
        "year": f["properties"].get("CRASH_YEAR"),
        "ped": int(str(f["properties"].get("S4_IS_PEDESTRIAN_INVOLVED", "")).upper().startswith("Y")),
        "fatal": int((f["properties"].get("S4_FATALITY_COUNT") or 0) > 0)}} for f in gj["features"] if f["geometry"]]
    (OUT_DIR / "ksi_map.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
    print(f"  ksi_map.geojson: {len(feats)} crashes, {(OUT_DIR / 'ksi_map.geojson').stat().st_size // 1024} KB")


def map_layer():
    """data/safety/flood_map.geojson: flood polygons clipped to the service area and simplified to ~10 m, for the map.
    The raw FEMA file is tens of MB (survey-grade outlines); this one is a few hundred KB."""
    from shapely.geometry import mapping
    from shapely.ops import unary_union
    from pyproj import Transformer
    to_deg = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform
    poly_m = transform(TO_M, graph.polygon()).buffer(300)  # a little past the boundary so edges near it still show
    gj = json.loads((OUT_DIR / "flood.geojson").read_text(encoding="utf-8"))
    by_zone = {}
    for f in gj["features"]:
        if not f["geometry"]:
            continue
        g = transform(TO_M, shape(f["geometry"])).intersection(poly_m)
        if not g.is_empty:
            by_zone.setdefault(f["properties"].get("FZONE") or "A", []).append(g)
    feats = []
    for zone, gs in by_zone.items():
        g = unary_union(gs).simplify(10, preserve_topology=True)
        parts = list(g.geoms) if hasattr(g, "geoms") else [g]
        for part in parts:
            if part.area >= 2000:  # drop slivers under ~0.2 ha
                feats.append({"type": "Feature", "geometry": mapping(transform(to_deg, part)), "properties": {"FZONE": zone}})
    out = {"type": "FeatureCollection", "features": feats}
    (OUT_DIR / "flood_map.geojson").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"  flood_map.geojson: {len(feats)} polygons, {(OUT_DIR / 'flood_map.geojson').stat().st_size // 1024} KB")


def _geom(G, u, v, d):
    return d["geometry"] if "geometry" in d else LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])


def _first(x):
    return x[0] if isinstance(x, list) else x


def road_design(d):
    """(mph, lanes, calm, arterial) from OSM tags; Miami defaults when a tag is missing."""
    cls = _first(d.get("highway")) or "residential"
    m = re.search(r"\d+", str(_first(d.get("maxspeed")) or ""))
    mph = int(m.group()) if m else {"primary": 40, "primary_link": 35, "secondary": 35, "secondary_link": 30, "tertiary": 30}.get(cls, 25)
    if m and "km" in str(_first(d.get("maxspeed"))):
        mph = round(mph / 1.609)
    l = re.search(r"\d+", str(_first(d.get("lanes")) or ""))
    lanes = int(l.group()) if l else {"primary": 4, "secondary": 4, "tertiary": 2}.get(cls, 2)
    calm = cls in ("residential", "living_street") or (cls.startswith("tertiary") and lanes <= 2 and mph <= 30)
    arterial = cls.startswith(("primary", "secondary")) and (lanes >= 4 or mph >= 40)
    return mph, lanes, int(calm), int(arterial)


def compute(G):
    gj = {n: json.loads((OUT_DIR / f"{n}.geojson").read_text(encoding="utf-8")) for n in SOURCES}
    hin_lines = [(transform(TO_M, shape(f["geometry"])), f["properties"]) for f in gj["hin"]["features"] if f["geometry"]]
    ksi_pts = [transform(TO_M, shape(f["geometry"])) for f in gj["ksi"]["features"] if f["geometry"]]
    flood_polys = [transform(TO_M, shape(f["geometry"])) for f in gj["flood"]["features"] if f["geometry"]]
    hin_tree, flood_tree = STRtree([g for g, _ in hin_lines]), STRtree(flood_polys)

    # One record per undirected street piece; both driving directions share it.
    keys, geoms_m, recs = [], [], {}
    for u, v, k, d in G.edges(keys=True, data=True):
        if (v, u, k) in recs:
            recs[(u, v, k)] = recs[(v, u, k)]
            continue
        g = transform(TO_M, _geom(G, u, v, d))
        mph, lanes, calm, arterial = road_design(d)
        rec = {"ksi": 0, "ped": 0, "hin": 0, "hin_rate": 0.0, "mph": mph, "lanes": lanes, "calm": calm, "arterial": arterial, "flood": 0}
        # "On" a corridor = at least half the piece runs within HIN_NEAR_M of it. (Plain distance would also flag every
        # side street that merely touches a corridor at an intersection, which is most of the grid.)
        hits = [i for i in hin_tree.query(g.buffer(HIN_NEAR_M))
                if g.intersection(hin_lines[i][0].buffer(HIN_NEAR_M)).length >= 0.5 * g.length]
        if hits:
            rec["hin"], rec["hin_rate"] = 1, round(max(float(hin_lines[i][1].get("EffecperMi") or 0) for i in hits), 1)
        mid = g.interpolate(0.5, normalized=True)
        rec["flood"] = int(any(flood_polys[i].contains(mid) for i in flood_tree.query(mid)))
        recs[(u, v, k)] = rec
        keys.append((u, v, k))
        geoms_m.append(g)

    tree = STRtree(geoms_m)
    for p, f in zip(ksi_pts, (f for f in gj["ksi"]["features"] if f["geometry"])):
        near = [(geoms_m[i].distance(p), i) for i in tree.query(p.buffer(KSI_NEAR_M))]
        near = [x for x in near if x[0] <= KSI_NEAR_M]
        if near:
            rec = recs[keys[min(near)[1]]]
            rec["ksi"] += 1
            rec["ped"] += int(str(f["properties"].get("S4_IS_PEDESTRIAN_INVOLVED", "")).upper().startswith("Y"))

    edges = {f"{u},{v},{k}": r for (u, v, k), r in recs.items()}
    n = len(geoms_m)
    total_km = sum(g.length for g in geoms_m) / 1000
    matched = sum(r["ksi"] for r in {id(r): r for r in recs.values()}.values())  # each shared record once
    meta = {"edges": n, "hin_edges": sum(r["hin"] for r in recs.values()) // 2, "ksi_points": len(ksi_pts),
            "ksi_matched": matched, "total_km": round(total_km, 1),
            "ksi_per_km_avg": round(matched / total_km, 3),  # the area's average street; tour scores are relative to it
            "flood_edges": sum(r["flood"] for r in recs.values()) // 2,
            "arterial_edges": sum(r["arterial"] for r in recs.values()) // 2, "calm_edges": sum(r["calm"] for r in recs.values()) // 2,
            "sources": {k: v[0] for k, v in SOURCES.items()}, "fake": (OUT_DIR / "FAKE").exists()}
    OUT.write_text(json.dumps({"meta": meta, "edges": edges}), encoding="utf-8")
    print(json.dumps(meta, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-download", action="store_true", help="reuse data/safety/*.geojson")
    ap.add_argument("--fake", action="store_true", help="invent hazards (offline dev only)")
    ap.add_argument("--remap", action="store_true", help="rebuild data/safety/flood_map.geojson even if it exists (slow: ~1-2 min)")
    a = ap.parse_args()
    G = graph.get()
    x0, y0, x1, y1 = graph.polygon().bounds
    bbox = (x0 - 0.01, y0 - 0.01, x1 + 0.01, y1 + 0.01)
    if a.fake:
        fake(G, bbox)
        (OUT_DIR / "FAKE").write_text("hazards in this folder are synthetic; rerun `python -m pipeline.safety`")
    elif not a.skip_download:
        download(bbox)
        (OUT_DIR / "FAKE").unlink(missing_ok=True)
    compute(G)
    ksi_layer()
    if a.remap or a.fake or not (OUT_DIR / "flood_map.geojson").exists():
        map_layer()
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
