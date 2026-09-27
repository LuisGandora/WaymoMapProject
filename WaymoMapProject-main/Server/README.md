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
| `POST /route` `{mood, minutes, start, language, lat?, lng?}` | builds (or returns the cached) one-way tour from `start`, or from `lat`/`lng` if given (400 if outside the service area, 422 if no photo-covered street is within 250 m); starts narration in `language` in the background. Returns `{tour_id, options}`: `options` is the top 10 routes, ranked by mean stop score (half-point steps) first, then share of the drive inside the service area, then drive time; `tour_id` is #1 and each option's `id` loads with `GET /tour/{id}` (which also has `origin`: the start's photo, street and description). Only #1 is narrated automatically |
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
| `app/tour.py` | Builds a one-way tour from `segments.json` + the graph: the start (a neighborhood default, or a spot the user picked) snaps to the nearest photo-backed street piece; the destination is the user's pick or a scenic block for the mood reached within the time budget. The route is the single shortest road start -> destination (no detours, no cycles, nothing before the start or after the end); the numbered stops are the best blocks on it, and the drive is checked against the budget. Real path geometry via Dijkstra, ride-mode frames, stops. `narrate_tour` fills script + audio per stop. Tour id = `<mood>-<minutes>-<start>` plus `-safe`, `-from<lat>_<lng>`, `-to<lat>_<lng>` when set; a stored tour without a destination (older loop format) is rebuilt. |
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

Full walkthrough with commands: [`../DIGITALOCEAN.md`](../DIGITALOCEAN.md). In short: an Ubuntu 24.04 droplet, uvicorn under systemd (`deploy/waymo-api.service`), Caddy for HTTPS (`deploy/Caddyfile`), `data/media/` and `graph.graphml` copied over with `scp`, `CORS_ORIGINS` set to your Vercel origins, `NEXT_PUBLIC_API_URL=https://api.<yourdomain>` set in Vercel, and the droplet's IP allowed in Mongo Atlas.

## Expanding the tour area (`AREA_BUFFER_MILES`)

`AREA_BUFFER_MILES` grows the traced Waymo polygon (54 sq mi) in every direction: 1 mile = ~91 sq mi, 3 miles = ~180, 4 miles = ~233, 10 miles = ~680. The street graph, the sampled blocks and the "start/end must be inside the area" check all use the grown shape, and `/service-area` (the map outline) shows it. Stops only exist where a frame has been downloaded **and** scored, so growing the area adds nothing to tours until you run the steps below.

### What it costs

Street pieces (~100 m each) measured from the OSM graph. Only ~600 pieces have frames today.

| Buffer | Pieces in the whole area | Pieces in the new ring only | Images to download for the ring | Cost after the free 10,000 |
|---|---|---|---|---|
| 1 mile | 34,370 | 8,826 | up to 8.8k | $0 |
| 3 miles | 55,163 | 29,619 | up to 29.6k | about $138 |
| 4 miles | 67,720 | 42,176 | up to 42.2k | about $225 |

- Google Static Street View: the first **10,000 images each month are free**, then $7.00 per 1,000 up to 100,000 (then $5.60). The metadata check the tool runs first is free and unlimited, so spots with no imagery cost nothing; the figures above are upper bounds.
- Scoring is one LLM call per frame (`LLM_API_KEY`), billed by your LLM provider.
- Check what you already used this month: Cloud Console -> APIs & Services -> Street View Static API.
- Size: the 4-mile graph is 32k nodes / 85k edges (~2.5x the traced one) and downloads from OSM in under 3 minutes. 10 miles is several times bigger and untested. A 2 GB droplet is probably fine up to 4 miles; 4 GB is the safe choice.

### Steps (from `Server/`, PowerShell)

The example is the 1-mile ring, which fits in one free month. Needs `GOOGLE_MAPS_API_KEY` and `LLM_API_KEY` in `Server/.env`.

**1. Set the size and rebuild the street graph** (free; a few minutes)

```powershell
# in Server/.env:  AREA_BUFFER_MILES=1
del data\graph.graphml
python -c "from app import graph; graph.build()"
```
Writes `data/graph.graphml` for the grown area. Skipping the delete keeps the old graph and finds no new streets.

**2. Sample only the new area** (free; prints the frame count)

```powershell
python -m pipeline.sample --ring --merge
```
Expect: `N points -> data/points.json; M have no frame yet (at most $X ...)`. `--ring` keeps only pieces outside the traced polygon; `--merge` keeps the points you already have (without it `points.json` is replaced and `rollup` would drop every block you scored before). Other choices: `--bbox W S E N --merge` for one box (lng/lat degrees), or `--merge` alone for the whole grown area including the traced part.

**3. Download the frames** (billable after 10,000 images per month)

```powershell
python -m pipeline.streetview --limit 10000
```
Expect: `K points to fetch (of N)...` then `J new frames from K points`. It skips frames already on disk, checks free metadata first, and stops after 10,000 image downloads. If it stops at the limit, rerun next month (or drop `--limit` and pay) to continue; it resumes where it left off.

**4. Score the new frames** (one LLM call each; Ctrl+C is safe, rerun resumes)

```powershell
python -m pipeline.score
```
Expect: `X already scored, Y to go...` then `Z scored frames -> data/frames.json`. Already-scored frames are skipped.

**5. Rebuild what the API reads**

```powershell
python -m pipeline.rollup      # data/segments.json
python -m pipeline.matrix      # data/matrix_<mood>.json, one per mood
del data\tours\*.json          # cached tours keep the old scores; this also deletes baked demo tours (rerun pipeline.bake)
```

**6. Check it**

```powershell
python -m pipeline.validate    # its area check compares the traced shape, not the grown one
python test_router.py          # prints "ok"
uvicorn app.main:app --reload
```
Open `http://localhost:8000/segments` (new blocks appear) and `http://localhost:8000/config` (moods and starts). Optionally rerun `python -m pipeline.safety` so the safety layer covers the bigger area.

**7. Put it on the server** (if deployed; see [`../DIGITALOCEAN.md`](../DIGITALOCEAN.md))

```powershell
scp Server/data/graph.graphml waymo@<IP>:/home/waymo/WaymoMapProject/Server/data/
scp -r Server/data/media waymo@<IP>:/home/waymo/WaymoMapProject/Server/data/
```
Commit and pull the `data/*.json` files, set the same `AREA_BUFFER_MILES` in the droplet's `.env`, then `sudo systemctl restart waymo-api`.

**Repeat for a bigger area or another month:** change `AREA_BUFFER_MILES`, rerun steps 1-7 (the graph rebuild and `--ring --merge` pick up the new ring; already-downloaded and already-scored frames are never redone).

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
