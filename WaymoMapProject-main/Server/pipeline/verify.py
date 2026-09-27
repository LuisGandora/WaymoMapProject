"""Verify AI scenic scores against Google Places ratings (Glimmer identify + text search).

python -m pipeline.verify [--min-score 7] [--limit N] [--force]
Resumable: skips frames that already have verify_status unless --force.
Does not change AI score. Sets review_score (-1 if no data), verify_status, subject, rating_ref.

Needs GOOGLE_MAPS_API_KEY; LLM_API_KEY + LLM_BASE_URL for Glimmer (same LiteLLM gateway as gpt-oss-120b).
"""
import argparse
import json
from collections import Counter

from app import config, verify_frame

OUT = config.DATA / "frames.json"


def run(*, min_score=0, limit=None, force=False):
    assert config.GOOGLE_KEY, "set GOOGLE_MAPS_API_KEY in Server/.env"

    pts = {p["id"]: p for p in json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))}
    frames = json.loads(OUT.read_text(encoding="utf-8"))
    by_id = {f["id"]: f for f in frames}

    todo = []
    for f in frames:
        if f.get("score", 0) < min_score:
            continue
        if not force and f.get("verify_status"):
            continue
        todo.append(f)
    if limit:
        todo = todo[:limit]

    def save():
        OUT.write_text(json.dumps(list(by_id.values())), encoding="utf-8")

    counts = Counter()
    for n, f in enumerate(todo, 1):
        if n % 25 == 0:
            save()
        p = pts.get(f["id"]) or pts.get(f.get("segment"))
        if not p:
            print(f"skip {f['id']}: no point")
            continue
        try:
            patch = verify_frame.verify_frame(f, p)
            by_id[f["id"]].update(patch)
            st = patch["verify_status"]
            counts[st] += 1
            rs = patch["review_score"]
            name = (patch.get("rating_ref") or {}).get("name", "—")
            print(f"{st:18} {f['id']}  ai={f['score']}  review={rs}  {name}")
        except Exception as e:
            counts["error"] += 1
            print(f"error {f['id']}: {str(e)[:160]}")

    save()
    print(f"done {len(todo)} frames -> data/frames.json  {dict(counts)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-score", type=int, default=0, help="only verify frames at or above this AI score")
    ap.add_argument("--limit", type=int, help="max frames to process this run")
    ap.add_argument("--force", action="store_true", help="re-verify frames that already have verify_status")
    args = ap.parse_args()
    run(min_score=args.min_score, limit=args.limit, force=args.force)


if __name__ == "__main__":
    main()
