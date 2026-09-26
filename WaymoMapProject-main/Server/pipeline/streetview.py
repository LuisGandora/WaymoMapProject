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
    side = out.with_suffix(".json")  # where the pano really is, so the map can tie the photo to a location
    if out.exists() and side.exists():
        return 0
    q = {"location": f"{p['lat']},{p['lng']}", "heading": p["heading"], "source": "outdoor", "key": config.GOOGLE_KEY}
    meta = httpx.get(URL + "/metadata", params=q, timeout=30).json()  # free
    if meta.get("status") != "OK":
        return 0
    side.write_text(json.dumps({
        "id": p["id"], "street": p["street"], "lat": meta["location"]["lat"], "lng": meta["location"]["lng"],
        "heading": p["heading"], "requested": {"lat": p["lat"], "lng": p["lng"], "heading": p["heading"]},
        "pano_id": meta.get("pano_id"), "date": meta.get("date"), "copyright": meta.get("copyright")}), encoding="utf-8")
    if out.exists():
no        return 0  # sidecar backfill only
    r = httpx.get(URL, params={**q, "size": "640x400", "fov": 90, "pitch": 0}, timeout=30)
    r.raise_for_status()
    out.write_bytes(r.content)
    return 1


def main():
    assert config.GOOGLE_KEY, "set GOOGLE_MAPS_API_KEY in Server/.env"
    OUT.mkdir(parents=True, exist_ok=True)
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    with ThreadPoolExecutor(8) as ex:
        print(f"{sum(ex.map(fetch, pts))} new frames of {len(pts)} points")


if __name__ == "__main__":
    main()
