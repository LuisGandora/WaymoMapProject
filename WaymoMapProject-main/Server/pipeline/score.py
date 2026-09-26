"""Step 3: gpt-oss-120b rates every frame -> data/frames.json (resumable).

python -m pipeline.score [--fake] [--workers N] [--pause S]
--fake skips the LLM and invents deterministic scores, so the router/API/frontend can be built before keys exist.

gpt-oss-120b is a text model. We send the JPEG anyway (some OpenAI-compatible hosts accept
image_url). If the host rejects images, we retry from street/lat/lng and keep that mode for
the rest of the run. Saves every 25 frames so Ctrl+C or a crash loses almost nothing: rerunning
picks up where it stopped.
"""
import argparse
import json
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel

from app import config, llm

OUT = config.DATA / "frames.json"
PROMPT = ("Rate this street view 1-10 as something a tourist would want to see out a car window. "
          f"Tag what is here using only these tags: {', '.join(config.TAGS)}. "
          'Reply with JSON only: {"score": <1-10 integer>, "tags": [<tags from that list>]}.')
# After the first image rejection, skip JPEGs for the rest of the run.
_text_only = [False]


class Rating(BaseModel):
    score: int
    tags: list[str]


def _where(p):
    return (f" Street: {p.get('street') or '?'}. "
            f"Location: {p.get('lat')},{p.get('lng')}. "
            f"Heading {p.get('heading', '?')}. Wynwood, Miami.")


def _to_rating(data):
    r = Rating(score=int(data["score"]), tags=list(data.get("tags") or []))
    return r


def rate(p):
    text = PROMPT + _where(p)
    jpg = config.MEDIA / "frames" / f"{p['id']}.jpg"
    if not _text_only[0]:
        try:
            data = llm.complete_json([llm.user_text_and_image(text, jpg.read_bytes())])
            return _to_rating(data)
        except llm.LLMError as e:
            err = str(e).lower()
            if e.status in (400, 415, 422) or any(w in err for w in ("image", "vision", "multimodal", "modality")):
                _text_only[0] = True
                print("host rejected images; ranking from street/lat/lng for the rest of this run")
            else:
                raise
    data = llm.complete_json([{
        "role": "user",
        "content": text + " You cannot see the photo; infer a tourist window score from the location.",
    }])
    return _to_rating(data)


def fake(p):
    rng = random.Random(p["id"])
    return Rating(score=rng.randint(1, 10), tags=rng.sample(config.TAGS[:-1], rng.randint(0, 2)))


def one(p, use_fake, pause=0.0):
    r = fake(p) if use_fake else rate(p)
    if pause:
        import time
        time.sleep(pause)
    return {"id": p["id"], "segment": p["id"], "score": max(1, min(10, r.score)), "tags": [t for t in r.tags if t in config.TAGS]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--workers", type=int, default=8, help="parallel LLM calls")
    ap.add_argument("--pause", type=float, default=0.0, help="seconds to wait after each call per worker")
    args = ap.parse_args()
    fake_mode = args.fake
    if not fake_mode:
        assert config.LLM_KEY, "set LLM_API_KEY (or OPENAI_API_KEY) in Server/.env (or use --fake)"
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    done = {}
    if OUT.exists():
        try:
            done = {f["id"]: f for f in json.loads(OUT.read_text(encoding="utf-8"))}
        except ValueError:  # a run killed mid-write: start over rather than crash (it's cheap)
            print("frames.json was unreadable (killed mid-save?), starting fresh")
    todo = [p for p in pts if p["id"] not in done and (fake_mode or (config.MEDIA / "frames" / f"{p['id']}.jpg").exists())]
    print(f"{len(done)} already scored, {len(todo)} to go, {args.workers} workers, model {config.LLM_MODEL}")

    def save():
        OUT.write_text(json.dumps(list(done.values())), encoding="utf-8")

    fails = 0
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(one, p, fake_mode, args.pause): p for p in todo}
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
