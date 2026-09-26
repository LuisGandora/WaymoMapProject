"use client";

import dynamic from "next/dynamic";
import type { TourSettings } from "./Dashboard";

const TourMap = dynamic(() => import("./TourMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[15px] text-slate-500">
      <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
      Loading map…
    </div>
  ),
});

// Right-hand panel. `settings` = live sidebar selections; `requested` = settings captured when "Generate City Tour" was clicked (null until then).
export default function MapPanel({ requested }: { settings: TourSettings; requested: TourSettings | null }) {
  return (
    <div className="relative h-full w-full">
      <TourMap />
      {!requested && (
        <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full border border-slate-700/70 bg-[#0e1628]/85 px-5 py-2.5 text-[14px] text-slate-300 shadow-lg backdrop-blur">
          Select options and generate to map your tour
        </div>
      )}
    </div>
  );
}
