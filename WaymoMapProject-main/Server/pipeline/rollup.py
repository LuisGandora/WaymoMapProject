"""Step 4: average frames into per-piece segments -> data/segments.json (what the router and map read).

python -m pipeline.rollup
"""
import json
from collections import defaultdict

from app import config


def main():
    pts = {p["id"]: p for p in json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))}
    by_seg = defaultdict(list)
    for f in json.loads((config.DATA / "frames.json").read_text(encoding="utf-8")):
        by_seg[f["segment"]].append(f)
    segs = []
    for sid, fs in by_seg.items():
        p = pts[sid]
        best = max(fs, key=lambda f: f["score"])
        seg = {**{k: p[k] for k in ("id", "u", "v", "i", "lat", "lng", "street", "line")},
               "score": round(sum(f["score"] for f in fs) / len(fs), 1),
               "tags": sorted({t for f in fs for t in f["tags"]} - {"nothing"})}
        if best.get("place"):
            seg["place"] = best["place"]
        if best.get("check"):
            seg["check"] = best["check"]
        segs.append(seg)
    (config.DATA / "segments.json").write_text(json.dumps(segs), encoding="utf-8")
    print(f"{len(segs)} segments -> data/segments.json")


if __name__ == "__main__":
    main()
