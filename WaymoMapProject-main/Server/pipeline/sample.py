"""Step 1: cut the streets into ~100 m pieces -> data/points.json (one future Street View frame each).

python -m pipeline.sample [--hood wynwood ...] [--limit 500]   (no --hood = whole service area)
"""
import argparse
import json
import math

import osmnx as ox
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
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    areas = [box(*config.HOODS[h]["bbox"]) for h in args.hood]

    G = graph.get()
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
            pts.append({"id": f"{u}_{v}_{i}", "u": u, "v": v, "i": i, "lat": round(mid.y, 6), "lng": round(mid.x, 6),
                        "heading": bearing(a, b), "street": name, "line": [[a[0], a[1]], [b[0], b[1]]]})
    pts = pts[: args.limit]
    (config.DATA / "points.json").write_text(json.dumps(pts), encoding="utf-8")
    print(f"{len(pts)} points -> data/points.json")


if __name__ == "__main__":
    main()
