"use client";

import { useEffect, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapEvent, type MapLayerMouseEvent, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { getHazards, getPhotos, getSegments, getServiceArea, media, navStops, type LatLng, type Stop, type Tour } from "../lib/api";

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
const routeCasing: LayerProps = { id: "route-casing", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0e1628", "line-width": 9 } };
const routeLine: LayerProps = { id: "route", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#22d3ee", "line-width": 5 } };

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

export default function TourMap({ tour, picking, startPt, endPt, onPick, step, onStep }: { tour: Tour | null; picking: boolean; startPt: LatLng | null; endPt: LatLng | null; onPick: (p: LatLng) => void; step: number | null; onStep: (n: number | null) => void }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [hazards, setHazards] = useState<{ hin: GeoJSON.FeatureCollection; flood: GeoJSON.FeatureCollection; ksi?: GeoJSON.FeatureCollection } | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [photos, setPhotos] = useState<GeoJSON.FeatureCollection | null>(null);
  const [crash, setCrash] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [shot, setShot] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [arrowReady, setArrowReady] = useState(false);
  // The popup follows `step` (0 = the start pin, then each numbered stop), shared with the step bar in MapPanel.
  const stops: Stop[] = tour ? navStops(tour) : [];
  const ids = ["origin", ...stops.map((s) => s.id)];
  const selectedId = step == null ? null : (ids[step] ?? null);
  const setSelectedId = (id: string | null) => onStep(id == null ? null : ids.indexOf(id));
  const selected: Stop | null = stops.find((s) => s.id === selectedId) ?? null;
  const dest = stops.find((s) => s.id === tour?.dest_id) ?? null;
  const start = tour?.path.coordinates[0];
  const end = dest ? tour?.path.coordinates.at(-1) : undefined; // where the drawn path stops; the destination block's own midpoint is a little past it

  // Static layers, fetched once. Either failing just leaves that layer off; the map still renders.
  useEffect(() => {
    getServiceArea().then(setArea).catch((e) => console.warn("service area:", e));
    getHazards().then(setHazards).catch((e) => console.warn("hazards:", e));
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

  // Step bar moved: bring that stop into view.
  useEffect(() => {
    const map = mapRef.current;
    if (step == null || !tour || !map) return;
    const s = navStops(tour)[step - 1];
    const at = step === 0 ? tour.path.coordinates[0] : s?.id === tour.dest_id ? tour.path.coordinates.at(-1) : s && [s.lng, s.lat];
    if (at) map.easeTo({ center: at as [number, number], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  }, [step, tour]);

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

  return (
    <Map
      ref={mapRef}
      interactiveLayerIds={["ksi", "photos-hit"]}
      onClick={onMapClick}
      onLoad={(e) => { addArrowImage(e); setArrowReady(true); }}
      cursor={picking ? "crosshair" : undefined}
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
      {hazards && (
        <>
          <Source id="flood" type="geojson" data={hazards.flood}>
            <Layer {...floodFill} />
          </Source>
          <Source id="hin" type="geojson" data={hazards.hin}>
            <Layer {...hinLine} />
          </Source>
        </>
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
      {hazards?.ksi && (
        <Source id="ksi" type="geojson" data={hazards.ksi}>
          <Layer {...ksiDots} />
        </Source>
      )}
      {tour && (
        <Source id="route" type="geojson" data={{ type: "Feature", properties: {}, geometry: tour.path }}>
          <Layer {...routeCasing} />
          <Layer {...routeLine} />
          {arrowReady && <Layer {...routeArrows} />}
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
          <div className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-[#0e1628] bg-cyan-400 text-[12px] font-extrabold text-[#0e1628] shadow-[0_0_12px_rgba(34,211,238,0.6)]">
            {i + 1}
          </div>
        </Marker>
      ))}
      {selectedId === "origin" && start && tour?.origin && (
        <Popup longitude={start[0]} latitude={start[1]} anchor="bottom" offset={22} onClose={() => setSelectedId(null)} closeButton={false} maxWidth="280px">
          <div className="space-y-1.5 text-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API */}
            <img src={media(tour.origin.photo)!} alt="" className="w-full rounded-lg" />
            <div className="text-[15px] font-bold"><span className="mr-1.5 text-green-300">Start ·</span>{tour.origin.street || "Unnamed block"}</div>
          </div>
        </Popup>
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
      <NavigationControl position="bottom-right" />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
