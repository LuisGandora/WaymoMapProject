"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { highlights, leg, media, narrateSpot, navStops, saferCompare, type LayerVis, type LatLng, type Tour } from "../lib/api";
import Legend from "./Legend";
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
  const [layerVis, setLayerVis] = useState<LayerVis>({ streets: true, hin: true, flood: true, ksi: true }); // road-safety layers the legend switches on and off
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
  // The intro script names landmarks; only fly to (and title-card) the ones near this tour, never across town
  // (e.g. the "landmarks" script's South Beach while the tour is in Wynwood). About 2 km, in degrees.
  const nearTour = (at?: [number, number]) => !tour || !at || tour.path.coordinates.some(([x, y]) => Math.hypot((x - at[0]) * 0.9, y - at[1]) < 0.02);
  const shownStory = story && nearTour(story.place.at) ? story : null;
  const sf = tour?.summary.safety;
  const vd = sf?.vs_default;
  const cmp = saferCompare(tour);
  // The Safer Route card: only when Safer Route actually took the tour off high-injury road compared with the standard route.
  const saferCard = sf && vd && cmp && vd.hin_km < 0 ? { sf, vd, cmp } : null;
  const [showCompare, setShowCompare] = useState(true);
  const timeCost = (m: number) =>
    m === 0 ? "same time" : Math.abs(m) < 1 ? `${Math.round(Math.abs(m) * 60)} s ${m < 0 ? "faster" : "longer"}` : `${Math.abs(m)} min ${m < 0 ? "faster" : "longer"}`;
  const safetyLine = sf
    ? `Safety ${sf.grade} ${sf.score}/100 · ${sf.hin_km} km high-injury · ${sf.calm_pct}% calm streets` +
      (sf.flood_alert ? (tour?.safe ? " · Flood alert: avoiding flood zones" : " · Flood alert in effect") : "")
    : null;

  // Ride mode (TourMap drives the car and the camera): which stop the car last reached, and how far along it is.
  // Keyed to the tour, so a new tour or Exit ends the ride.
  const [ride, setRide] = useState<{ id: string; stop: number; p: number } | null>(null);
  const riding = !!tour && ride?.id === tour.id;
  const rideStop = ride && riding && ride.stop >= 0 ? nav[ride.stop] : null;
  const rideSafety = cmp ? `Safer Route: steering clear of ${cmp.corridors.join(" · ")} (high-injury corridors)` : sf ? `Safety ${sf.grade} ${sf.score}/100 · ${sf.calm_pct}% calm streets` : null;
  function startRide() {
    if (!tour) return;
    onSpotPlay?.(); // stop the intro narration: the ride has the screen now
    setStep(null);
    setRide({ id: tour.id, stop: -1, p: 0 });
  }
  return (
    <div className="relative h-full w-full">
      <Legend vis={layerVis} onToggle={(k) => setLayerVis((v) => ({ ...v, [k]: !v[k] }))} hidden={cinematic} />
      <TourMap
        layerVis={layerVis}
        showCompare={showCompare}
        tour={tour}
        story={shownStory}
        cinematic={cinematic}
        picking={!!picking}
        startPt={startPt}
        endPt={endPt}
        onPick={onPick}
        step={step}
        onStep={setStep}
        ride={riding}
        onRideStop={(i) => setRide((r) => r && { ...r, stop: i })}
        onRideProgress={(p) => setRide((r) => r && { ...r, p })}
        onRideEnd={() => setRide(null)}
      />

      {/* Cinema mode while the narration plays: letterbox bars + vignette slide in, and retract after. */}
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-hidden>
        <div
          className={`absolute inset-0 transition-opacity duration-1000 ${cinematic ? "opacity-100" : "opacity-0"}`}
          style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(3,7,18,0.75) 100%)" }}
        />
        <div className={`absolute inset-x-0 top-0 h-[7vh] bg-black transition-transform duration-1000 [transition-timing-function:var(--ease-cine)] ${cinematic ? "translate-y-0" : "-translate-y-full"}`} />
        <div className={`absolute inset-x-0 bottom-0 h-[7vh] bg-black transition-transform duration-1000 [transition-timing-function:var(--ease-cine)] ${cinematic ? "translate-y-0" : "translate-y-full"}`} />
      </div>

      {/* Safer Route card: what this tour avoided compared with the same request with Safer Route off (the gray dashed route). */}
      {saferCard && !cinematic && !riding && (
        <div key={tour?.id} className="anim-rise absolute right-4 top-24 z-10 w-[300px] rounded-2xl border border-emerald-500/40 bg-[#0e1628]/92 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur">
          <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-emerald-300">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            Safer Route
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="whitespace-nowrap text-[34px] font-extrabold leading-none tracking-tight text-white">{Math.abs(saferCard.vd.hin_km).toFixed(1)} km</span>
            <span className="text-[13px] leading-tight text-slate-300">less driving on high-injury corridors</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
            <div className="rounded-xl bg-slate-800/60 px-3 py-2">
              <div className="text-[11px] text-slate-400">Safety score</div>
              <div className="font-bold text-slate-100">
                {saferCard.sf.score - saferCard.vd.score} → <span className="text-emerald-300">{saferCard.sf.score}</span>
              </div>
            </div>
            <div className="rounded-xl bg-slate-800/60 px-3 py-2">
              <div className="text-[11px] text-slate-400">Time</div>
              <div className="font-bold text-slate-100">{timeCost(saferCard.vd.minutes)}</div>
            </div>
          </div>
          {saferCard.cmp.corridors.length > 0 && (
            <p className="mt-3 text-[12px] leading-snug text-slate-300">
              Skips {saferCard.cmp.corridors.join(" · ")}
              {saferCard.cmp.avoided_ksi > 0 && `: ${saferCard.cmp.avoided_ksi} serious or fatal crashes there since 2019`}
            </p>
          )}
          <div className="mt-3 space-y-1 text-[11px] text-slate-400">
            <div className="flex items-center gap-2"><span className="inline-block w-5 shrink-0 border-t-[3px] border-dashed border-slate-400" />Standard route (Safer Route off)</div>
            <div className="flex items-center gap-2"><span className="inline-block h-1 w-5 shrink-0 rounded bg-red-400 shadow-[0_0_8px_#ef4444]" />High-injury road it would drive</div>
          </div>
          <button onClick={() => setShowCompare((v) => !v)} className="mt-3 w-full rounded-lg border border-slate-700 py-1.5 text-[12px] text-slate-300 hover:border-emerald-400/60">
            {showCompare ? "Hide" : "Show"} standard route
          </button>
        </div>
      )}

      {/* Title card for the place being narrated, re-animated for each new place. */}
      {shownStory && (
        <div key={shownStory.key} className="pointer-events-none absolute bottom-[calc(7vh+28px)] right-16 z-10 max-w-[46%] text-right">
          <p className="anim-title text-[12px] font-semibold uppercase tracking-[0.3em] text-cyan-300/90">{shownStory.label}</p>
          <p className="anim-title mt-1 text-[clamp(26px,3.2vw,44px)] font-extrabold leading-[1.05] tracking-tight text-white [text-shadow:0_4px_30px_rgba(0,0,0,0.8)]" style={{ animationDelay: "0.12s" }}>
            {shownStory.place.name}
          </p>
          <div className="anim-sweep ml-auto mt-3 h-[3px] w-28 origin-right rounded-full bg-gradient-to-l from-cyan-300 to-blue-500" />
          <p className="anim-title mt-3 text-[15px] text-slate-200 [text-shadow:0_2px_12px_rgba(0,0,0,0.9)]" style={{ animationDelay: "0.3s" }}>
            {shownStory.kicker}
          </p>
        </div>
      )}

      {/* Ride mode: the stop the car just reached (photo + why), and the ride bar with what Safer Route is steering around. */}
      {riding && rideStop && (
        <div key={rideStop.id} className="anim-rise absolute left-6 top-24 z-20 w-[min(340px,40%)] overflow-hidden rounded-2xl border border-cyan-500/30 bg-[#0e1628]/92 shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API */}
          {rideStop.photo && <img src={media(rideStop.photo)!} alt="" className="h-[170px] w-full object-cover" />}
          <div className="p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-300">
              {rideStop.id === tour?.dest_id ? "Destination" : `Stop ${(ride?.stop ?? 0) + 1} of ${tour?.dest_id ? last - 1 : last}`}
            </p>
            <p className="mt-1 text-[20px] font-extrabold leading-tight text-white">{rideStop.street || "Unnamed block"}</p>
            {/* popular stops say which places earned them; a photo stop lets its photo speak (its "why" is only the score template) */}
            {tour?.source === "popular" && <p className="mt-1.5 text-[13px] leading-snug text-slate-300">{rideStop.why}</p>}
            {rideStop.photo && <p className="mt-1.5 text-[11px] text-slate-500">Street View · © Google</p>}
          </div>
        </div>
      )}
      {riding && ride && (
        <div className="absolute bottom-10 left-1/2 z-20 w-[min(620px,86%)] -translate-x-1/2 rounded-2xl border border-cyan-500/30 bg-[#0e1628]/92 px-5 py-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
              Riding
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" style={{ width: `${Math.round(ride.p * 100)}%` }} />
            </div>
            <button onClick={() => setRide(null)} className="rounded-lg border border-slate-700 px-3 py-1 text-[12px] text-slate-200 hover:border-red-400/60 hover:text-red-300">
              ■ Stop
            </button>
          </div>
          {rideSafety && <p className="mt-2 truncate text-[12px] text-emerald-300">🛡 {rideSafety}</p>}
        </div>
      )}

      {tour && last > 0 && !riding && (
        <div className="absolute bottom-10 left-1/2 z-10 w-[min(560px,80%)] -translate-x-1/2 rounded-2xl border border-slate-700/70 bg-[#0e1628]/90 px-5 py-3 shadow-lg backdrop-blur">
          <button
            onClick={startRide}
            className="mb-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-[14px] font-bold text-white shadow-[0_6px_18px_rgba(6,182,212,0.3)] transition hover:brightness-110"
          >
            ▶ Ride the tour
          </button>
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
