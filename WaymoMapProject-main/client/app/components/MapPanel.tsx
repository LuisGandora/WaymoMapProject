"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { highlights, leg, media, narrateSpot, navStops, type LatLng, type Tour } from "../lib/api";
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

// What each color and shape on the map means. Colors match the layers in TourMap.tsx.
function Legend() {
  const row = "flex items-center gap-2.5";
  const dot = (bg: string, size = 10, ring = false) => (
    <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: bg, boxShadow: ring ? `0 0 0 3px ${bg}66, 0 0 10px ${bg}` : undefined }} />
  );
  return (
    <details open className="pointer-events-auto absolute bottom-24 left-4 z-10 w-[230px] rounded-2xl border border-slate-700/70 bg-[#0e1628]/92 text-[12px] text-slate-300 shadow-lg backdrop-blur">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-bold text-slate-100">Legend</summary>
      <div className="space-y-1.5 px-4 pb-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Your tour</div>
        <div className={row}><span className="inline-block h-1 w-5 shrink-0 rounded bg-cyan-400" />Route, arrows show direction</div>
        <div className={row}>{dot("#22c55e", 12, true)}START</div>
        <div className={row}>{dot("#ef4444", 12, true)}END (destination)</div>
        <div className={row}><span className="grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full bg-cyan-400 text-[8px] font-extrabold text-[#0e1628]">1</span>Highlighted stop</div>
        <div className="pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Scenic score</div>
        <div className={row}><span className="inline-block h-1.5 w-5 shrink-0 rounded" style={{ background: "linear-gradient(90deg,#475569,#eab308,#22c55e)" }} />Low to high (streets)</div>
        <div className="pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Road safety</div>
        <div className={row}><span className="inline-block h-0 w-5 shrink-0 border-t-[3px] border-dashed border-red-500" />High-injury corridor</div>
        <div className={row}>{dot("#f97316")}Serious-injury crash</div>
        <div className={row}>{dot("#dc2626")}Fatal crash</div>
        <div className={row}>{dot("#f97316", 14)}Larger dot: pedestrian involved</div>
        <div className={row}><span className="inline-block h-3 w-5 shrink-0 rounded-sm bg-blue-500/40" />Flood zone</div>
        <div className="pt-1 text-[11px] text-slate-500">Crash dots: killed or seriously injured, FDOT Signal Four. Click one for details.</div>
      </div>
    </details>
  );
}

// Right-hand panel: the map plus a status pill (idle / building / error / tour summary).
export default function MapPanel({
  tour,
  loading,
  error,
  picking,
  startPt,
  endPt,
  onPick,
  story = null,
  cinematic = false,
  language = "en",
  spotVoice = false,
  onSpotPlay,
}: {
  tour: Tour | null;
  loading: boolean;
  error: string | null;
  picking: "start" | "end" | null;
  startPt: LatLng | null;
  endPt: LatLng | null;
  onPick: (p: LatLng) => void;
  story?: Story;
  cinematic?: boolean;
  language?: string;
  spotVoice?: boolean; // narrate each spot the rider steps to (one ElevenLabs call per spot, via the backend)
  onSpotPlay?: () => void; // a spot's voice is about to play: the caller stops any other narration
}) {
  // Step bar: 0 = the start, then each numbered stop, ending on the destination for a one-way tour.
  // Keyed to the tour so a new tour resets it.
  const [at, setAt] = useState<{ id?: string; n: number | null }>({ n: null });
  const step = at.id === tour?.id ? at.n : null;
  const setStep = (n: number | null) => setAt({ id: tour?.id, n });
  const nav = tour ? navStops(tour) : [];
  const stopId = step ? nav[step - 1]?.id : undefined; // step 0 is the start pin, which has no spot to narrate

  // Reaching a numbered stop (or the destination) asks the backend for that spot's own script and audio, then plays it.
  const spotAudio = useRef<HTMLAudioElement | null>(null);
  const [spot, setSpot] = useState<{ key: string; state: "loading" | "playing" | "ended" | "blocked" | "error"; msg?: string } | null>(null);
  const spotKey = spotVoice && tour && stopId ? `${tour.id}|${stopId}|${language}` : null;
  useEffect(() => {
    if (!spotKey || !tour || !stopId) return;
    const put = (state: "loading" | "playing" | "ended" | "blocked" | "error", msg?: string) => setSpot({ key: spotKey, state, msg });
    let stale = false;
    put("loading");
    narrateSpot(tour.id, stopId, language)
      .then((r) => {
        if (stale) return;
        const a = new Audio(media(r.audio)!);
        spotAudio.current = a;
        a.onended = () => put("ended");
        onSpotPlay?.();
        a.play().then(() => put("playing"), () => put("blocked"));
      })
      .catch((e) => !stale && put("error", e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
      spotAudio.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spotKey covers tour.id, stopId and language; onSpotPlay only stops the intro clip
  }, [spotKey]);
  const spotNow = spot && spot.key === spotKey ? spot : null;
  const last = nav.length;
  const startPos = tour ? { lat: tour.path.coordinates[0][1], lng: tour.path.coordinates[0][0] } : null;
  const endPos = tour ? { lat: tour.path.coordinates.at(-1)![1], lng: tour.path.coordinates.at(-1)![0] } : null;
  const pos = (i: number) => (i === 0 ? startPos! : nav[i - 1].id === tour?.dest_id ? endPos! : nav[i - 1]);
  const cur = step ?? 0;
  const next = tour && cur < last ? leg(pos(cur), pos(cur + 1)) : null;
  const here = step == null ? null : step === 0 ? "Start" : tour?.dest_id && nav[step - 1]?.id === tour.dest_id ? "Destination" : `Stop ${step} of ${tour?.dest_id ? last - 1 : last}`;
  const pill = picking
    ? `Click inside the dashed service area to set your ${picking === "start" ? "start" : "destination"}`
    : loading
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
      <Legend />
      <TourMap tour={tour} story={story} cinematic={cinematic} picking={!!picking} startPt={startPt} endPt={endPt} onPick={onPick} step={step} onStep={setStep} />

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

      {tour && last > 0 && (
        <div className="absolute bottom-10 left-1/2 z-10 w-[min(560px,80%)] -translate-x-1/2 rounded-2xl border border-slate-700/70 bg-[#0e1628]/90 px-5 py-3 shadow-lg backdrop-blur">
          <div className="mb-2 flex items-center justify-between gap-3 text-[13px] text-slate-300">
            <button onClick={() => setStep(Math.max(0, cur - 1))} disabled={!step} className="rounded-lg border border-slate-700 px-2.5 py-1 disabled:opacity-30">◀</button>
            <span className="truncate text-center">
              {here == null ? "Slide to step through the route" : `${here} · ${cur === 0 ? (tour.origin?.street ?? "start") : (nav[cur - 1].street || "Unnamed block")}`}
            </span>
            <button onClick={() => setStep(Math.min(last, (step ?? -1) + 1))} disabled={step === last} className="rounded-lg border border-slate-700 px-2.5 py-1 disabled:opacity-30">▶</button>
          </div>
          <input type="range" min={0} max={last} step={1} value={cur} onChange={(e) => setStep(Number(e.target.value))} className="w-full accent-cyan-400" aria-label="Step through the route" />
          <div className="mt-1.5 text-center text-[12px] text-cyan-300">
            {next ? `Head ${next.dir}, about ${next.km.toFixed(1)} km to ${nav[cur].street || "the next stop"}` : step != null ? "You've arrived" : ""}
          </div>
          {spotNow && (
            <div className={`mt-1 flex items-center justify-center gap-2 text-[12px] ${spotNow.state === "error" ? "text-red-300" : "text-slate-300"}`}>
              {spotNow.state === "loading" && <><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />Generating the voice for this spot…</>}
              {spotNow.state === "playing" && "Narrating this spot"}
              {spotNow.state === "error" && `No voice for this spot: ${spotNow.msg}`}
              {(spotNow.state === "blocked" || spotNow.state === "ended") && (
                <button onClick={() => spotAudio.current?.play().then(() => setSpot({ key: spotNow.key, state: "playing" }))} className="rounded-lg border border-slate-700 px-2.5 py-1 hover:border-cyan-400/60">
                  {spotNow.state === "ended" ? "▶ Replay" : "▶ Tap to listen"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div
        className={`pointer-events-none absolute left-1/2 top-6 z-[60] -translate-x-1/2 rounded-full border px-5 py-2.5 text-[14px] shadow-lg backdrop-blur ${
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
