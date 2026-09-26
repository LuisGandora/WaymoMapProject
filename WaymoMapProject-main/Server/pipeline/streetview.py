"""Step 2: download one Street View frame per point -> data/media/frames/<id>.jpg (resumable).

python -m pipeline.streetview
The free metadata endpoint is checked first so points with no imagery cost nothing.
"""
import json
from concurrent.futures import ThreadPoolExecutor

import httpx

from app import config

URL = "https://maps.googleapis.com/maps/api/streetview"
OUT = config.MEDIA / "frames"


def fetch(p):
    out = OUT / f"{p['id']}.jpg"
    if out.exists():
        return 0
    q = {"location": f"{p['lat']},{p['lng']}", "heading": p["heading"], "source": "outdoor", "key": config.GOOGLE_KEY}
    if httpx.get(URL + "/metadata", params=q, timeout=30).json().get("status") != "OK":
        return 0
    r = httpx.get(URL, params={**q, "size": "640x400", "fov": 90, "pitch": 0}, timeout=30)
    r.raise_for_status()
    out.write_bytes(r.content)
    return 1


def main():
    assert config.GOOGLE_KEY, "set GOOGLE_API_KEY in Server/.env"
    OUT.mkdir(parents=True, exist_ok=True)
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    with ThreadPoolExecutor(8) as ex:
        print(f"{sum(ex.map(fetch, pts))} new frames of {len(pts)} points")


if __name__ == "__main__":
    main()
