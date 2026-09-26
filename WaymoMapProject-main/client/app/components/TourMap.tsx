"use client";

import Map, { NavigationControl, ScaleControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

export const MIAMI = { latitude: 25.7617, longitude: -80.1918 };

// Free CARTO dark basemap, no API key needed.
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Browser-only (MapLibre touches `window`); MapPanel loads this with next/dynamic + ssr: false.
// Later layers (service area polygon, scored segments, route line, stop markers) go inside <Map> as <Source>/<Layer>/<Marker>.
export default function TourMap() {
  return (
    <Map
      initialViewState={{ ...MIAMI, zoom: 12.5 }}
      mapStyle={DARK_STYLE}
      style={{ width: "100%", height: "100%" }}
      attributionControl={{ compact: true }}    >
      <NavigationControl position="bottom-right" />
      <ScaleControl position="bottom-left" unit="imperial" />
    </Map>
  );
}
