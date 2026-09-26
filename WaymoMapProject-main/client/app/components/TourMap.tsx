"use client";

import { useEffect, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Popup, ScaleControl, Source, type LayerProps, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { getSegments, getServiceArea, media, type Stop, type Tour } from "../lib/api";

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
const routeCasing: LayerProps = { id: "route-casing", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0e1628", "line-width": 9 } };
const routeLine: LayerProps = { id: "route", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#22d3ee", "line-width": 5 } };

export default function TourMap({ tour }: { tour: Tour | null }) {
  const mapRef = useRef<MapRef>(null);
  const [area, setArea] = useState<GeoJSON.Feature | null>(null);
  const [segments, setSegments] = useState<GeoJSON.FeatureCollection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Derived, so a new tour drops the old popup without any state reset.
  const selected: Stop | null = tour?.stops.find((s) => s.id === selectedId) ?? null;

  // Static layers, fetched once. Either failing just leaves that layer off; the map still renders.
  useEffect(() => {
    getServiceArea().then(setArea).catch((e) => console.warn("service area:", e));
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

  return (
    <Map
      ref={mapRef}
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
      <NavigationControl position="bottom-right" />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
