"use client";

import dynamic from "next/dynamic";
import { highlights, type Tour } from "../lib/api";
import type { Story } from "./NarrationPlayer";

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
export default function MapPanel({
  tour,
  loading,
  error,
  story = null,
  cinematic = false,
}: {
  tour: Tour | null;
  loading: boolean;
  error: string | null;
  story?: Story;
  cinematic?: boolean;
}) {
  const pill = loading
    ? "Building your tour…"
    : error
      ? `Couldn't build tour: ${error}`
      : tour
        ? `${highlights(tour).length} highlights · ${tour.summary.distance_km} km · ${tour.summary.drive_minutes} min`
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
      <TourMap tour={tour} story={story} cinematic={cinematic} />

      {/* Cinema mode while the narration plays: letterbox bars + vignette slide in, and retract after. */}
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-hidden>
        <div
          className={`absolute inset-0 transition-opacity duration-1000 ${cinematic ? "opacity-100" : "opacity-0"}`}
          style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(3,7,18,0.75) 100%)" }}
        />
        <div className={`absolute inset-x-0 top-0 h-[7vh] bg-black transition-transform duration-1000 [transition-timing-function:var(--ease-cine)] ${cinematic ? "translate-y-0" : "-translate-y-full"}`} />
        <div className={`absolute inset-x-0 bottom-0 h-[7vh] bg-black transition-transform duration-1000 [transition-timing-function:var(--ease-cine)] ${cinematic ? "translate-y-0" : "translate-y-full"}`} />
      </div>

      {/* Title card for the place being narrated, re-animated for each new place. */}
      {story && (
        <div key={story.key} className="pointer-events-none absolute bottom-[calc(7vh+28px)] right-16 z-10 max-w-[46%] text-right">
          <p className="anim-title text-[12px] font-semibold uppercase tracking-[0.3em] text-cyan-300/90">{story.label}</p>
          <p className="anim-title mt-1 text-[clamp(26px,3.2vw,44px)] font-extrabold leading-[1.05] tracking-tight text-white [text-shadow:0_4px_30px_rgba(0,0,0,0.8)]" style={{ animationDelay: "0.12s" }}>
            {story.place.name}
          </p>
          <div className="anim-sweep ml-auto mt-3 h-[3px] w-28 origin-right rounded-full bg-gradient-to-l from-cyan-300 to-blue-500" />
          <p className="anim-title mt-3 text-[15px] text-slate-200 [text-shadow:0_2px_12px_rgba(0,0,0,0.9)]" style={{ animationDelay: "0.3s" }}>
            {story.kicker}
          </p>
        </div>
      )}

      <div
        className={`pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded-full border px-5 py-2.5 text-[14px] shadow-lg backdrop-blur ${
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
