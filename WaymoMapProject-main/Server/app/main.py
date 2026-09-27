"""FastAPI app. Run from Server/: uvicorn app.main:app --reload"""
import json
import threading
from functools import lru_cache

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import Point, mapping

from . import config, graph, router, safety, store, tour

config.MEDIA.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Waymo Tour API")


@app.on_event("startup")
def warm_up():
    """Load the 20 MB street graph and the data files now, not on the first click after a restart."""
    try:
        G = graph.get()
        safety.apply(G)
        tour.segments()
        print(f"warm: graph {G.number_of_nodes()} nodes, safety data {'on' if safety.data()['edges'] else 'OFF (run pipeline.safety)'}")
    except Exception as e:  # missing data files are reported by the endpoints themselves
        print(f"warm-up skipped: {e}")
    for fn in (safety.weather, store._coll):  # the NWS fetch and Mongo's DNS lookup happen now, in the background, not on the first click
        threading.Thread(target=fn, daemon=True).start()
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_origin_regex=config.CORS_ORIGIN_REGEX, allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=config.MEDIA), name="static")

# A script writer (Gemini, or a LiteLLM proxy) plus ElevenLabs. Gemini alone is enough to write: see narrate.script.
CAN_NARRATE = bool(((config.LLM_KEY and config.LLM_BASE) or config.GEMINI_KEY) and config.ELEVEN_KEY and config.ELEVEN_VOICE)


class RouteReq(BaseModel):
    mood: str
    minutes: int
    start: str = "wynwood"
    language: str = "en"
    safe: bool = False  # route between stops on the road-safety weights (see app/safety.py)
    start_lat: float | None = None  # a start the user picked on the map (both or neither); must be inside the service area
    start_lng: float | None = None
    end_lat: float | None = None  # a destination picked on the map: makes it a one-way tour ending there
    end_lng: float | None = None
    rank: int = 0  # 0 = the best-ranked route; skipping a suggestion asks for rank+1 (ignored when a destination is picked)
    source: str = "photo"  # "photo" = Street View frames rated by AI; "popular" = places people map and look up online (tour.SOURCES)


def _need_data(fn, *a):
    try:
        return fn(*a)
    except FileNotFoundError as e:
        raise HTTPException(503, f"missing data file {e.filename}; run the pipeline (see Server/README.md)")


@app.get("/health")
def health():
    return {"ok": True, "narration": CAN_NARRATE, "mongo": bool(config.MONGO_URI)}


MIN_CANDIDATES = 5      # a mood needs this many scored blocks before the UI offers it
MIN_HOOD_SEGMENTS = 20  # a start neighborhood needs this many scored blocks inside its bbox


def available_moods(source="photo", start=None):
    """Moods that can actually make a tour: MIN_CANDIDATES blocks worth stopping at (tour.MIN_STOP_SCORE), on streets in
    the loaded graph, within a 30-minute loop's reach of an offered start (or of `start` only). Anything else is hidden
    rather than giving a 422 or a one-stop tour (e.g. the art deco blocks are on Miami Beach, far from the Wynwood start)."""
    segs, G = tour.segments(source), graph.get()
    starts = [config.HOODS[h]["start"] for h in ([start] if start else available_starts(source))]
    reach_m = 800 + 45 * 10  # tour.build's loop radius at the UI's shortest budget (10 min), so every offered budget works
    out = []
    for m in config.MATRIX_MOODS:
        try:
            nodes = tour.matrix(m, source)["nodes"]
        except FileNotFoundError:
            continue
        ok = [k for k, n in nodes.items() if k in segs and segs[k]["score"] >= tour.MIN_STOP_SCORE and n["enter"] in G and n["exit"] in G
              and any(router.haversine_m(p, (segs[k]["lat"], segs[k]["lng"])) <= reach_m for p in starts)]
        if len(ok) >= MIN_CANDIDATES:
            out.append(m)
    return out


def available_starts(source="photo"):
    """Start neighborhoods that actually have scored blocks (config.HOODS lists demo boxes, not what's been scored)."""
    segs = tour.segments(source).values()

    def snaps(at):  # the start point itself must reach a street the tour can begin on (a photographed one for "photo")
        try:
            return bool((tour.snap if source == "photo" else tour.snap_node)(*at))
        except ValueError:
            return False
    out = []
    for h, c in config.HOODS.items():
        w, s, e, n = c["bbox"]
        if sum(w <= x["lng"] <= e and s <= x["lat"] <= n for x in segs) >= MIN_HOOD_SEGMENTS and snaps(c["start"]):
            out.append(h)
    return out


@app.get("/config")
def options():
    def offer(source):
        try:
            starts = available_starts(source)
            return {"moods": available_moods(source), "starts": starts,
                    "by_start": {h: available_moods(source, h) for h in starts}}  # the moods that work from each start
        except FileNotFoundError:  # that source's pipeline hasn't been run: offer nothing for it
            return {"moods": [], "starts": [], "by_start": {}}
    # moods/starts at the top level are the photo source's (what the UI has always read); sources has both
    return {"moods": _need_data(available_moods), "languages": config.LANGS, "starts": _need_data(available_starts),
            "sources": {s: offer(s) for s in tour.SOURCES}}


@lru_cache
def _segments_geojson(source="photo"):
    segs = json.loads((config.DATA / tour._src("segments.json", source)).read_text(encoding="utf-8"))
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": s["line"]},
         "properties": {"id": s["id"], "score": s["score"], "tags": s["tags"], "street": s["street"],
                        **({"places": ", ".join(p["name"] for p in s["pois"] if p.get("name"))} if "pois" in s else {})}} for s in segs]}


@lru_cache
def _photos_geojson():
    """Every street piece that has a downloaded frame, scored or not: points.json geometry + the frame's sidecar json."""
    pts = json.loads((config.DATA / "points.json").read_text(encoding="utf-8"))
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
            "date": info.get("date"), "copyright": info.get("copyright")}})
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
def segments(bbox: str | None = None, source: str = "photo"):
    """Scored ~100 m street pieces as GeoJSON, for the green-to-gray heat map. bbox=minLng,minLat,maxLng,maxLat."""
    if source not in tour.SOURCES:
        raise HTTPException(400, f"source must be one of {', '.join(tour.SOURCES)}")
    fc = _need_data(_segments_geojson, source)
    if not bbox:
        return fc
    try:
        x0, y0, x1, y1 = map(float, bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be minLng,minLat,maxLng,maxLat")
    hit = lambda f: any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in f["geometry"]["coordinates"])  # endpoints only
    return {"type": "FeatureCollection", "features": [f for f in fc["features"] if hit(f)]}


@app.post("/route")
def route(req: RouteReq):
    if req.source not in tour.SOURCES:
        raise HTTPException(400, f"source must be one of {', '.join(tour.SOURCES)}")
    if req.mood not in _need_data(available_moods, req.source) or req.start not in _need_data(available_starts, req.source) or req.language not in config.LANGS:
        raise HTTPException(400, "that mood or start has no scored blocks yet; GET /config lists what's available")
    if not 0 <= req.rank < tour.TOP_N:
        raise HTTPException(400, f"rank must be 0-{tour.TOP_N - 1}")
    if not 1 <= req.minutes <= 90:
        raise HTTPException(400, "minutes must be 1-90")
    at, to = (req.start_lat, req.start_lng), (req.end_lat, req.end_lng)
    for name, pt in (("start", at), ("end", to)):
        if (pt[0] is None) != (pt[1] is None):
            raise HTTPException(400, f"{name}_lat and {name}_lng go together")
    at, to = (at if at[0] is not None else None), (to if to[0] is not None else None)
    for name, pt in (("start", at), ("end", to)):
        if pt and not graph.polygon().contains(Point(pt[1], pt[0])):
            raise HTTPException(400, f"the {name} point is outside the Waymo service area")
    try:
        t = _need_data(tour.build, req.mood, req.minutes, req.start, req.safe, at, to, req.rank, req.source)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not t["stops"]:
        raise HTTPException(422, "no scenic blocks for that mood within reach of the start; try another mood or a longer time budget")
    return {"tour_id": t["id"], "rank": t["rank"], "options": t["options"], "path": t["path"], "stops": t["stops"], "summary": t["summary"]}


@app.get("/weather")
def weather():
    """Active NWS alerts for the service area (cached 10 min) and live FL511 closures if a key is configured."""
    return {**safety.weather(), "closures": safety.closures(), "safety_data": safety.data()["meta"]}


@lru_cache
def _hazards():
    out = {}
    for name, file in (("hin", "hin.geojson"), ("flood", "flood_map.geojson"), ("ksi", "ksi_map.geojson")):  # never the raw FEMA file (tens of MB)
        f = config.DATA / "safety" / file
        out[name] = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"type": "FeatureCollection", "features": []}
    return out


@app.get("/hazards")
def hazards():
    """High Injury Network corridors and FEMA flood zones inside the service area, as GeoJSON, for map layers."""
    return _hazards()


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


@app.post("/tour/{tour_id}/stop/{stop_id}/narrate")
def narrate_spot(tour_id: str, stop_id: str, lang: str):
    """Voice for one spot: ElevenLabs is called for this stop only, when the rider reaches it. Cached on the tour, so
    revisits (and baked demo tours) return the stored audio without any external call."""
    t = store.get(tour_id)
    stop = t and next((s for s in t["stops"] if s["id"] == stop_id), None)
    if lang not in config.LANGS or not stop:
        raise HTTPException(404, "unknown tour, stop or language")
    if lang not in stop["audio"]:
        if not CAN_NARRATE:
            raise HTTPException(503, "narration keys not configured")
        try:
            stop = tour.narrate_stop(tour_id, stop_id, lang)
        except Exception as e:  # LLM / ElevenLabs down or out of quota: the map keeps working without the voice
            raise HTTPException(502, f"couldn't narrate this spot: {e}")
    return {"stop": stop_id, "audio": stop["audio"][lang], "script": stop["script"][lang]}
