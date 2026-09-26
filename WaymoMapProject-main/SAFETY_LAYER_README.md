# Road-safety layer (Waymo "most trusted driver" angle)

Adds a `Safer Route` mode to tours plus a 0-100 safety score on every tour, built from public road-safety data.
Deliberately NOT crime data (that's redlining and says nothing about a locked robotaxi's passengers).

## Data (Miami-Dade County, public ArcGIS layers, no key)
- High Injury Network (Vision Zero): corridors with the most fatal/serious-injury crashes, 2018-2022
- KSI crashes 2019-2023: every killed/seriously-injured crash as a point
- FEMA flood zones (A*/V* special flood hazard areas)
- Road design from OSM: lanes, speed limit, road class (already in the graph)
- Live: NWS active alerts (api.weather.gov, no key); FL511 closures/incidents (optional free key)

## Install (from the repo root, venv active)
1. Copy `Server/app/safety.py`, `Server/pipeline/safety.py`, `apply_safety.py` into the repo (same paths).
2. `python apply_safety.py`   -> edits config/tour/main/.env.example + the 4 frontend files in place. Idempotent.
3. `cd Server && python -m pipeline.safety`   -> downloads the 3 layers clipped to the service area (about a minute)
   and writes `data/safety.json` + `data/safety/*.geojson`. Commit both.
4. Restart uvicorn. The frontend hot-reloads.

## What changed
- `POST /route` takes `"safe": true`. Same stops; the road BETWEEN stops is drawn on `safe_time` weights:
  HIN corridor +80%, +20% per KSI crash on the piece (cap +100%), big arterial +40%, calm street -10%,
  flood zone +100% only while a flood alert is active, live closure +900% (blocked). Knobs: `app/safety.py: W`.
- Every tour summary gets `safety`: score/grade, km on high-injury corridors, % arterial, % calm streets,
  crash counts, and for safe tours `vs_fastest` (extra minutes, high-injury km avoided).
- `GET /weather` (alerts + closures), `GET /hazards` (HIN + flood GeoJSON for the map).
- Frontend: Safer Route toggle (default ON), safety line under the summary pill, red dashed HIN corridors and
  faint blue flood zones on the map.

## Pitch line
"Every block is scored for beauty by Gemini and for safety by Miami-Dade's own crash data. Safer Route keeps the
tour off high-injury corridors and big arterials, reroutes around live closures, and avoids flood zones when the
Weather Service says so, for about two extra minutes."
