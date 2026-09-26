"""Places check on high LLM scores. Updates data/frames.json; does not change score.

python -m pipeline.check [--min-score 7] [--limit N]
Reuse app.narrate.place_near. agree = a 4★+ place within 150 m; flag = none (look at the photo).
Resumable: frames that already have a `check` field are skipped.
"""
import argparse
import json

from app import config, narrate

OUT = config.DATA / "frames.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-score", type=int, default=7)
    ap.add_argument("--limit", type=int, help="check at most this many new high-score frames")
    args = ap.parse_args()
    assert config.GOOGLE_KEY, "set GOOGLE_MAPS_API_KEY in Server/.env"

    pts = {p["id"]: p for p in json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))}
    frames = json.loads(OUT.read_text(encoding="utf-8"))
    todo = [f for f in frames if f.get("score", 0) >= args.min_score and "check" not in f]
    if args.limit:
        todo = todo[: args.limit]

    agree = flag = 0
    by_id = {f["id"]: f for f in frames}
    for f in todo:
        p = pts.get(f["id"]) or pts.get(f["segment"])
        if not p:
            continue
        try:
            place = narrate.place_near(p["lat"], p["lng"])
        except Exception as e:
            print(f"skip {f['id']}: {e}")
            continue
        row = by_id[f["id"]]
        row["place"] = place
        row["check"] = "agree" if place else "flag"  # score stays the LLM's
        if place:
            agree += 1
            print(f"agree {f['id']}  {f['score']}/10  {place['name']} ({place['rating']}★)")
        else:
            flag += 1
            print(f"flag  {f['id']}  {f['score']}/10  no 4★+ place within 150 m")

    OUT.write_text(json.dumps(list(by_id.values())), encoding="utf-8")
    print(f"{agree} agree, {flag} flag, {len(todo)} checked -> data/frames.json")


if __name__ == "__main__":
    main()
