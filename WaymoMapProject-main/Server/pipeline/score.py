"""Step 3: Gemini rates every frame -> data/frames.json (resumable; the only place Gemini sees images).

python -m pipeline.score [--fake] [--workers N] [--pause S]
--fake skips Gemini and invents deterministic scores, so the router/API/frontend can be built before keys exist.

Speed/cost notes: Flash models "think" before answering by default, which makes a one-line photo rating take
several seconds and bills the thinking as output tokens. We turn thinking off (falls back to the model's default
if it refuses), cap each call at 60 s so a hung request can't stall a worker, and save every 25 frames so Ctrl+C
or a crash loses almost nothing: rerunning picks up where it stopped.
"""
import argparse
import json
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel

from app import config

OUT = config.DATA / "frames.json"
PROMPT = ("Rate this street view 1-10 as something a tourist would want to see out a car window. "
          f"Tag what is here using only these tags: {', '.join(config.TAGS)}.")
THINK_OFF = [True]  # flipped to False if the model rejects a thinking budget of 0


class Rating(BaseModel):
    score: int
    tags: list[str]


def rate(client, p):
    from google.genai import types

    img = (config.MEDIA / "frames" / f"{p['id']}.jpg").read_bytes()
    while True:
        cfg = dict(response_mime_type="application/json", response_schema=Rating)
        if THINK_OFF[0]:
            cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        try:
            r = client.models.generate_content(
                model=config.GEMINI_MODEL,
                contents=[types.Part.from_bytes(data=img, mime_type="image/jpeg"), PROMPT],
                config=types.GenerateContentConfig(**cfg),
            )
        except Exception as e:
            if THINK_OFF[0] and "thinking" in str(e).lower():  # this model insists on thinking: use its default
                THINK_OFF[0] = False
                print("model rejected thinking_budget=0, continuing with its default thinking")
                continue
            raise
        if r.parsed is None:
            raise ValueError(f"unparsable answer: {str(r.text)[:80]}")
        return r.parsed


def fake(p):
    rng = random.Random(p["id"])
    return Rating(score=rng.randint(1, 10), tags=rng.sample(config.TAGS[:-1], rng.randint(0, 2)))


def one(client, p, use_fake, pause=0.0):
    r = fake(p) if use_fake else rate(client, p)
    if pause:
        import time
        time.sleep(pause)
    return {"id": p["id"], "segment": p["id"], "score": max(1, min(10, r.score)), "tags": [t for t in r.tags if t in config.TAGS]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--workers", type=int, default=8, help="parallel Gemini calls (paid key: 8 is fine; free tier: 1)")
    ap.add_argument("--pause", type=float, default=0.0, help="seconds to wait after each call per worker (free tier: ~4 keeps under 15 req/min)")
    args = ap.parse_args()
    fake_mode = args.fake
    client = None
    if not fake_mode:
        assert config.GEMINI_KEY, "set GEMINI_API_KEY in Server/.env (or use --fake)"
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=config.GEMINI_KEY, http_options=types.HttpOptions(timeout=60_000))  # ms
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    done = {}
    if OUT.exists():
        try:
            done = {f["id"]: f for f in json.loads(OUT.read_text(encoding="utf-8"))}
        except ValueError:  # a run killed mid-write: start over rather than crash (it's cheap)
            print("frames.json was unreadable (killed mid-save?), starting fresh")
    todo = [p for p in pts if p["id"] not in done and (fake_mode or (config.MEDIA / "frames" / f"{p['id']}.jpg").exists())]
    print(f"{len(done)} already scored, {len(todo)} to go, {args.workers} workers, model {config.GEMINI_MODEL}")

    def save():
        OUT.write_text(json.dumps(list(done.values())), encoding="utf-8")

    fails = 0
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(one, client, p, fake_mode, args.pause): p for p in todo}
        try:
            for n, f in enumerate(as_completed(futs), 1):
                try:
                    r = f.result()
                    done[r["id"]] = r
                    fails = 0
                except Exception as e:  # rate limit etc.: skip, rerun resumes
                    fails += 1
                    print(f"skip {futs[f]['id']}: {str(e)[:160]}")
                    if fails >= 8:  # every call is failing (no credits, bad key, retired model): stop instead of burning 600 errors
                        print("8 failures in a row: stopping. Fix the key/credits/model and rerun; finished frames are saved.")
                        break
                if n % 25 == 0:
                    save()
                    print(f"  {len(done)} scored so far")
        except KeyboardInterrupt:
            print("\nCtrl+C: finishing the calls in flight and saving; rerun to resume.")
        finally:
            for g in futs:  # cancel everything still queued so shutdown only waits for the in-flight calls
                g.cancel()
            save()
    save()
    print(f"{len(done)} scored frames -> data/frames.json")


if __name__ == "__main__":
    main()
