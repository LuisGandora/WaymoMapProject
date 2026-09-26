"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { LatLng, Tour } from "../lib/api";

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
export default function MapPanel({ tour, loading, error, picking, custom, onPick }: { tour: Tour | null; loading: boolean; error: string | null; picking: boolean; custom: LatLng | null; onPick: (p: LatLng) => void }) {
  const pill = picking
    ? "Click inside the dashed service area to set your start"
    : loading
    ? "Building your tour…"
    : error
      ? `Couldn't build tour: ${error}`
      : tour
        ? `${tour.summary.stops} stops · ${tour.summary.distance_km} km · ${tour.summary.drive_minutes} min`
        : custom
          ? "Start set. Generate to map your tour"
          : "Select options and generate to map your tour";
  // Which stop the slider is on (0 = start, last = destination). Keyed to the tour so a new tour resets it.
  const [at, setAt] = useState<{ id?: string; n: number | null }>({ n: null });
  const step = at.id === tour?.id ? at.n : null;
  const setStep = (n: number | null) => setAt({ id: tour?.id, n });
  const last = tour?.stops.length ?? 0;
  const here = step == null || !tour ? null : step === 0 ? tour.origin : tour.stops[step - 1];
  return (
    <div className="relative h-full w-full">
      <TourMap tour={tour} picking={picking} custom={custom} onPick={onPick} step={step} onStep={setStep} />
      {tour && last > 0 && (
        <div className="absolute bottom-10 left-1/2 w-[min(560px,80%)] -translate-x-1/2 rounded-2xl border border-slate-700/70 bg-[#0e1628]/90 px-5 py-3 shadow-lg backdrop-blur">
          <div className="mb-2 flex items-center justify-between gap-3 text-[13px] text-slate-300">
            <button onClick={() => setStep(Math.max(0, (step ?? 0) - 1))} disabled={!step} className="rounded-lg border border-slate-700 px-2.5 py-1 disabled:opacity-30">◀</button>
            <span className="truncate text-center">
              {here == null ? "Slide to step through the route" : `${step === 0 ? "Start" : step === last ? "End" : `Stop ${step} of ${last - 1}`} · ${here.street || "Unnamed block"}`}
            </span>
            <button onClick={() => setStep(Math.min(last, (step ?? -1) + 1))} disabled={step === last} className="rounded-lg border border-slate-700 px-2.5 py-1 disabled:opacity-30">▶</button>
          </div>
          <input type="range" min={0} max={last} step={1} value={step ?? 0} onChange={(e) => setStep(Number(e.target.value))} className="w-full accent-cyan-400" aria-label="Step through the route" />
        </div>
      )}
      <div
        className={`pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full border px-5 py-2.5 text-[14px] shadow-lg backdrop-blur ${
          error ? "border-red-500/60 bg-red-950/80 text-red-200" : "border-slate-700/70 bg-[#0e1628]/85 text-slate-300"
        }`}
      >
        {loading && <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400 align-middle" />}
        {pill}
      </div>
    </div>
  );
}
