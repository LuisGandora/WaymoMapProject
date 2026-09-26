"use client";

import { useEffect, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapLayerMouseEvent, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { getHazards, getPhotos, getSegments, getServiceArea, media, type Stop, type Tour } from "../lib/api";

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
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "ped"], 1], 2.5, 1.5], 15, ["case", ["==", ["get", "ped"], 1], 5, 3.5]],
    "circle-color": ["case", ["==", ["get", "fatal"], 1], "#fb7185", "#f97316"],
    "circle-opacity": 0.6,
  },
};
const routeCasing: LayerProps = { id: "route-casing", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0e1628", "line-width": 9 } };
const routeLine: LayerProps = { id: "route", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#22d3ee", "line-width": 5 } };

export default function TourMap({ tour }: { tour: Tour | null }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [hazards, setHazards] = useState<{ hin: GeoJSON.FeatureCollection; flood: GeoJSON.FeatureCollection; ksi?: GeoJSON.FeatureCollection } | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [photos, setPhotos] = useState<GeoJSON.FeatureCollection | null>(null);
  const [shot, setShot] = useState<{ lng: number; lat: number; p: Record<string, string | number | null> } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Derived, so a new tour drops the old popup without any state reset.
  const selected: Stop | null = tour?.stops.find((s) => s.id === selectedId) ?? null;

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

  // Click a street -> the frame nearest the click (overlapping two-way pieces are both hit; pick by distance).
  const onMapClick = (e: MapLayerMouseEvent) => {
    const d = (p: { lat?: unknown; lng?: unknown }) => Math.hypot((Number(p.lng) - e.lngLat.lng) * Math.cos((e.lngLat.lat * Math.PI) / 180), Number(p.lat) - e.lngLat.lat);
    const best = e.features?.map((f) => f.properties ?? {}).sort((a, b) => d(a) - d(b))[0];
    setShot(best ? { lng: e.lngLat.lng, lat: e.lngLat.lat, p: best } : null);
  };

  return (
    <Map
      ref={mapRef}
      interactiveLayerIds={["photos-hit"]}
      onClick={onMapClick}
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
          {hazards.ksi && (
            <Source id="ksi" type="geojson" data={hazards.ksi}>
              <Layer {...ksiDots} />
            </Source>
          )}
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
      {tour && (
        <Source id="route" type="geojson" data={{ type: "Feature", properties: {}, geometry: tour.path }}>
          <Layer {...routeCasing} />
          <Layer {...routeLine} />
        </Source>
      )}
      {tour?.stops.map((s, i) => (
        <Marker key={s.id} longitude={s.lng} latitude={s.lat} anchor="center" onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedId(s.id); }}>
          <div className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-[#0e1628] bg-cyan-400 text-[12px] font-extrabold text-[#0e1628] shadow-[0_0_12px_rgba(34,211,238,0.6)]">
            {i + 1}
          </div>
        </Marker>
      ))}
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
      <NavigationControl position="bottom-right" />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
