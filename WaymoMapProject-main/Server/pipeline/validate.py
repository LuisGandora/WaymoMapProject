"""Import checklist: python -m pipeline.validate  (run after pipeline.sample; exits non-zero on any failure)."""
import json
import statistics
import sys

import networkx as nx
from shapely.geometry import Point

from app import config, graph

BAD = {"motorway", "motorway_link", "trunk", "trunk_link"}


def main():
    poly, G = graph.polygon(), graph.get()
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    area, c = graph.area_sq_miles(poly), poly.centroid
    padded = poly.buffer(0.0002)  # ~20 m: truncate_by_edge keeps edges that cross the boundary
    tags = lambda d: d["highway"] if isinstance(d["highway"], list) else [d["highway"]]
    lengths = [p["length_m"] for p in pts]

    checks = {
        f"polygon valid, area {area:.0f} sq mi (want 50-70)": poly.is_valid and 50 <= area <= 70,
        f"centroid ({c.y:.3f}, {c.x:.3f}) is in Miami": abs(c.y - 25.77) < 0.1 and abs(c.x + 80.22) < 0.1,
        "no motorway/trunk edges": not any(BAD & set(tags(d)) for *_, d in G.edges(data=True)),
        "graph strongly connected": nx.is_strongly_connected(G),
        "every edge travel_time > 0": all(d["travel_time"] > 0 for *_, d in G.edges(data=True)),
        "every sample point inside polygon (+20 m)": all(padded.contains(Point(p["lng"], p["lat"])) for p in pts),
        f"{len(pts)} segments, median {statistics.median(lengths):.0f} m (want ~100)":
            bool(pts) and 80 <= statistics.median(lengths) <= 120,
    }
    for name, ok in checks.items():
        print("PASS" if ok else "FAIL", name)
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
