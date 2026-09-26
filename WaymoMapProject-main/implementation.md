# Implementation: Importing GeoJSON & Waymo Service-Area Features

**Project:** ShellHacks 2026 — Idle Waymo → self-narrating Miami city tour
**Owner:** Backend (Python / FastAPI)
**Blocks:** scenic scoring pipeline, `/route` endpoint, map shading on the frontend

---

## 1. Goal

Produce a clean, routable street network of Miami that is **strictly inside Waymo's service area** and **contains no highways**, plus the ~100 m sample points the scoring pipeline will send to Street View.

When this task is done, the rest of the team can rely on four artifacts:

| Artifact | Consumer | What it is |
|---|---|---|
| `data/waymo_service_area.geojson` | Backend, frontend | Traced service polygon (EPSG:4326) |
| `data/miami_drive.graphml` | Router (in-memory graph) | OSM drive graph clipped to polygon, highways removed, travel times on every edge |
| `segments` collection / `segments.json` | Map, router | One row per ~100 m street piece (LineString + score placeholder) |
| `data/sample_points.json` | Scoring pipeline | lat/lng + heading per segment, ready for Street View |

---

## 2. Directory layout

```
backend/
  app/
    main.py              # FastAPI app, loads graph on startup
    geo/
      service_area.py    # load + validate polygon
      streets.py         # build/clip/filter OSM graph
      segments.py        # split edges into ~100 m pieces + sample points
    routes/
      geo.py             # GET /service-area, GET /segments
  scripts/
    build_geo.py         # one-shot: runs the whole import, writes data/
  data/
    waymo_service_area.geojson
    demo_areas.geojson   # optional: the 2 demo neighborhoods
    miami_drive.graphml
    sample_points.json
```

**Dependencies** (`requirements.txt`):

```
osmnx>=2.0
geopandas>=1.0
shapely>=2.0
pyproj
networkx
pymongo
fastapi
uvicorn
```

> osmnx 2.x moved several functions into submodules (`ox.routing`, `ox.truncate`, `ox.convert`). Snippets below use the 2.x API — pin it so teammates don't hit 1.x signatures.

---

## 3. Step 1 — Trace the Waymo service polygon

Waymo does not publish a GIS file, only a map image (Waymo One app / January 2026 launch post).

1. Open the service-map image beside **geojson.io**, centered on Miami.
2. Draw the outline with the polygon tool (30–50 clicks). Follow landmarks — major roads, the bay shoreline, municipal edges — rather than eyeballing pixels.
3. If the area has disconnected parts, draw each as its own polygon; we'll merge into a `MultiPolygon`.
4. Add properties to the feature before saving:

```json
{
  "type": "Feature",
  "properties": {
    "name": "Waymo Miami service area",
    "source": "Traced from Waymo's published service map",
    "approximate": true,
    "traced_on": "2026-09-26"
  },
  "geometry": { "type": "Polygon", "coordinates": [[ [lon, lat], ... ]] }
}
```

5. Save to `backend/data/waymo_service_area.geojson` and commit it.

**Expected coverage** (sanity check when tracing): Brickell, Wynwood, Design District, Coral Gables, Little Havana, Coconut Grove, Allapattah, South Miami, West Miami, parts of unincorporated Miami-Dade. ~60 sq mi.

> ⚠️ Note that Overtown and Little Haiti are named in the pitch but not in the list above. Confirm while tracing whether they fall inside the polygon — if not, the "skipped neighborhoods" talking point needs adjusting, since every route must stay inside.

---

## 4. Step 2 — Load and validate the polygon

`app/geo/service_area.py`

```python
import json
import geopandas as gpd
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

def load_service_area(path: str):
    with open(path) as f:
        fc = json.load(f)
    features = fc["features"] if fc.get("type") == "FeatureCollection" else [fc]
    geom = unary_union([shape(f["geometry"]) for f in features])
    if not geom.is_valid:          # hand-traced polygons often self-intersect
        geom = make_valid(geom)
    geom = geom.buffer(0)          # closes slivers, normalizes rings
    return geom                    # Polygon or MultiPolygon, EPSG:4326

def area_sq_miles(geom) -> float:
    gs = gpd.GeoSeries([geom], crs="EPSG:4326")
    return float(gs.to_crs(gs.estimate_utm_crs()).area.iloc[0] / 2_589_988)
```

**Checks** (fail the build script if any fail):
- `geom.is_valid` is `True` after cleanup
- `area_sq_miles(geom)` is roughly 50–70
- The centroid is in Miami (≈ 25.77, −80.22)

---

## 5. Step 3 — Pull OSM streets clipped to the polygon

`app/geo/streets.py`

```python
import osmnx as ox

HIGHWAY_TAGS = {"motorway", "motorway_link", "trunk", "trunk_link"}

def build_graph(service_area):
    G = ox.graph_from_polygon(
        service_area,
        network_type="drive",
        simplify=True,
        truncate_by_edge=True,   # keep edges that cross the boundary
    )
    G = drop_highways(G)
    G = ox.truncate.largest_component(G, strongly=True)  # every node reachable both ways
    G = ox.routing.add_edge_speeds(G)       # imputes km/h from OSM maxspeed/type
    G = ox.routing.add_edge_travel_times(G) # seconds, stored as edge["travel_time"]
    return G

def drop_highways(G):
    def is_highway(tag):
        tags = tag if isinstance(tag, list) else [tag]   # OSM 'highway' can be a list
        return any(t in HIGHWAY_TAGS for t in tags)

    to_remove = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True)
                 if is_highway(d.get("highway"))]
    G.remove_edges_from(to_remove)
    G.remove_nodes_from([n for n in list(G.nodes) if G.degree(n) == 0])
    return G
```

**Why `strongly=True`:** removing highways can strand one-way fragments. The router (Dijkstra) must be able to go A→B *and* back for a loop tour, so keep only the largest strongly connected component.

**Why cache to GraphML:** downloading from Overpass takes a minute or more and can rate-limit on hackathon Wi-Fi. Build once, then load from disk on startup in seconds:

```python
ox.save_graphml(G, "data/miami_drive.graphml")
G = ox.load_graphml("data/miami_drive.graphml")
```

---

## 6. Step 4 — Split edges into ~100 m segments + sample points

`app/geo/segments.py`

Each edge becomes one or more segments. Each segment gets one sample point at its midpoint with a **heading** for Street View.

```python
import osmnx as ox
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.ops import substring, transform

SEG_LEN_M = 100

def build_segments(G, window_side="right"):
    edges = ox.convert.graph_to_gdfs(G, nodes=False).reset_index()
    utm = edges.estimate_utm_crs()
    edges_m = edges.to_crs(utm)
    to_wgs = Transformer.from_crs(utm, "EPSG:4326", always_xy=True).transform

    segments, points = [], []
    for row, row_m in zip(edges.itertuples(), edges_m.itertuples()):
        line_m: LineString = row_m.geometry
        n = max(1, round(line_m.length / SEG_LEN_M))
        step = line_m.length / n
        for i in range(n):
            piece_m = substring(line_m, i * step, (i + 1) * step)
            mid_m = line_m.interpolate((i + 0.5) * step)
            ahead_m = line_m.interpolate(min((i + 0.5) * step + 5, line_m.length))

            piece = transform(to_wgs, piece_m)
            lon, lat = to_wgs(mid_m.x, mid_m.y)
            lon2, lat2 = to_wgs(ahead_m.x, ahead_m.y)
            travel_heading = ox.bearing.calculate_bearing(lat, lon, lat2, lon2)
            offset = 90 if window_side == "right" else -90

            seg_id = f"{row.u}-{row.v}-{row.key}-{i}"
            segments.append({
                "_id": seg_id,
                "edge": [int(row.u), int(row.v), int(row.key)],
                "name": row.name if isinstance(row.name, str) else None,
                "geometry": {"type": "LineString", "coordinates": list(piece.coords)},
                "length_m": round(piece_m.length, 1),
                "score": None,          # filled later by the scoring pipeline
                "tags": [],
                "frame_count": 0,
            })
            points.append({
                "segment_id": seg_id,
                "lat": lat, "lng": lon,
                "heading": round((travel_heading + offset) % 360, 1),
                "travel_heading": round(travel_heading, 1),
            })
    return segments, points
```

**Heading choice:** a rider looks *out the side window*, not through the windshield, so the default heading is travel direction +90° (right side). If time allows, sample both sides (±90°) and keep the higher score per segment.

**Limit scope for the demo:** the plan starts at ~500 frames. Filter sample points to the two demo neighborhoods before handing off to scoring:

```python
demo = load_service_area("data/demo_areas.geojson")
points = [p for p in points if demo.contains(Point(p["lng"], p["lat"]))]
```

---

## 7. Step 5 — Persist

### MongoDB Atlas (`segments` collection)

```python
from pymongo import MongoClient, GEOSPHERE, ReplaceOne

db = MongoClient(MONGO_URI)["waymo_tours"]
db.segments.create_index([("geometry", GEOSPHERE)])
db.segments.bulk_write(
    [ReplaceOne({"_id": s["_id"]}, s, upsert=True) for s in segments],
    ordered=False,
)
db.meta.replace_one({"_id": "service_area"},
                    {"_id": "service_area", "geometry": mapping(service_area)},
                    upsert=True)
```

Upserts keyed on `_id` make the import **idempotent** — re-running the script won't duplicate rows or wipe scores if you merge `score`/`tags` instead of replacing (use `$setOnInsert` for those fields once scoring has started).

### Local JSON (matches the algorithm plan)

Also write `segments.json` and `sample_points.json` so the router and scorer can run offline without Mongo, e.g. on stage if Wi-Fi drops.

---

## 8. Step 6 — Load on startup & expose endpoints

`app/main.py`

```python
from contextlib import asynccontextmanager
import osmnx as ox
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.G = ox.load_graphml("data/miami_drive.graphml")
    app.state.service_area = load_service_area("data/waymo_service_area.geojson")
    yield

app = FastAPI(lifespan=lifespan)
```

`app/routes/geo.py`

| Endpoint | Returns | Used by |
|---|---|---|
| `GET /service-area` | GeoJSON Feature of the polygon | Frontend outline layer |
| `GET /segments?bbox=minLng,minLat,maxLng,maxLat` | FeatureCollection, `properties.score` per segment | Frontend heat-colored streets |

```python
@router.get("/segments")
def segments(bbox: str):
    minx, miny, maxx, maxy = map(float, bbox.split(","))
    box = {"type": "Polygon", "coordinates": [[
        [minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]}
    docs = db.segments.find({"geometry": {"$geoIntersects": {"$geometry": box}}},
                            {"geometry": 1, "score": 1, "tags": 1}).limit(5000)
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": d["_id"], "geometry": d["geometry"],
         "properties": {"score": d.get("score"), "tags": d.get("tags", [])}}
        for d in docs]}
```

For the demo, a pre-baked static `segments.geojson` served from Vercel is also fine and avoids a live call.

### Frontend (MapLibre) — for the frontend owner

```js
map.addSource("segments", { type: "geojson", data: `${API}/segments?bbox=${bbox}` });
map.addLayer({
  id: "segments", type: "line", source: "segments",
  paint: {
    "line-width": 3,
    "line-color": ["case",
      ["==", ["get", "score"], null], "#9ca3af",
      ["interpolate", ["linear"], ["get", "score"], 1, "#9ca3af", 5, "#facc15", 10, "#16a34a"]]
  }
});
```

---

## 9. Validation checklist

Run at the end of `scripts/build_geo.py`; print a summary and exit non-zero on failure.

- [ ] Polygon valid, area ~50–70 sq mi
- [ ] Zero edges with `highway` in `{motorway, motorway_link, trunk, trunk_link}`
- [ ] Graph is strongly connected
- [ ] Every edge has `travel_time > 0`
- [ ] Every sample point lies within the polygon (buffer by ~20 m to allow for `truncate_by_edge`)
- [ ] Segment count is in the low thousands; median `length_m` ≈ 100
- [ ] Visual check: drop `segments.json` into geojson.io or kepler.gl and confirm streets fill the traced shape with no highway corridors

---

## 10. Pitfalls

- **Coordinate order.** GeoJSON and Shapely are `[lng, lat]`; Google APIs and osmnx bearing functions take `lat, lng`. This is the #1 bug source — keep the naming explicit (`lat`, `lng`) everywhere outside GeoJSON.
- **`highway` tag as a list.** After simplification, merged edges can carry `["primary", "trunk"]`. The filter above handles it.
- **Mongo 2dsphere strictness.** It rejects self-intersecting polygons; that's why we `make_valid` + `buffer(0)` before inserting.
- **Street View gaps.** Before paying for Static images, call the **Street View metadata endpoint** (free) for each sample point and drop points where `status != "OK"`.
- **Overpass rate limits.** Build the graph once, commit the GraphML (or store it on the Droplet), never re-download at startup.

---

## 11. Attribution (README + on stage)

- "Service area traced from Waymo's published service map — approximate, not official."
- "Street data © OpenStreetMap contributors (ODbL)."

---

## 12. Task breakdown

| # | Task | Est. |
|---|---|---|
| 1 | Trace polygon in geojson.io, commit | 15 min |
| 2 | `service_area.py` + validation | 20 min |
| 3 | `streets.py`: download, drop highways, travel times, GraphML | 30 min |
| 4 | `segments.py`: ~100 m split, headings, sample points | 45 min |
| 5 | Mongo upsert + JSON export | 20 min |
| 6 | FastAPI startup + `/service-area`, `/segments` | 30 min |
| 7 | Validation script + visual check | 20 min |
| 8 | Hand off `sample_points.json` (demo areas only) to scoring pipeline | 5 min |

**Total:** ~3 hours for one person.
