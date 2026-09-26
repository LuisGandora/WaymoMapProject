"""FastAPI app. Run from Server/: uvicorn app.main:app --reload"""
import json
from functools import lru_cache

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import Point, mapping

from . import config, graph, store, tour

config.MEDIA.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Waymo Tour API")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=config.MEDIA), name="static")

CAN_NARRATE = bool(config.GEMINI_KEY and config.ELEVEN_KEY and config.ELEVEN_VOICE)


class RouteReq(BaseModel):
    mood: str
    minutes: int
    start: str = "wynwood"
    language: str = "en"
    lat: float | None = None  # custom start (with lng); must be inside the service area
    lng: float | None = None


def _need_data(fn, *a):
    try:
        return fn(*a)
    except FileNotFoundError as e:
        raise HTTPException(503, f"missing data file {e.filename}; run the pipeline (see Server/README.md)")


@app.get("/health")
def health():
    return {"ok": True, "narration": CAN_NARRATE, "mongo": bool(config.MONGO_URI)}


@app.get("/config")
def options():
    return {"moods": config.MATRIX_MOODS, "languages": config.LANGS, "starts": list(config.HOODS)}


@lru_cache
def _segments_geojson():
    segs = json.loads((config.DATA / "segments.json").read_text(encoding="utf-8"))
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": s["line"]},
         "properties": {"id": s["id"], "score": s["score"], "tags": s["tags"], "street": s["street"]}} for s in segs]}


@lru_cache
def _photos_geojson():
    """Every street piece that has a downloaded frame, scored or not: points.json geometry + the frame's sidecar json."""
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
    try:
        scored = tour.segments()  # optional: score/description appear only if pipeline.score + rollup were run
    except FileNotFoundError:
        scored = {}
    feats = []
    for p in pts:
        frames = config.MEDIA / "frames"
        if not (frames / f"{p['id']}.jpg").exists():
            continue
        side = frames / f"{p['id']}.json"  # written by pipeline.streetview: where the pano really is
        info = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {}
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": p["line"]}, "properties": {
            "id": p["id"], "street": p["street"], "photo": f"/static/frames/{p['id']}.jpg",
            "lat": info.get("lat", p["lat"]), "lng": info.get("lng", p["lng"]), "heading": p["heading"],
            "date": info.get("date"), "copyright": info.get("copyright"),
            "score": (s := scored.get(p["id"], {})).get("score"), "tags": s.get("tags", []),
            "why": tour.why(p["street"], s.get("score"), s.get("tags", []))}})
    return {"type": "FeatureCollection", "features": feats}


@app.get("/photos")
def photos():
    """Street pieces that have a Street View frame (independent of scoring), for click-a-street-to-see-it."""
    return _need_data(_photos_geojson)


@app.get("/service-area")
def service_area():
    """The traced Waymo polygon as a GeoJSON Feature, for the frontend outline layer."""
    return {"type": "Feature", "properties": {}, "geometry": mapping(graph.polygon())}


@app.get("/segments")
def segments(bbox: str | None = None):
    """Scored ~100 m street pieces as GeoJSON, for the green-to-gray heat map. bbox=minLng,minLat,maxLng,maxLat."""
    fc = _need_data(_segments_geojson)
    if not bbox:
        return fc
    try:
        x0, y0, x1, y1 = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    hit = lambda f: any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in f["geometry"]["coordinates"])  # endpoints only
    return {"type": "FeatureCollection", "features": [f for f in fc["features"] if hit(f)]}


@app.post("/route")
def route(req: RouteReq, bg: BackgroundTasks):
    custom = req.lat is not None and req.lng is not None
    if req.mood not in config.MATRIX_MOODS or (not custom and req.start not in config.HOODS) or req.language not in config.LANGS:
        raise HTTPException(400, "unknown mood, start or language; see GET /config")
    if custom and not graph.polygon().contains(Point(req.lng, req.lat)):
        raise HTTPException(400, "start is outside the service area")
    if not 5 <= req.minutes <= 90:
        raise HTTPException(400, "minutes must be 5-90")
    try:
        doc = _need_data(tour.build_options, req.mood, req.minutes, req.start, (req.lat, req.lng) if custom else None)
    except ValueError as e:
        raise HTTPException(422, str(e))
    best = doc["options"][0]["id"]
    if CAN_NARRATE and req.language not in store.get(best)["stops"][0]["audio"]:
        bg.add_task(tour.narrate_tour, best, req.language)  # only the top pick; others via POST /tour/{id}/narrate
    return {"tour_id": best, "options": doc["options"]}


@app.get("/tour/{tour_id}")
def get_tour(tour_id: str):
    """Pure read: path, frames, stops (with script/audio per language) and summary. No external calls."""
    t = store.get(tour_id)
    if not t:
        raise HTTPException(404, "no such tour")
    return t


@app.post("/tour/{tour_id}/narrate")
def narrate_more(tour_id: str, lang: str, bg: BackgroundTasks):
    """Language toggle: ask for another language's audio, then poll GET /tour/{id}."""
    if lang not in config.LANGS or not store.get(tour_id):
        raise HTTPException(404, "unknown tour or language")
    if not CAN_NARRATE:
        raise HTTPException(503, "narration keys not configured")
    bg.add_task(tour.narrate_tour, tour_id, lang)
    return {"started": True}
