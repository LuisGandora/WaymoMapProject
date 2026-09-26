"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapLayerMouseEvent, type MapRef } from "react-map-gl/maplibre";
import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { highlights } from "../lib/api";
import { getHazards, getPhotos, getSegments, getServiceArea, media, type Stop, type Tour } from "../lib/api";
import type { Story } from "./NarrationPlayer";

export const MIAMI = { latitude: 25.7617, longitude: -80.1918 };

// Free CARTO dark basemap, no API key needed.
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Layer order = draw order. The route/car layers mount first and everything that loads later is inserted
// below them (beforeId), so the tour always sits on top: buildings < area/hazards/streets < route < car.
const TOP = "route-glow";

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
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "ped"], 1], 2.5, 1.5], 15, ["case", ["==", ["get", "ped"], 1], 5, 3.5]],
    "circle-color": ["case", ["==", ["get", "fatal"], 1], "#fb7185", "#f97316"],
    "circle-opacity": 0.6,
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

// Overview of the whole loop, tilted, leaving room for the narration card on the left.
function overview(map: MLMap, tour: Tour, duration: number) {
  const xs = tour.path.coordinates.map((c) => c[0]);
  const ys = tour.path.coordinates.map((c) => c[1]);
  const cam = map.cameraForBounds(
    [
      [Math.min(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.max(...ys)],
    ],
    { padding: { top: 110, bottom: 110, left: 460, right: 90 } },
  );
  if (!cam) return;
  map.flyTo({ ...cam, zoom: (cam.zoom ?? 13) - 0.2, pitch: 48, bearing: -18, duration, curve: 1.4, essential: true });
}

// A stable, slightly different angle per place so each shot feels composed rather than repeated.
const angleFor = (name: string) => ([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) % 70) - 35;

export default function TourMap({ tour, story, cinematic }: { tour: Tour | null; story: Story; cinematic: boolean }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [hazards, setHazards] = useState<{ hin: GeoJSON.FeatureCollection; flood: GeoJSON.FeatureCollection; ksi?: GeoJSON.FeatureCollection } | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [photos, setPhotos] = useState<GeoJSON.FeatureCollection | null>(null);
  const [shot, setShot] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Once the viewer grabs the map, the story camera stops steering until the next tour / narration.
  const userHasCamera = useRef(false);
  // Derived, so a new tour drops the old popup without any state reset.
  const stops: Stop[] = tour ? highlights(tour) : [];
  const selected: Stop | null = stops.find((s) => s.id === selectedId) ?? null;
  const routeData = useMemo<GeoJSON.Feature | GeoJSON.FeatureCollection>(() => (tour ? { type: "Feature", properties: {}, geometry: tour.path } : EMPTY), [tour]);

  // Static layers, fetched once. Either failing just leaves that layer off; the map still renders.
  useEffect(() => {
    getServiceArea().then(setArea).catch((e) => console.warn("service area:", e));
    getHazards().then(setHazards).catch((e) => console.warn("hazards:", e));
    getPhotos().then(setPhotos).catch((e) => console.warn("photos:", e));
    getSegments().then(setSegments).catch((e) => console.warn("segments:", e));
  }, []);

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
      (map.getSource("car") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: walk(carAt) } });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tour]);

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
    const d = (p: { lat?: unknown; lng?: unknown }) => Math.hypot((Number(p.lng) - e.lngLat.lng) * Math.cos((e.lngLat.lat * Math.PI) / 180), Number(p.lat) - e.lngLat.lat);
    const best = e.features?.map((f) => f.properties ?? {}).sort((a, b) => d(a) - d(b))[0];
    setShot(best ? { lng: e.lngLat.lng, lat: e.lngLat.lat, p: best } : null);
  };
  const takeCamera = () => {
    userHasCamera.current = true;
  };

  return (
    <Map
      ref={mapRef}
      interactiveLayerIds={["photos-hit"]}
      onClick={onMapClick}
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
      </Source>
      <Source id="car" type="geojson" data={EMPTY}>
        <Layer {...carGlow} />
        <Layer {...carDot} />
      </Source>
      {area && (
        <Source id="area" type="geojson" data={area}>
          <Layer {...areaFill} beforeId={TOP} />
          <Layer {...areaLine} beforeId={TOP} />
        </Source>
      )}
      {hazards && (
        <>
          <Source id="flood" type="geojson" data={hazards.flood}>
            <Layer {...floodFill} beforeId={TOP} />
          </Source>
          <Source id="hin" type="geojson" data={hazards.hin}>
            <Layer {...hinLine} beforeId={TOP} />
          </Source>
          {hazards.ksi && (
            <Source id="ksi" type="geojson" data={hazards.ksi}>
              <Layer {...ksiDots} beforeId={TOP} />
            </Source>
          )}
        </>
      )}
      {photos && (
        <Source id="photos" type="geojson" data={photos}>
          <Layer {...photosLine} beforeId={TOP} />
          <Layer {...photosHit} beforeId={TOP} />
        </Source>
      )}
      {segments && (
        <Source id="segments" type="geojson" data={segments}>
          <Layer {...segmentsLine} beforeId={TOP} />
        </Source>
      )}
      {stops.map((s, i) => (
        <Marker key={s.id} longitude={s.lng} latitude={s.lat} anchor="center" onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedId(s.id); }}>
          <div
            className="anim-rise grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-[#0e1628] bg-cyan-400 text-[12px] font-extrabold text-[#0e1628] shadow-[0_0_12px_rgba(34,211,238,0.6)] transition hover:scale-110"
            style={{ animationDelay: `${1.2 + i * 0.12}s` }}
          >
            {i + 1}
          </div>
        </Marker>
      ))}
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
        <Popup longitude={selected.lng} latitude={selected.lat} anchor="bottom" offset={18} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <div className="space-y-1.5 text-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API, not worth next/image config */}
            {media(selected.photo) && <img src={media(selected.photo)!} alt="" className="w-full rounded-lg" />}
            <div className="text-[15px] font-bold">{selected.street || "Unnamed block"}</div>
            <div className="text-[13px] text-cyan-300">{selected.score}/10 · {selected.tags.join(", ") || "no tags"}</div>
            <div className="text-[13px] text-slate-300">{selected.why}</div>
            {selected.place && <div className="text-[13px] text-slate-400">Near {selected.place.name} ({selected.place.rating}★)</div>}
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
