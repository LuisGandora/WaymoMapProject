"""FastAPI app. Run from Server/: uvicorn app.main:app --reload"""
import json
from functools import lru_cache

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, store, tour

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


@app.get("/segments")
def segments():
    """Scored ~100 m street pieces as GeoJSON, for the green-to-gray heat map."""
    return _need_data(_segments_geojson)


@app.post("/route")
def route(req: RouteReq, bg: BackgroundTasks):
    if req.mood not in config.MATRIX_MOODS or req.start not in config.HOODS or req.language not in config.LANGS:
        raise HTTPException(400, "unknown mood, start or language; see GET /config")
    if not 5 <= req.minutes <= 90:
        raise HTTPException(400, "minutes must be 5-90")
    try:
        t = _need_data(tour.build, req.mood, req.minutes, req.start)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if CAN_NARRATE and req.language not in t["stops"][0]["audio"]:
        bg.add_task(tour.narrate_tour, t["id"], req.language)  # audio appears on GET /tour/{id} as it is made
    return {"tour_id": t["id"], "path": t["path"], "stops": t["stops"], "summary": t["summary"]}


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
