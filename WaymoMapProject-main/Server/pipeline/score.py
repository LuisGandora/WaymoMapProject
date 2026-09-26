"""Step 3: Gemini rates every frame -> data/frames.json (resumable; the only place Gemini sees images).

python -m pipeline.score [--fake]
--fake skips Gemini and invents deterministic scores, so the router/API/frontend can be built before keys exist.
"""
import argparse
import json
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel

from app import config

OUT = config.DATA / "frames.json"


def prompt(p):
    street = p.get("street") or "unnamed street"
    return (f"This Street View photo was taken at {p['lat']}, {p['lng']} on {street} in Miami, "
            f"heading {p['heading']}° (passenger-side window). Use these coordinates; do not infer the location from the image. "
            f"Rate the view 1-10 as something a tourist would want to see out a car window. "
            f"Tag what is visible using only these tags: {', '.join(config.TAGS)}.")


class Rating(BaseModel):
    score: int
    tags: list[str]


def rate(client, p):
    from google.genai import types

    img = (config.MEDIA / "frames" / f"{p['id']}.jpg").read_bytes()
    r = client.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=[types.Part.from_bytes(data=img, mime_type="image/jpeg"), prompt(p)],
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=Rating),
    )
    return r.parsed


def fake(p):
    rng = random.Random(p["id"])
    return Rating(score=rng.randint(1, 10), tags=rng.sample(config.TAGS[:-1], rng.randint(0, 2)))


def one(client, p, use_fake):
    r = fake(p) if use_fake else rate(client, p)
    return {"id": p["id"], "segment": p["id"], "score": max(1, min(10, r.score)), "tags": [t for t in r.tags if t in config.TAGS]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fake", action="store_true")
    fake_mode = ap.parse_args().fake
    client = None
    if not fake_mode:
        assert config.GEMINI_KEY, "set GEMINI_API_KEY in Server/.env (or use --fake)"
        from google import genai

        client = genai.Client(api_key=config.GEMINI_KEY)
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    done = {f["id"]: f for f in json.loads(OUT.read_text(encoding="utf-8"))} if OUT.exists() else {}
    todo = [p for p in pts if p["id"] not in done and (fake_mode or (config.MEDIA / "frames" / f"{p['id']}.jpg").exists())]

    def save():
        OUT.write_text(json.dumps(list(done.values())), encoding="utf-8")

    try:
        with ThreadPoolExecutor(4) as ex:
            futs = {ex.submit(one, client, p, fake_mode): p for p in todo}
            for n, f in enumerate(as_completed(futs), 1):
                try:
                    r = f.result()
                    done[r["id"]] = r
                except Exception as e:  # rate limit etc.: skip, rerun resumes
                    print(f"skip {futs[f]['id']}: {e}")
                if n % 25 == 0:
                    save()
    finally:
        save()
    print(f"{len(done)} scored frames -> data/frames.json")


if __name__ == "__main__":
    main()
