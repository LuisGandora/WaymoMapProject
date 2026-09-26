"use client";

import dynamic from "next/dynamic";
import type { Tour } from "../lib/api";

const TourMap = dynamic(() => import("./TourMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[15px] text-slate-500">
      <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
      Loading map…
    </div>
  ),
});

// Right-hand panel: the map plus a status pill (idle / building / error / tour summary).
export default function MapPanel({ tour, loading, error }: { tour: Tour | null; loading: boolean; error: string | null }) {
  const pill = loading
    ? "Building your tour…"
    : error
      ? `Couldn't build tour: ${error}`
      : tour
        ? `${tour.summary.stops} stops · ${tour.summary.distance_km} km · ${tour.summary.drive_minutes} min`
        : "Select options and generate to map your tour";
  const sf = tour?.summary.safety;
  const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${n}${unit}`;
  const safetyLine = sf
    ? `Safety ${sf.grade} ${sf.score}/100 · ${sf.hin_km} km high-injury · ${sf.calm_pct}% calm streets` +
      (sf.ksi_vs_area != null ? ` · crash rate ${sf.ksi_vs_area}× area avg` : "") +
      (sf.vs_default ? ` · vs standard: ${signed(sf.vs_default.hin_km, " km")} high-injury, ${signed(sf.vs_default.score)} pts, ${signed(sf.vs_default.minutes, " min")}` : "") +
      (sf.flood_alert ? " · FLOOD ALERT: avoiding flood zones" : "")
    : null;
  return (
    <div className="relative h-full w-full">
      <TourMap tour={tour} />
      <div
        className={`pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full border px-5 py-2.5 text-[14px] shadow-lg backdrop-blur ${
          error ? "border-red-500/60 bg-red-950/80 text-red-200" : "border-slate-700/70 bg-[#0e1628]/85 text-slate-300"
        }`}
      >
        {loading && <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400 align-middle" />}
        {pill}
        {safetyLine && <div className="mt-1 text-[12px] text-emerald-300">{safetyLine}</div>}
      </div>
    </div>
  );
}
