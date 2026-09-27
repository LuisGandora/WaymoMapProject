"""Step 2: download one Street View frame per point -> data/media/frames/<id>.jpg (resumable).

python -m pipeline.streetview [--limit N]   (N = most images to download this run, the billable part; rerun to continue)
The free metadata endpoint is checked first so points with no imagery cost nothing.
"""
import argparse
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx

from app import config

URL = "https://maps.googleapis.com/maps/api/streetview"
OUT = config.MEDIA / "frames"
http = httpx.Client(transport=httpx.HTTPTransport(retries=5), timeout=30)  # retries connect/TLS timeouts


_lock, _got, _cap = threading.Lock(), [0], [None]  # images requested this run / the most allowed (None = no cap)


def fetch(p):
    try:
        return _fetch(p)
    except httpx.TransportError as e:  # flaky network: skip this point, a rerun picks it up
        print(f"skip {p['id']}: {e!r}")
        return 0


def _fetch(p):
    out = OUT / f"{p['id']}.jpg"
    if _cap[0] is not None and _got[0] >= _cap[0]:
        return 0  # this run has used up its image allowance
    side = out.with_suffix(".json")  # where the pano really is, so the map can tie the photo to a location
    if out.exists() and side.exists():
        return 0
    q = {"location": f"{p['lat']},{p['lng']}", "heading": p["heading"], "source": "outdoor", "key": config.GOOGLE_KEY}
    meta = http.get(URL + "/metadata", params=q).json()  # free
    if meta.get("status") != "OK":
        return 0
    side.write_text(json.dumps({
        "id": p["id"], "street": p["street"], "lat": meta["location"]["lat"], "lng": meta["location"]["lng"],
        "heading": p["heading"], "requested": {"lat": p["lat"], "lng": p["lng"], "heading": p["heading"]},
        "pano_id": meta.get("pano_id"), "date": meta.get("date"), "copyright": meta.get("copyright")}), encoding="utf-8")
    if out.exists():
        return 0  # sidecar backfill only
    with _lock:  # only the image request is billed (metadata is free), so that is what the cap counts
        if _cap[0] is not None and _got[0] >= _cap[0]:
            return 0
        _got[0] += 1
    r = http.get(URL, params={**q, "size": "640x400", "fov": 90, "pitch": 0})
    r.raise_for_status()
    out.write_bytes(r.content)
    return 1


def main():
    assert config.GOOGLE_KEY, "set GOOGLE_MAPS_API_KEY in Server/.env"
    OUT.mkdir(parents=True, exist_ok=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="download at most this many images this run (Google gives 10,000 free per month); rerun to continue")
    args = ap.parse_args()
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    todo = [p for p in pts if not ((OUT / f"{p['id']}.jpg").exists() and (OUT / f"{p['id']}.json").exists())]
    _cap[0] = args.limit
    print(f"{len(todo)} points to fetch (of {len(pts)}); images are billed after the free 10,000/month ($7 per 1,000 up to 100,000); metadata checks and no-imagery spots are free")
    with ThreadPoolExecutor(8) as ex:
        print(f"{sum(ex.map(fetch, todo))} new frames from {len(todo)} points")


if __name__ == "__main__":
    main()
