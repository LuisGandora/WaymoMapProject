"""Step 1: cut the streets into ~100 m pieces -> data/points.json (one future Street View frame each).

python -m pipeline.sample [--hood wynwood ...] [--bbox W S E N ...] [--ring] [--limit 500] [--merge]
No --hood/--bbox = the whole service area (grown by AREA_BUFFER_MILES). --merge keeps the points already in points.json,
so sampling one new area does not drop the scored blocks you already have.
"""
import argparse
import json
import math

import osmnx as ox
import shapely
from shapely.geometry import box
from shapely.ops import substring

from app import config, graph


def bearing(a, b):
    (x1, y1), (x2, y2) = a, b
    dx = (x2 - x1) * math.cos(math.radians(y1))
    return round(math.degrees(math.atan2(dx, y2 - y1)) % 360)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hood", nargs="*", choices=list(config.HOODS), default=[])
    ap.add_argument("--bbox", nargs=4, type=float, action="append", default=[], metavar=("W", "S", "E", "N"),
                    help="only this box (lng/lat degrees); repeatable, combines with --hood")
    ap.add_argument("--ring", action="store_true", help="only pieces outside the traced service polygon, i.e. just the area AREA_BUFFER_MILES added")
    ap.add_argument("--merge", action="store_true", help="add to the existing points.json instead of replacing it")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--side", choices=["right", "left", "ahead"], default="right",
                    help="camera direction relative to travel: a rider looks out the side window (default right)")
    args = ap.parse_args()
    offset = {"right": 90, "left": -90, "ahead": 0}[args.side]
    areas = [box(*config.HOODS[h]["bbox"]) for h in args.hood] + [box(*b) for b in args.bbox]

    G, poly = graph.get(), graph.polygon()
    traced = graph.polygon(buffered=False) if args.ring else None
    shapely.prepare(poly)  # thousands of contains() calls against a big polygon
    edges = ox.graph_to_gdfs(G, nodes=False)
    pts = []
    for (u, v, _), e in edges.iterrows():
        if u > v and G.has_edge(v, u):
            continue  # two-way street: sample it once
        if areas and not any(a.intersects(e.geometry) for a in areas):
            continue
        name = e.get("name")
        name = name[0] if isinstance(name, list) else (name if isinstance(name, str) else "")
        n = max(1, round(e["length"] / 100))
        for i in range(n):
            piece = substring(e.geometry, i / n, (i + 1) / n, normalized=True)
            a, b, mid = piece.coords[0], piece.coords[-1], piece.interpolate(0.5, normalized=True)
            if not poly.contains(mid):
                continue  # edge crosses the boundary (truncate_by_edge); keep only pieces truly inside
            if traced is not None and traced.contains(mid):
                continue  # --ring: the traced area is not new
            travel = bearing(a, b)
            pts.append({"id": f"{u}_{v}_{i}", "u": u, "v": v, "i": i, "lat": round(mid.y, 6), "lng": round(mid.x, 6),
                        "heading": (travel + offset) % 360, "travel_heading": travel, "length_m": round(e["length"] / n, 1),
                        "street": name, "line": [[a[0], a[1]], [b[0], b[1]]]})
    pts = pts[: args.limit]
    out = config.DATA / "points.json"
    if args.merge and out.exists():
        seen = {p["id"] for p in pts}
        pts += [p for p in json.loads(out.read_text(encoding="utf-8")) if p["id"] not in seen]
    out.write_text(json.dumps(pts), encoding="utf-8")
    new = sum(not (config.MEDIA / "frames" / f"{p['id']}.jpg").exists() for p in pts)
    print(f"{len(pts)} points -> data/points.json; {new} have no frame yet (at most ${max(0, new - 10000) * 7 / 1000:,.0f} of Street View images after the 10,000 free per month, less where there is no imagery)")


if __name__ == "__main__":
    main()
