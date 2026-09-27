"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapEvent, type MapLayerMouseEvent, type MapRef } from "react-map-gl/maplibre";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getHazards, getPhotos, getSegments, getServiceArea, media, navStops, saferCompare, type LayerVis, type LatLng, type Stop, type Tour } from "../lib/api";
import type { Story } from "./NarrationPlayer";

export const MIAMI = { latitude: 25.7617, longitude: -80.1918 };

// Free CARTO dark basemap, no API key needed.
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Layer order = draw order. The route/car layers mount first and everything that loads later is inserted
// below them (beforeId), so the tour always sits on top: buildings < area/hazards/streets < route < car.
const TOP = "route-glow";
// The Safer Route comparison (standard route + avoided high-injury pieces) sits just under the tour and over everything else.
const COMPARE = "standard-route";

// 3D buildings from the basemap's own vector tiles; they rise in as the camera tilts down to street level.
const buildings3d: LayerProps = {
  id: "buildings-3d",
  type: "fill-extrusion",
  source: "carto",
  "source-layer": "building",
  minzoom: 14,
  filter: ["!=", ["get", "hide_3d"], true],
  paint: {
    "fill-extrusion-color": "#1b2538",
    "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, ["coalesce", ["get", "render_height"], 0]],
    "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
    "fill-extrusion-opacity": 0.85,
  },
};
const areaFill: LayerProps = { id: "area-fill", type: "fill", paint: { "fill-color": "#22d3ee", "fill-opacity": 0.04 } };
const areaLine: LayerProps = { id: "area-line", type: "line", paint: { "line-color": "#22d3ee", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.8 } };
const segmentsLine: LayerProps = {
  id: "segments",
  type: "line",
  paint: {
    "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 15, 4],
    "line-opacity": 0.85,
    // green = scenic, gray = not. Unscored streets aren't in segments.json at all.
    // Real Gemini scores are harsh (most blocks 1-2, murals 5-7, nothing above 7), so the ramp is fit to that range:
    // gray up to 2, yellow at 4, full green by 7. Bump these if the scoring prompt changes.
    "line-color": ["interpolate", ["linear"], ["get", "score"], 2, "#475569", 4, "#eab308", 7, "#22c55e"],
  },
};
// Streets that have a Street View frame (scored or not). Thin line for looks, wide invisible one so streets are easy to click.
const photosLine: LayerProps = { id: "photos", type: "line", paint: { "line-color": "#94a3b8", "line-width": 1.5, "line-opacity": 0.5 } };
const photosHit: LayerProps = { id: "photos-hit", type: "line", paint: { "line-width": 16, "line-opacity": 0 } };
// Road-safety hazards: High Injury Network corridors (red dashes) and FEMA flood zones (faint blue).
const hinLine: LayerProps = { id: "hin", type: "line", paint: { "line-color": "#ef4444", "line-width": 3, "line-dasharray": [2, 1.5], "line-opacity": 0.7 } };
const floodFill: LayerProps = { id: "flood", type: "fill", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.07 } };
// Every killed/seriously-injured crash 2019-2023 as a dot; pedestrian-involved ones a little bigger.
const ksiDots: LayerProps = {
  id: "ksi",
  type: "circle",
  paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "ped"], 1], 3.5, 2.5], 15, ["case", ["==", ["get", "ped"], 1], 7, 5]],
    "circle-color": ["case", ["==", ["get", "fatal"], 1], "#dc2626", "#f97316"],
    "circle-opacity": 0.85,
    "circle-stroke-width": 1,
    "circle-stroke-color": "#0e1628",
  },
};

// The route "draws itself": everything past line-progress p is transparent. Cyan at the start fading to blue at the end.
const drawn = (p: number, from: string, to: string) =>
  ["case", ["<=", ["line-progress"], p], ["interpolate", ["linear"], ["line-progress"], 0, from, 1, to], "rgba(0,0,0,0)"] as ExpressionSpecification;
const ROUTE_COLORS: [string, string, string][] = [
  ["route-glow", "#22d3ee", "#3b82f6"],
  ["route-casing", "#0e1628", "#0e1628"],
  ["route", "#67e8f9", "#3b82f6"],
];
const round = { "line-cap": "round", "line-join": "round" } as const;
const routeGlow: LayerProps = { id: "route-glow", type: "line", layout: round, paint: { "line-width": 18, "line-blur": 12, "line-opacity": 0.5, "line-gradient": drawn(0, "#22d3ee", "#3b82f6") } };
const routeCasing: LayerProps = { id: "route-casing", type: "line", layout: round, paint: { "line-width": 9, "line-gradient": drawn(0, "#0e1628", "#0e1628") } };
const routeLine: LayerProps = { id: "route", type: "line", layout: round, paint: { "line-width": 5, "line-gradient": drawn(0, "#67e8f9", "#3b82f6") } };
// The "Waymo": a glowing dot that leads the route as it draws, then keeps driving the loop.
const carGlow: LayerProps = { id: "car-glow", type: "circle", paint: { "circle-radius": 16, "circle-color": "#22d3ee", "circle-opacity": 0.35, "circle-blur": 1 } };
const carDot: LayerProps = { id: "car", type: "circle", paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-color": "#22d3ee", "circle-stroke-width": 3 } };
// Safer Route comparison: the same request with Safer Route off (gray dashes, under the tour) and the High Injury Network
// pieces that route drives and this one avoids (red, the glow pulses).
const standardLine: LayerProps = { id: "standard-route", type: "line", layout: round, paint: { "line-color": "#94a3b8", "line-width": 4, "line-opacity": 0.65, "line-dasharray": [1.4, 1.2] } };
const avoidedGlow: LayerProps = { id: "avoided-glow", type: "line", layout: round, paint: { "line-color": "#ef4444", "line-width": 16, "line-blur": 8, "line-opacity": 0.45 } };
const avoidedLine: LayerProps = { id: "avoided", type: "line", layout: round, paint: { "line-color": "#f87171", "line-width": 5, "line-opacity": 0.95 } };

const DRAW_MS = 2600;
const LAP_MS = 45000;

// Walk a LineString by distance fraction.
function pathWalker(coords: [number, number][]) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i];
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0));
  }
  const total = cum[cum.length - 1] || 1;
  return (f: number): [number, number] => {
    const d = Math.max(0, Math.min(1, f)) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = (d - cum[i - 1]) / seg;
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i] ?? coords[i - 1];
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  };
}

// Where each stop sits along the path, as a fraction 0..1: the first path point within ~75 m of it after the previous
// stop's point (else the nearest one after it), so a loop that passes a spot twice keeps its stops in driving order.
function stopFractions(coords: [number, number][], stops: { lat: number; lng: number }[]) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i];
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0));
  }
  const total = cum[cum.length - 1] || 1;
  let from = 0;
  return stops.map((s) => {
    const d = (i: number) => Math.hypot((coords[i][0] - s.lng) * Math.cos((s.lat * Math.PI) / 180), coords[i][1] - s.lat);
    let best = from;
    for (let i = from; i < coords.length; i++) {
      if (d(i) < 0.0007) {
        best = i;
        break;
      }
      if (d(i) < d(best)) best = i;
    }
    from = best;
    return cum[best] / total;
  });
}

// Overview of the whole loop, tilted, leaving room for the narration card on the left.
function overview(map: MLMap, tour: Tour, duration: number) {
  const cmp = saferCompare(tour);
  const all = cmp ? [...tour.path.coordinates, ...cmp.path.coordinates] : tour.path.coordinates; // keep the gray standard route in frame too
  const xs = all.map((c) => c[0]);
  const ys = all.map((c) => c[1]);
  const cam = map.cameraForBounds(
    [
      [Math.min(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.max(...ys)],
    ],
    cmp ? { padding: { top: 110, bottom: 150, left: 120, right: 340 } } : { padding: { top: 110, bottom: 110, left: 460, right: 90 } }, // leave room for the Safer Route card on the right
  );
  if (!cam) return;
  map.flyTo({ ...cam, zoom: (cam.zoom ?? 13) - 0.2, pitch: 48, bearing: -18, duration, curve: 1.4, essential: true });
}

// A stable, slightly different angle per place so each shot feels composed rather than repeated.
const angleFor = (name: string) => ([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) % 70) - 35;

// Direction arrows repeated along the route; the "arrow" image is drawn in onLoad (no asset file needed).
const routeArrows: LayerProps = {
  id: "route-arrows",
  type: "symbol",
  layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "arrow", "icon-size": 0.55, "icon-allow-overlap": true, "icon-rotation-alignment": "map" },
};

function addArrowImage(e: MapEvent) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.beginPath(); // right-pointing chevron; symbol-placement "line" rotates it to follow the route
  g.moveTo(6, 4); g.lineTo(28, 16); g.lineTo(6, 28); g.lineTo(13, 16); g.closePath();
  g.fillStyle = "#fff"; g.strokeStyle = "#0e1628"; g.lineWidth = 3; g.lineJoin = "round";
  g.stroke(); g.fill();
  e.target.addImage("arrow", g.getImageData(0, 0, 32, 32));
}

// Ray-casting point-in-polygon against the service area (Polygon or MultiPolygon, holes respected).
const inRing = (r: number[][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
};
const inArea = (f: GeoJSON.Feature | null, x: number, y: number) => {
  const g = f?.geometry;
  const polys = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((p) => inRing(p[0], x, y) && !p.slice(1).some((h) => inRing(h, x, y)));
};

// Big glowing start (green) / destination (red) pin with a label, so they stand out from the numbered stops.
function Pin({ color, label, glow }: { color: string; label: string; glow?: boolean }) {
  return (
    <div className="relative h-7 w-7 cursor-pointer rounded-full border-[3px] border-white" style={{ background: color, boxShadow: glow ? `0 0 0 8px ${color}66, 0 0 34px 8px ${color}` : `0 0 0 7px ${color}55, 0 0 22px ${color}` }}>
      {glow && <span className="absolute -inset-[3px] animate-ping rounded-full" style={{ background: color }} />}
      <span className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-wider text-white shadow-lg" style={{ background: color }}>
        {label}
      </span>
    </div>
  );
}

const GREEN = "#22c55e";
const RED = "#ef4444";

const ksiDim = { ...ksiDots, paint: { ...("paint" in ksiDots ? ksiDots.paint : {}), "circle-opacity": 0.3, "circle-stroke-opacity": 0.3 } } as LayerProps;

// A hidden layer stays mounted but is neither drawn nor clickable.
const shown = (l: LayerProps, on: boolean) => ({ ...l, layout: { ...("layout" in l ? l.layout : {}), visibility: on ? "visible" : "none" } }) as LayerProps;

export default function TourMap({ tour, story, cinematic, picking, startPt, endPt, onPick, step, onStep, layerVis = { streets: true, hin: true, flood: true, ksi: true }, showCompare = true, ride = false, onRideStop, onRideProgress, onRideEnd }: { layerVis?: LayerVis; showCompare?: boolean; ride?: boolean; onRideStop?: (i: number) => void; onRideProgress?: (p: number) => void; onRideEnd?: () => void; tour: Tour | null; story: Story; cinematic: boolean; picking: boolean; startPt: LatLng | null; endPt: LatLng | null; onPick: (p: LatLng) => void; step: number | null; onStep: (n: number | null) => void }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [hazards, setHazards] = useState<{ hin: GeoJSON.FeatureCollection; flood: GeoJSON.FeatureCollection; ksi?: GeoJSON.FeatureCollection } | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [photos, setPhotos] = useState<GeoJSON.FeatureCollection | null>(null);
  const [crash, setCrash] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [shot, setShot] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [arrowReady, setArrowReady] = useState(false);
  // Once the viewer grabs the map, the story camera stops steering until the next tour / narration.
  const userHasCamera = useRef(false);
  const riding = useRef(false); // ride mode drives the car dot itself, so the lap animation leaves it alone
  // The popup follows `step` (0 = the start pin, then each numbered stop), shared with the step bar in MapPanel.
  const stops: Stop[] = tour ? navStops(tour) : [];
  const ids = ["origin", ...stops.map((s) => s.id)];
  const selectedId = step == null ? null : (ids[step] ?? null);
  const setSelectedId = (id: string | null) => onStep(id == null ? null : ids.indexOf(id));
  const selected: Stop | null = stops.find((s) => s.id === selectedId) ?? null;
  const dest = stops.find((s) => s.id === tour?.dest_id) ?? null;
  const start = tour?.path.coordinates[0];
  const end = dest ? tour?.path.coordinates.at(-1) : undefined; // where the drawn path stops; the destination block's own midpoint is a little past it
  const under = segments ? "segments" : COMPARE; // where the hazard and photo layers go: just below the scenic-score streets
  const routeData = useMemo<GeoJSON.Feature | GeoJSON.FeatureCollection>(() => (tour ? { type: "Feature", properties: {}, geometry: tour.path } : EMPTY), [tour]);
  const compare = saferCompare(tour);
  const standardData = useMemo<GeoJSON.Feature | GeoJSON.FeatureCollection>(() => (compare ? { type: "Feature", properties: {}, geometry: compare.path } : EMPTY), [compare]);
  const avoidedData = compare?.avoided_hin ?? EMPTY;
  const comparing = !!compare && showCompare;

  // The avoided high-injury pieces pulse, so the eye finds them.
  useEffect(() => {
    if (!comparing || reducedMotion()) return;
    let raf = 0;
    const pulse = (now: number) => {
      const map = mapRef.current?.getMap();
      if (map?.getLayer("avoided-glow")) map.setPaintProperty("avoided-glow", "line-opacity", 0.2 + 0.4 * (0.5 + 0.5 * Math.sin(now / 320)));
      raf = requestAnimationFrame(pulse);
    };
    raf = requestAnimationFrame(pulse);
    return () => cancelAnimationFrame(raf);
  }, [comparing]);

  // Static layers, fetched once. Either failing just leaves that layer off; the map still renders.
  useEffect(() => {
    getServiceArea().then(setArea).catch((e) => console.warn("service area:", e));
    getHazards().then(setHazards).catch((e) => console.warn("hazards:", e));
    getPhotos().then(setPhotos).catch((e) => console.warn("photos:", e));
  }, []);

  // The scenic heat map shows the scores the current tour was built from (Street View AI or popular online).
  const scoreSource = tour?.source ?? "photo";
  useEffect(() => {
    getSegments(scoreSource).then(setSegments).catch((e) => console.warn("segments:", e));
  }, [scoreSource]);

  // New tour: establishing shot, the route draws itself in, then the car keeps lapping the loop.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!tour || !map) return;
    userHasCamera.current = false;
    const reduce = reducedMotion();
    overview(map, tour, reduce ? 0 : 2600);
    const walk = pathWalker(tour.path.coordinates);
    const t0 = performance.now();
    let raf = 0;
    let done = false;
    const frame = (now: number) => {
      const e = now - t0;
      const p = reduce ? 1 : Math.min(1, e / DRAW_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      if (!done && map.getLayer("route")) {
        const cut = p >= 1 ? 1.01 : eased;
        for (const [id, a, b] of ROUTE_COLORS) map.setPaintProperty(id, "line-gradient", drawn(cut, a, b));
        done = p >= 1;
      }
      const carAt = p < 1 ? eased : ((e - DRAW_MS) / LAP_MS) % 1;
      if (!riding.current) (map.getSource("car") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: walk(carAt) } });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tour]);

  // Ride mode: the car drives the tour once with the camera riding behind it, turning with the street; the panel shows
  // each stop as the car reaches it (onRideStop gets its index in navStops). Stopping or finishing flies back to the overview.
  const rideCb = useRef<{ stop?: (i: number) => void; progress?: (p: number) => void; end?: () => void }>({});
  useEffect(() => {
    rideCb.current = { stop: onRideStop, progress: onRideProgress, end: onRideEnd };
  });
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!ride || !tour || !map) return;
    riding.current = true;
    userHasCamera.current = true; // the ride owns the camera; the story camera stays out of its way
    const coords = tour.path.coordinates;
    const walk = pathWalker(coords);
    const at = stopFractions(coords, navStops(tour));
    const dur = Math.min(40000, Math.max(20000, tour.summary.distance_km * 3000)); // about 3 s per km, 20-40 s in all
    const t0 = performance.now();
    let raf = 0;
    let shown = -2;
    let heading: number | null = null;
    let reported = 0;
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const [x, y] = walk(p);
      const [ax, ay] = walk(Math.min(1, p + 0.012));
      const target = (Math.atan2((ax - x) * Math.cos((y * Math.PI) / 180), ay - y) * 180) / Math.PI;
      heading = heading == null ? target : heading + ((((target - heading) % 360) + 540) % 360 - 180) * 0.06; // ease into turns
      (map.getSource("car") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [x, y] } });
      map.jumpTo({ center: [x, y], bearing: heading, pitch: 62, zoom: 16.4 });
      const i = at.reduce((k, f, j) => (f <= p + 0.004 ? j : k), -1);
      if (i !== shown) {
        shown = i;
        rideCb.current.stop?.(i);
      }
      if (now - reported > 150) {
        reported = now;
        rideCb.current.progress?.(p);
      }
      if (p >= 1) {
        rideCb.current.end?.();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      riding.current = false;
      userHasCamera.current = false;
      try {
        overview(map, tour, reducedMotion() ? 0 : 1800);
      } catch {} // the map may already be gone (page change)
    };
  }, [ride, tour]);

  // Step bar moved: bring that stop into view.
  useEffect(() => {
    const map = mapRef.current;
    if (step == null || !tour || !map) return;
    const s = navStops(tour)[step - 1];
    const at = step === 0 ? tour.path.coordinates[0] : s?.id === tour.dest_id ? tour.path.coordinates.at(-1) : s && [s.lng, s.lat];
    if (at) map.easeTo({ center: at as [number, number], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  }, [step, tour]);

  // Hand the camera back to the story whenever a new narration starts playing.
  useEffect(() => {
    if (cinematic) userHasCamera.current = false;
  }, [cinematic]);

  // Story camera: fly to each place as it is named, then drift slowly around it. Back to the overview after.
  const storyKey = story?.key ?? null;
  const storyAt = story?.place.at;
  const storyName = story?.place.name ?? "";
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || userHasCamera.current) return;
    const reduce = reducedMotion();
    if (storyKey && storyAt) {
      const bearing = angleFor(storyName);
      map.flyTo({ center: storyAt, zoom: 16.3, pitch: 62, bearing, duration: reduce ? 0 : 3200, curve: 1.6, essential: true });
      if (reduce) return;
      const drift = () => {
        if (!userHasCamera.current) map.rotateTo(bearing + 28, { duration: 14000, easing: (t) => t });
      };
      map.once("moveend", drift);
      return () => {
        map.off("moveend", drift);
      };
    }
    if (!storyKey && !cinematic && tour) overview(map, tour, reduce ? 0 : 2400);
  }, [storyKey, storyAt, storyName, cinematic, tour]);

  // Click a street -> the frame nearest the click (overlapping two-way pieces are both hit; pick by distance).
  const onMapClick = (e: MapLayerMouseEvent) => {
    if (picking) {
      if (inArea(area, e.lngLat.lng, e.lngLat.lat)) onPick({ lat: e.lngLat.lat, lng: e.lngLat.lng }); // outside the area: ignored
      return;
    }
    const dot = e.features?.find((f) => f.layer.id === "ksi"); // a crash dot wins over the street photo under it
    if (dot) {
      const [lng, lat] = (dot.geometry as GeoJSON.Point).coordinates;
      setShot(null);
      setCrash({ lng, lat, p: dot.properties ?? {} });
      return;
    }
    setCrash(null);
    const d = (p: { lat?: unknown; lng?: unknown }) => Math.hypot((Number(p.lng) - e.lngLat.lng) * Math.cos((e.lngLat.lat * Math.PI) / 180), Number(p.lat) - e.lngLat.lat);
    const best = e.features?.filter((f) => f.layer.id === "photos-hit").map((f) => f.properties ?? {}).sort((a, b) => d(a) - d(b))[0];
    setShot(best ? { lng: e.lngLat.lng, lat: e.lngLat.lat, p: best } : null);
  };
  const takeCamera = () => {
    userHasCamera.current = true;
  };

  return (
    <Map
      ref={mapRef}
      interactiveLayerIds={["ksi", "photos-hit"]}
      onClick={onMapClick}
      onLoad={(e) => { addArrowImage(e); setArrowReady(true); }}
      cursor={picking ? "crosshair" : undefined}
      onDragStart={takeCamera}
      onWheel={takeCamera}
      onTouchStart={takeCamera}
      initialViewState={{ ...MIAMI, zoom: 12 }}
      maxPitch={70}
      mapStyle={DARK_STYLE}
      style={{ width: "100%", height: "100%" }}
      attributionControl={{ compact: true }}
    >
      <Layer {...buildings3d} />
      <Source id="route" type="geojson" data={routeData} lineMetrics>
        <Layer {...routeGlow} />
        <Layer {...routeCasing} />
        <Layer {...routeLine} />
        {arrowReady && <Layer {...routeArrows} />}
      </Source>
      <Source id="car" type="geojson" data={EMPTY}>
        <Layer {...carGlow} />
        <Layer {...carDot} />
      </Source>
      <Source id="standard-route" type="geojson" data={standardData}>
        <Layer {...shown(standardLine, comparing)} beforeId={TOP} />
      </Source>
      <Source id="avoided" type="geojson" data={avoidedData}>
        <Layer {...shown(avoidedGlow, comparing)} beforeId={TOP} />
        <Layer {...shown(avoidedLine, comparing)} beforeId={TOP} />
      </Source>
      {area && (
        <Source id="area" type="geojson" data={area}>
          <Layer {...areaFill} beforeId={COMPARE} />
          <Layer {...areaLine} beforeId={COMPARE} />
        </Source>
      )}
      {/* The scenic-score streets are mounted first and everything else sits below them ("under"), whichever dataset loads first,
          so the ~2,600 crash dots and the photo lines can't cover the green-to-gray streets. */}
      {segments && (
        <Source id="segments" type="geojson" data={segments}>
          <Layer {...shown(segmentsLine, layerVis.streets)} beforeId={COMPARE} />
        </Source>
      )}
      {hazards && (
        <>
          <Source id="flood" type="geojson" data={hazards.flood}>
            <Layer {...shown(floodFill, layerVis.flood)} beforeId={under} />
          </Source>
          <Source id="hin" type="geojson" data={hazards.hin}>
            <Layer {...shown(hinLine, layerVis.hin)} beforeId={under} />
          </Source>
          {hazards.ksi && (
            <Source id="ksi" type="geojson" data={hazards.ksi}>
              {/* dimmed while a tour is on the map, so the route and what it avoided stand out */}
              <Layer {...shown(tour ? ksiDim : ksiDots, layerVis.ksi)} beforeId={under} />
            </Source>
          )}
        </>
      )}
      {photos && (
        <Source id="photos" type="geojson" data={photos}>
          <Layer {...photosLine} beforeId={under} />
          <Layer {...photosHit} beforeId={under} />
        </Source>
      )}
      {!tour && startPt && (
        <Marker longitude={startPt.lng} latitude={startPt.lat} anchor="center" style={{ zIndex: 10 }}>
          <Pin color={GREEN} label="START" />
        </Marker>
      )}
      {!tour && endPt && (
        <Marker longitude={endPt.lng} latitude={endPt.lat} anchor="center" style={{ zIndex: 10 }}>
          <Pin color={RED} label="END" glow />
        </Marker>
      )}
      {tour && start && (
        <Marker longitude={start[0]} latitude={start[1]} anchor="center" style={{ zIndex: 10 }} onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedId("origin"); }}>
          <Pin color={GREEN} label="START" />
        </Marker>
      )}
      {dest && end && (
        <Marker longitude={end[0]} latitude={end[1]} anchor="center" style={{ zIndex: 10 }} onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedId(dest.id); }}>
          <Pin color={RED} label="END" glow />
        </Marker>
      )}
      {stops.map((s, i) => s === dest ? null : (
        <Marker key={s.id} longitude={s.lng} latitude={s.lat} anchor="center" onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedId(s.id); }}>
          <div
            className="anim-rise grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-[#0e1628] bg-cyan-400 text-[12px] font-extrabold text-[#0e1628] shadow-[0_0_12px_rgba(34,211,238,0.6)] transition hover:scale-110"
            style={{ animationDelay: `${1.2 + i * 0.12}s` }}
          >
            {i + 1}
          </div>
        </Marker>
      ))}
      {selectedId === "origin" && start && tour?.origin && (
        <Popup longitude={start[0]} latitude={start[1]} anchor="bottom" offset={22} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <div className="space-y-1.5 text-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API */}
            {tour.origin.photo && <img src={media(tour.origin.photo)!} alt="" className="w-full rounded-lg" />}
            <div className="text-[15px] font-bold"><span className="mr-1.5 text-green-300">Start ·</span>{tour.origin.street || "Unnamed block"}</div>
          </div>
        </Popup>
      )}
      {story?.place.at && (
        <Marker key={story.key} longitude={story.place.at[0]} latitude={story.place.at[1]} anchor="center">
          <div className="pointer-events-none relative grid place-items-center">
            <span className="pulse-ring absolute h-10 w-10 rounded-full border-2 border-cyan-300" />
            <span className="pulse-ring absolute h-10 w-10 rounded-full border-2 border-cyan-300" style={{ animationDelay: "0.9s" }} />
            <span className="h-4 w-4 rounded-full border-2 border-white bg-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.9)]" />
          </div>
        </Marker>
      )}
      {selected && (
        <Popup longitude={selected === dest && end ? end[0] : selected.lng} latitude={selected === dest && end ? end[1] : selected.lat} anchor="bottom" offset={selected === dest ? 22 : 18} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <div className="space-y-1.5 text-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API, not worth next/image config */}
            {media(selected.photo) && <img src={media(selected.photo)!} alt="" className="w-full rounded-lg" />}
            <div className="text-[15px] font-bold">{selected === dest && <span className="mr-1.5 text-red-300">End ·</span>}{selected.street || "Unnamed block"}</div>
            <div className="text-[13px] text-cyan-300">{selected.score}/10 · {selected.tags.join(", ") || "no tags"}</div>
            <div className="text-[13px] text-slate-300">{selected.why}</div>
            {selected.place && <div className="text-[13px] text-slate-400">Near {selected.place.name} ({selected.place.rating}★)</div>}
          </div>
        </Popup>
      )}
      {crash && (
        <Popup longitude={crash.lng} latitude={crash.lat} anchor="bottom" offset={10} onClose={() => setCrash(null)} maxWidth="240px">
          <div className="space-y-1 text-slate-100">
            <div className="text-[15px] font-bold" style={{ color: crash.p.fatal ? "#f87171" : "#fb923c" }}>{crash.p.fatal ? "Fatal crash" : "Serious-injury crash"}</div>
            <div className="text-[13px] text-slate-300">{crash.p.year}{crash.p.ped ? " · pedestrian involved" : ""}</div>
            <div className="text-[12px] text-slate-400">Killed or seriously injured, FDOT Signal Four. Location approximate.</div>
          </div>
        </Popup>
      )}
      {shot && (
        <Popup longitude={shot.lng} latitude={shot.lat} anchor="bottom" offset={12} onClose={() => setShot(null)} maxWidth="300px">
          <div className="space-y-1.5 text-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API */}
            <img src={media(String(shot.p.photo))!} alt="" className="w-full rounded-lg" />
            <div className="text-[15px] font-bold">{shot.p.street || "Unnamed block"}</div>
            <div className="text-[12px] text-slate-400">Street View{shot.p.date ? ` · ${shot.p.date}` : ""} · {shot.p.copyright ?? "© Google"}</div>
          </div>
        </Popup>
      )}
      <NavigationControl position="bottom-right" visualizePitch />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
