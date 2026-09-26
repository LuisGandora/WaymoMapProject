# Server (FastAPI backend + data pipeline)

Turns Street View frames scored by gpt-oss-120b into a scenic street map, builds time-budgeted loop tours inside Waymo's service area, and serves them (with ElevenLabs audio) to the frontend.

## Quickstart

Needs Python 3.11+ (built on 3.13). Run everything from `Server/`.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env               # fill in keys as you get them
python test_router.py                # no keys needed, prints "ok"
```

**Run the API with no keys at all** (fake scores, good for frontend work):

```powershell
python -m pipeline.sample --hood wynwood little_havana   # first run downloads OSM, ~2 min, cached after
python -m pipeline.score --fake
python -m pipeline.rollup
python -m pipeline.matrix
uvicorn app.main:app --reload        # http://localhost:8000/docs
```

Try it: `POST /route` with `{"mood": "murals+sunset", "minutes": 30, "start": "wynwood"}`.

**The real pipeline** (needs `GOOGLE_MAPS_API_KEY` + `LLM_API_KEY`): same as above but replace `score --fake` with

```powershell
python -m pipeline.streetview        # downloads frames (costs money, resumable)
python -m pipeline.score             # gpt-oss-120b rates each frame (costs money, resumable)
```

Start with `python -m pipeline.sample --hood wynwood --limit 500` to test cheaply.
Then delete any old `data/tours/*.json` (tours are cached by mood+minutes+start and keep the scores they were built from).

**Bake the demo** (needs all keys, do this before going on stage):

```powershell
python -m pipeline.bake --mood murals+sunset --minutes 30 --start wynwood
```

Then `GET /tour/murals_sunset-30-wynwood` is a pure file/DB read: no live API calls.


## Data flow

```
service_area.geojson --> graph.py (OSM, no highways) --> graph.graphml
     sample.py --> points.json --> streetview.py --> media/frames/*.jpg
                              --> score.py (gpt-oss-120b) --> frames.json --> rollup.py --> segments.json
     segments.json + graph --> matrix.py --> matrix_<mood>.json
     POST /route: matrix + segments + graph --> tour --> data/tours/<id>.json (+ Mongo)
                  background: Places/Wikipedia + gpt-oss-120b script + ElevenLabs --> media/audio/*.mp3
     GET /tour/{id}: reads the stored tour. Nothing else.
```

## API

| Endpoint | What it does |
|---|---|
| `GET /health` | `{ok, narration, mongo}`: whether narration keys / Mongo are configured |
| `GET /config` | moods, languages, start neighborhoods (feed the pickers) |
| `GET /service-area` | the traced polygon as a GeoJSON Feature (outline layer) |
| `GET /segments?bbox=minLng,minLat,maxLng,maxLat` | scored ~100 m street pieces as GeoJSON (`score`, `tags`, `street`) for the green-to-gray map; `bbox` optional |
| `GET /photos` | every street piece with a downloaded Street View frame as GeoJSON (`photo`, `street`, `date`, pano `lat/lng`). Needs only `sample` + `streetview`, not `score`; the map uses it for click-a-street-to-see-it |
| `POST /route` `{mood, minutes, start, language}` | builds (or returns the cached) loop; starts narration in `language` in the background. Returns `{tour_id, path, stops, summary}` |
| `GET /tour/{id}` | full tour: `path` (GeoJSON LineString, lng/lat), `frames[]` for ride mode, `stops[]` (with `frame_idx`, `script{lang}`, `audio{lang}`), `summary`. Poll it while audio generates |
| `POST /tour/{id}/narrate?lang=es` | language toggle: generate another language, then poll `GET /tour/{id}` |
| `/static/frames/*.jpg`, `/static/audio/*.mp3` | stored media, referenced by the URLs inside a tour |

Moods: `murals water art_deco historic food sunset surprise murals+sunset`. Languages: `en es ht pt`. Starts: `wynwood little_havana`.
Interactive docs at `/docs`.

## Files

### Code (`app/`)

| File | What it is |
|---|---|
| `app/config.py` | All env vars, paths, and the constants everyone shares: `MOODS` (mood to tags), `HOODS` (demo neighborhood bbox + loop start), `LANGS`, `TAGS`, `SPEED_FACTOR`. Change moods/neighborhoods here. |
| `app/llm.py` | LiteLLM OpenAI-compatible client for gpt-oss-120b. Ranking and tour scripts both go through here. |
| `app/graph.py` | Loads the drivable street graph. Uses `data/graph.graphml` if present, else pulls OSM inside the polygon and saves it. Highways are excluded by an *inclusion* filter of road classes (primary down to residential), so motorway/trunk/service roads are never in the graph. Applies `SPEED_FACTOR` to travel times. |
| `app/router.py` | Pure route logic, no I/O. `top_candidates` picks the best-scored segments for a mood (>= 250 m apart); `build_loop` does cheapest insertion by `score / added_minutes` until the time budget is used. Tested by `test_router.py`. |
| `app/tour.py` | Builds a tour from `segments.json` + `matrix_<mood>.json` + the graph: route, real path geometry via Dijkstra, ride-mode frames, stops. `narrate_tour` fills script + audio per stop. Tour id = `<mood>-<minutes>-<start>`, and an existing id is returned instead of rebuilt. |
| `app/narrate.py` | The external calls for a stop: Places (nearby business rated >= 4.0), Wikipedia (nearest article), gpt-oss-120b (20 s script, told to use only the given facts), ElevenLabs (`eleven_multilingual_v2` MP3). |
| `app/store.py` | Saves/loads tours. Always writes `data/tours/<id>.json`; also mirrors to Mongo (`waymotour.tours`) when `MONGO_URI` is set, and reads Mongo first. Stops are embedded in the tour document, not a separate collection, so `/tour/{id}` is one read. |
| `app/main.py` | The FastAPI app: endpoints above, CORS from `CORS_ORIGINS`, static media. Narration only runs if LLM + ElevenLabs keys + voice id are set. |

### Pipeline (`pipeline/`, run in this order, each is `python -m pipeline.<name>`)

| Script | Reads | Writes | Notes |
|---|---|---|---|
| `sample.py` | graph | `data/points.json` | ~100 m pieces inside the polygon, one heading each: travel direction +90° (out the right window; `--side left\|ahead` to change), plus `travel_heading` and `length_m`. `--hood` limits to demo neighborhoods, `--limit N` for smoke tests. |
| `validate.py` | graph, `points.json` | (exit code) | Import checklist: polygon valid and ~50-70 sq mi, no motorway/trunk, strongly connected, travel times > 0, points inside polygon, median segment ~100 m. Run after `sample`. |
| `streetview.py` | `points.json` | `data/media/frames/<id>.jpg` | Free metadata check first, so no-imagery spots cost nothing. Skips frames already downloaded. |
| `score.py` | `points.json`, frames | `data/frames.json` | gpt-oss-120b, JSON `{score 1-10, tags[]}`. Resumable, saves every 25. `--fake` invents scores (no keys). |
| `rollup.py` | `points.json`, `frames.json` | `data/segments.json` | Averages frame scores per segment, keeps the segment geometry. |
| `matrix.py` | `segments.json`, graph | `data/matrix_<mood>.json` | Per mood: top-30 candidates + the demo starts, Dijkstra drive minutes between all pairs. The router looks times up here instead of running Dijkstra per request. |
| `bake.py` | all of the above + keys | `data/tours/<id>.json`, `data/media/audio/*.mp3` | Builds a tour and narrates it in every language for the stage demo. |

`test_router.py`: self-check for the insertion algorithm, mood filtering, and that the demo starts are inside the polygon. Run `python test_router.py`.

### Data files (`data/`)

| File | Made by | Size | In git? | Notes |
|---|---|---|---|---|
| `service_area.geojson` | traced from Waymo's launch-post map | tiny | yes | The **initial Jan 2026 launch area** (54 sq mi; Waymo says ~60), extracted from the map image and georeferenced against OSM highway junctions, ~50 m accuracy. It does not include the later Miami Beach / Hard Rock Stadium expansions. To change it, save a new polygon over this file, delete `graph.graphml`, rerun the pipeline. Say "traced from Waymo's published service map, approximate" on stage. |
| `graph.graphml` | `graph.py` (first run) | ~20 MB | **no** | OSM street graph. Regenerated automatically; delete it to refetch (after changing the polygon or `ROADS`). |
| `points.json` | `sample.py` | ~0.4 MB per 1.8k points | yes | Segment skeleton: ids (`u_v_i`), coordinates, heading, street name. |
| `frames.json` | `score.py` | small | yes | Every scored frame: score + tags. The only thing the ranking model's output lands in. |
| `segments.json` | `rollup.py` | small | yes | What the router and `/segments` read. Only scored segments exist. |
| `matrix_<mood>.json` | `matrix.py` | ~35 kB each | yes | The drive-time "stash". Rebuild after re-scoring. |
| `tours/<id>.json` | `/route`, `bake.py` | ~0.1-1 MB | yes | Stored tours, also the offline fallback for the demo. Delete one to force a rebuild. |
| `media/frames/*.jpg` | `streetview.py` | ~50 kB each | **no** | Street View images. Not committed (size and Google's terms). Copy to the droplet with `rsync`/`scp`. |
| `media/audio/*.mp3` | `narrate_tour` | ~100 kB each | **no** | ElevenLabs audio, named `<tour>-<stop>-<lang>.mp3`. Copy to the droplet after baking. |

### Other

| File | What it is |
|---|---|
| `requirements.txt` | Pinned deps from `pip freeze`. Reused by the Dockerfile later. |
| `.env.example` | Every env var with a note. Copy to `.env` (gitignored). |

## Deploying to the DigitalOcean droplet

1. On the droplet: `apt install python3-venv caddy`, clone the repo, create the venv, `pip install -r requirements.txt`, create `Server/.env`.
2. Copy `Server/data/media/` from your machine (`rsync -av Server/data/media/ user@droplet:/path/Server/data/media/`) and commit/copy the `data/*.json` files.
3. Run `uvicorn app.main:app --host 127.0.0.1 --port 8000` under systemd.
4. Caddy in front for HTTPS (Vercel pages are HTTPS, so browsers block calls to a plain-HTTP API): point `api.<yourdomain>` at the droplet in GoDaddy DNS, then a Caddyfile of `api.<yourdomain> { reverse_proxy localhost:8000 }`.
5. Set `CORS_ORIGINS` to your Vercel and domain origins.
6. Mongo Atlas: add the droplet's IP to the Atlas network allowlist, put the URI in `MONGO_URI`.

## Attribution

Service area traced from Waymo's published service map: approximate, not official. Street data © OpenStreetMap contributors (ODbL).

## Known limits and things to verify

- The neighborhood boxes (`HOODS`) are rough. Wynwood, Little Havana, Overtown and the Design District are inside the traced polygon; **Little Haiti is not** (the polygon's north edge is ~NW 46th St), so don't pitch it as a stop.
- ElevenLabs `eleven_multilingual_v2` may not support Haitian Creole. Test `ht` early and pick another voice/model or drop the language if the audio is wrong.
- Ranking and scripts use `openai/gpt-oss-120b` via LiteLLM (`completion()`, OpenAI-shaped). Override with `LLM_MODEL` / `LLM_BASE_URL` in `.env`.
- Google's Maps Platform terms restrict caching/storing Street View imagery and Places data. Keep it to the demo neighborhoods and don't publish the dataset.
- Route times come from OSM speeds times `SPEED_FACTOR`; calibrate `SPEED_FACTOR` against a real ride time.
- Sunset is approximated as waterfront + greenery tags (no sun position yet).
- Tours are cached by `(mood, minutes, start)`. After re-scoring, delete `data/tours/` (and the Mongo docs) or you will keep getting the old route.
- Not built yet: containerized AI runs, ESP32 mood dial, locals' block stories, user-drawn custom paths.
