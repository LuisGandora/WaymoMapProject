"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapEvent, type MapLayerMouseEvent, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { getPhotos, getSegments, getServiceArea, media, type LatLng, type Stop, type Tour } from "../lib/api";

export const MIAMI = { latitude: 25.7617, longitude: -80.1918 };

// Free CARTO dark basemap, no API key needed.
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Layer order = draw order: polygon under streets, streets under the route.
const areaFill: LayerProps = { id: "area-fill", type: "fill", paint: { "fill-color": "#22d3ee", "fill-opacity": 0.04 } };
const areaLine: LayerProps = { id: "area-line", type: "line", paint: { "line-color": "#22d3ee", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.8 } };
const segmentsLine: LayerProps = {
  id: "segments",
  type: "line",
  paint: {
    "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 15, 4],
    "line-opacity": 0.85,
    // green = scenic, gray = not. Unscored streets aren't in segments.json at all.
    "line-color": ["interpolate", ["linear"], ["get", "score"], 1, "#475569", 5, "#eab308", 10, "#22c55e"],
  },
};
// Streets that have a Street View frame (scored or not). Thin line for looks, wide invisible one so streets are easy to click.
const photosLine: LayerProps = { id: "photos", type: "line", paint: { "line-color": "#94a3b8", "line-width": 1.5, "line-opacity": 0.5 } };
const photosHit: LayerProps = { id: "photos-hit", type: "line", paint: { "line-width": 16, "line-opacity": 0 } };
// Direction arrows repeated along the route; the "arrow" image is drawn in onLoad (no asset file needed).
const routeArrows: LayerProps = {
  id: "route-arrows",
  type: "symbol",
  layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "arrow", "icon-size": 0.55, "icon-allow-overlap": true, "icon-rotation-alignment": "map" },
};
const routeCasing: LayerProps = { id: "route-casing", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0e1628", "line-width": 9 } };
const routeLine: LayerProps = { id: "route", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#22d3ee", "line-width": 5 } };

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

// Big glowing start (green) / end (red) pin with a label, so they stand out from the numbered stops.
function Pin({ color, label }: { color: string; label: string }) {
  return (
    <div className="relative h-7 w-7 cursor-pointer rounded-full border-[3px] border-white" style={{ background: color, boxShadow: `0 0 0 7px ${color}55, 0 0 22px ${color}` }}>
      <span className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-wider text-white shadow-lg" style={{ background: color }}>
        {label}
      </span>
    </div>
  );
}

// One popup body for stops, start/end and street clicks: photo, title, score line, description.
function Card({ photo, street, score, tags, why, badge, foot }: { photo?: string | null; street?: string; score?: number | null; tags?: string[]; why?: string; badge?: string; foot?: ReactNode }) {
  return (
    <div className="space-y-1.5 text-slate-100">
      {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API, not worth next/image config */}
      {media(photo) && <img src={media(photo)!} alt="" className="w-full rounded-lg" />}
      <div className="text-[15px] font-bold">{badge && <span className="mr-1.5 text-cyan-300">{badge}</span>}{street || "Unnamed block"}</div>
      {score != null && <div className="text-[13px] text-cyan-300">{score}/10 · {tags?.join(", ") || "no tags"}</div>}
      {why && <div className="text-[13px] text-slate-300">{why}</div>}
      {foot}
    </div>
  );
}

export default function TourMap({ tour, picking, custom, onPick, step, onStep }: { tour: Tour | null; picking: boolean; custom: LatLng | null; onPick: (p: LatLng) => void; step: number | null; onStep: (n: number | null) => void }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [photos, setPhotos] = useState<GeoJSON.FeatureCollection | null>(null);
  const [shot, setShot] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [arrowReady, setArrowReady] = useState(false);
  // The popup follows `step` (0 = start pin, then each stop), shared with the slider in MapPanel.
  const ids = ["origin", ...(tour?.stops.map((s) => s.id) ?? [])];
  const selectedId = step == null ? null : (ids[step] ?? null);
  const setSelectedId = (id: string | null) => onStep(id == null ? null : ids.indexOf(id));
  // Derived, so a new tour drops the old popup without any state reset. "origin" is the start pin.
  const selected: Stop | null = tour?.stops.find((s) => s.id === selectedId) ?? null;
  const showOrigin = selectedId === "origin" && !!tour?.origin;
  const dest = tour?.origin ? (tour.stops.at(-1) ?? null) : null; // the last stop is the destination
  const start = tour?.path.coordinates[0];
  // Slider moved: bring that stop into view.
  useEffect(() => {
    const map = mapRef.current;
    if (step == null || !tour || !map) return;
    const at = step === 0 ? tour.path.coordinates[0] : [tour.stops[step - 1].lng, tour.stops[step - 1].lat];
    map.easeTo({ center: at as [number, number], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  }, [step, tour]);

  const pick = (id: string) => (e: { originalEvent: Event }) => { e.originalEvent.stopPropagation(); setSelectedId(id); };

  // Static layers, fetched once. Either failing just leaves that layer off; the map still renders.
  useEffect(() => {
    getServiceArea().then(setArea).catch((e) => console.warn("service area:", e));
    getPhotos().then(setPhotos).catch((e) => console.warn("photos:", e));
    getSegments().then(setSegments).catch((e) => console.warn("segments:", e));
  }, []);

  // New tour -> zoom to it.
  useEffect(() => {
    if (!tour || !mapRef.current) return;
    const xs = tour.path.coordinates.map((c) => c[0]);
    const ys = tour.path.coordinates.map((c) => c[1]);
    mapRef.current.fitBounds(
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
      { padding: 60, duration: 1200 },
    );
  }, [tour]);

  // Click a street -> the frame nearest the click (overlapping two-way pieces are both hit; pick by distance).
  const onMapClick = (e: MapLayerMouseEvent) => {
    if (picking) {
      if (inArea(area, e.lngLat.lng, e.lngLat.lat)) onPick({ lat: e.lngLat.lat, lng: e.lngLat.lng }); // outside the area: ignored
      return;
    }
    const d = (p: { lat?: unknown; lng?: unknown }) => Math.hypot((Number(p.lng) - e.lngLat.lng) * Math.cos((e.lngLat.lat * Math.PI) / 180), Number(p.lat) - e.lngLat.lat);
    const best = e.features?.map((f) => f.properties ?? {}).sort((a, b) => d(a) - d(b))[0];
    setShot(best ? { lng: e.lngLat.lng, lat: e.lngLat.lat, p: best } : null);
  };

  return (
    <Map
      ref={mapRef}
      interactiveLayerIds={["photos-hit"]}
      cursor={picking ? "crosshair" : undefined}
      onClick={onMapClick}
      onLoad={(e) => { addArrowImage(e); setArrowReady(true); }}
      initialViewState={{ ...MIAMI, zoom: 12 }}
      mapStyle={DARK_STYLE}
      style={{ width: "100%", height: "100%" }}
      attributionControl={{ compact: true }}
    >
      {area && (
        <Source id="area" type="geojson" data={area}>
          <Layer {...areaFill} />
          <Layer {...areaLine} />
        </Source>
      )}
      {photos && (
        <Source id="photos" type="geojson" data={photos}>
          <Layer {...photosLine} />
          <Layer {...photosHit} />
        </Source>
      )}
      {segments && (
        <Source id="segments" type="geojson" data={segments}>
          <Layer {...segmentsLine} />
        </Source>
      )}
      {tour && (
        <Source id="route" type="geojson" data={{ type: "Feature", properties: {}, geometry: tour.path }}>
          <Layer {...routeCasing} />
          <Layer {...routeLine} />
          {arrowReady && <Layer {...routeArrows} />}
        </Source>
      )}
      {tour?.stops.map((s, i) => s === dest ? null : (
        <Marker key={s.id} longitude={s.lng} latitude={s.lat} anchor="center" onClick={pick(s.id)}>
          <div className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-[#0e1628] bg-cyan-400 text-[12px] font-extrabold text-[#0e1628] shadow-[0_0_12px_rgba(34,211,238,0.6)]">
            {i + 1}
          </div>
        </Marker>
      ))}
      {custom && !tour && (
        <Marker longitude={custom.lng} latitude={custom.lat} anchor="center" style={{ zIndex: 10 }}>
          <Pin color="#22c55e" label="START" />
        </Marker>
      )}
      {tour?.origin && start && (
        <Marker longitude={start[0]} latitude={start[1]} anchor="center" style={{ zIndex: 10 }} onClick={pick("origin")}>
          <Pin color="#22c55e" label="START" />
        </Marker>
      )}
      {dest && (
        <Marker longitude={dest.lng} latitude={dest.lat} anchor="center" style={{ zIndex: 10 }} onClick={pick(dest.id)}>
          <Pin color="#ef4444" label="END" />
        </Marker>
      )}
      {showOrigin && tour?.origin && start && (
        <Popup longitude={start[0]} latitude={start[1]} anchor="bottom" offset={22} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <Card badge="Start ·" {...tour.origin} />
        </Popup>
      )}
      {selected && (
        <Popup longitude={selected.lng} latitude={selected.lat} anchor="bottom" offset={selected === dest ? 22 : 18} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <Card badge={selected === dest ? "End ·" : undefined} {...selected}
            foot={selected.place && <div className="text-[13px] text-slate-400">Near {selected.place.name} ({selected.place.rating}★)</div>} />
        </Popup>
      )}
      {shot && (
        <Popup longitude={shot.lng} latitude={shot.lat} anchor="bottom" offset={12} onClose={() => setShot(null)} maxWidth="300px">
          <Card photo={String(shot.p.photo)} street={String(shot.p.street)} score={shot.p.score == null ? null : Number(shot.p.score)}
            tags={typeof shot.p.tags === "string" ? JSON.parse(shot.p.tags) : []} why={String(shot.p.why ?? "")}
            foot={<div className="text-[12px] text-slate-400">Street View{shot.p.date ? ` · ${shot.p.date}` : ""} · {shot.p.copyright ?? "© Google"}</div>} />
        </Popup>
      )}
      <NavigationControl position="bottom-right" />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
