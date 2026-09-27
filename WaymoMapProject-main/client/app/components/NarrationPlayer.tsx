"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NARRATIONS, UI, pickNarrationId, placeCues, type Lang, type NarrationId, type Place } from "../lib/narration";

// The story camera starts moving slightly before a place is named, so it arrives as the word is spoken.
const CUE_LEAD = 0.02;

export type Story = { key: string; place: Place; kicker: string; label: string } | null;

// Tiny silent WAV. Playing it inside the click handler "unlocks" the audio element, so the real clip can autoplay
// once /api/narrate answers a few seconds later (Safari and mobile browsers otherwise block it).
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

type Status = "idle" | "loading" | "playing" | "paused" | "ended" | "blocked" | "error";

async function fetchClip(id: NarrationId, lang: Lang): Promise<string> {
  const r = await fetch("/api/narrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mood: id, language: lang }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `${r.status} ${r.statusText}`);
  return URL.createObjectURL(await r.blob());
}

// Owns one <audio> element for the whole dashboard. Call start() directly from a click handler (before any await).
export function useNarration() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const real = useRef(false); // false while the silent unlock clip is loaded, so its events are ignored
  const clips = useRef(new Map<string, string>()); // "id:lang" -> blob URL, so replays and repeats are free
  const req = useRef(0);
  const [status, setStatus] = useState<Status>("idle");
  const [current, setCurrent] = useState<{ id: NarrationId; lang: Lang } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState({ t: 0, d: 0 });
  // Web Audio tap for the audio-reactive equalizer. Only wired in once the context is running, because an element
  // routed through a suspended context plays silence.
  const ctx = useRef<AudioContext | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const wakeAudio = useCallback(() => {
    try {
      ctx.current ??= new AudioContext();
      void ctx.current.resume();
    } catch {}
  }, []);

  const tapAnalyser = useCallback(() => {
    const c = ctx.current;
    const a = audio.current;
    if (analyser || !c || !a || c.state !== "running") return;
    try {
      const node = c.createAnalyser();
      node.fftSize = 64;
      node.smoothingTimeConstant = 0.75;
      c.createMediaElementSource(a).connect(node);
      node.connect(c.destination);
      setAnalyser(node);
    } catch {}
  }, [analyser]);

  useEffect(() => {
    const a = new Audio();
    audio.current = a;
    const clipUrls = clips.current;
    const handlers: [string, () => void][] = [
      ["playing", () => setStatus("playing")],
      ["pause", () => setStatus((s) => (s === "playing" ? "paused" : s))],
      ["ended", () => setStatus("ended")],
      ["timeupdate", () => setTime({ t: a.currentTime, d: Number.isFinite(a.duration) ? a.duration : 0 })],
      ["loadedmetadata", () => setTime({ t: 0, d: Number.isFinite(a.duration) ? a.duration : 0 })],
    ];
    const bound = handlers.map(([ev, fn]) => [ev, () => real.current && fn()] as const);
    bound.forEach(([ev, fn]) => a.addEventListener(ev, fn));
    return () => {
      a.pause();
      bound.forEach(([ev, fn]) => a.removeEventListener(ev, fn));
      clipUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const start = useCallback((mood: string, lang: Lang) => {
    const a = audio.current;
    if (!a) return;
    const id = pickNarrationId(mood);
    const my = ++req.current;
    setCurrent({ id, lang });
    setError(null);
    setTime({ t: 0, d: 0 });
    setStatus("loading");
    real.current = false;
    a.pause();
    a.src = SILENCE;
    a.play().catch(() => {});
    wakeAudio();

    const key = `${id}:${lang}`;
    const cached = clips.current.get(key);
    (cached ? Promise.resolve(cached) : fetchClip(id, lang).then((u) => (clips.current.set(key, u), u)))
      .then((url) => {
        if (my !== req.current) return;
        real.current = true;
        tapAnalyser();
        a.src = url;
        return a.play().catch(() => setStatus("blocked"));
      })
      .catch((e) => {
        if (my !== req.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
  }, [wakeAudio, tapAnalyser]);

  const toggle = useCallback(() => {
    const a = audio.current;
    if (!a || !real.current) return;
    if (!a.paused) return a.pause();
    wakeAudio();
    if (a.ended) a.currentTime = 0;
    a.play().catch(() => setStatus("blocked"));
  }, [wakeAudio]);

  const replay = useCallback(() => {
    const a = audio.current;
    if (!a || !real.current) return;
    a.currentTime = 0;
    a.play().catch(() => setStatus("blocked"));
  }, []);

  const seek = useCallback((frac: number) => {
    const a = audio.current;
    if (a && real.current && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(1, frac)) * a.duration;
  }, []);

  const stop = useCallback(() => {
    req.current++;
    real.current = false;
    audio.current?.pause();
    setStatus("idle");
    setCurrent(null);
  }, []);

  const retry = useCallback(() => current && start(current.id, current.lang), [current, start]);

  // Story mode: which place the narration is talking about right now, for the camera and the title card.
  const cues = useMemo(() => (current ? placeCues(NARRATIONS[current.id], current.lang) : []), [current]);
  const progress = time.d ? time.t / time.d : status === "ended" ? 1 : 0;
  const live = status === "playing" || status === "paused";
  const activeIdx = live ? ([...cues].reverse().find((c) => c.frac - CUE_LEAD <= progress)?.i ?? null) : null;
  const story: Story =
    current && activeIdx !== null
      ? {
          key: `${current.id}:${activeIdx}`,
          place: NARRATIONS[current.id].places[activeIdx],
          kicker: NARRATIONS[current.id].places[activeIdx].kicker[current.lang],
          label: UI[current.lang].passing,
        }
      : null;

  const seekToPlace = useCallback(
    (i: number) => {
      const c = cues.find((x) => x.i === i);
      const a = audio.current;
      if (!c || !a || !real.current || !Number.isFinite(a.duration)) return;
      a.currentTime = Math.max(0, c.frac - CUE_LEAD / 2) * a.duration;
      if (a.paused) a.play().catch(() => setStatus("blocked"));
    },
    [cues],
  );

  return { status, current, error, time, start, toggle, replay, seek, stop, retry, analyser, cues, progress, activeIdx, story, seekToPlace };
}

export type NarrationControls = ReturnType<typeof useNarration>;

const ic = "fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]";
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Bars follow the real voice when the Web Audio tap is available; otherwise a looping CSS animation stands in.
function Equalizer({ active, analyser }: { active: boolean; analyser: AnalyserNode | null }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!analyser || !active || !box.current) return;
    const bars = [...box.current.children] as HTMLElement[];
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bins = [1, 2, 3, 5]; // ~0.7–3.5 kHz, where speech lives
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      bars.forEach((b, i) => (b.style.transform = `scaleY(${0.18 + (data[bins[i]] / 255) * 0.82})`));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      bars.forEach((b) => (b.style.transform = ""));
    };
  }, [analyser, active]);
  return (
    <span ref={box} className={`flex h-5 items-end gap-[3px] ${active ? "" : "eq-paused"}`} aria-hidden>
      {[0, 0.25, 0.1, 0.35].map((delay, i) => (
        <span
          key={i}
          className={`h-full w-[3px] rounded-full bg-current ${analyser ? "origin-bottom scale-y-30 transition-transform duration-75" : "eq-bar"}`}
          style={analyser ? undefined : { animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

// Karaoke-style transcript: words light up in step with playback (estimated by character position).
function Transcript({ text, progress, live }: { text: string; progress: number; live: boolean }) {
  const parts = text.split(/(\s+)/);
  const ends = parts.reduce<number[]>((acc, w) => [...acc, (acc.at(-1) ?? 0) + w.length], []);
  const at = progress * text.length;
  return (
    <p className="text-[14px] leading-relaxed">
      {parts.map((w, i) => {
        if (!w.trim()) return w;
        const end = ends[i];
        const start = end - w.length;
        const cls = !live ? "text-slate-400" : end <= at ? "text-slate-100" : start <= at ? "text-cyan-300" : "text-slate-500";
        return (
          <span key={i} className={`transition-colors duration-200 ${cls}`}>
            {w}
          </span>
        );
      })}
    </p>
  );
}

// Floating "now narrating" card over the map.
export default function NarrationPlayer({ n }: { n: NarrationControls }) {
  // Transcript starts closed on phones, where the open card would cover most of the map. Safe for hydration: the
  // card renders nothing until a narration starts.
  const [showText, setShowText] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches);
  if (!n.current) return null;
  const narr = NARRATIONS[n.current.id];
  const ui = UI[n.current.lang];
  const { status, time, progress } = n;
  const playing = status === "playing";
  const ready = status === "playing" || status === "paused" || status === "ended";
  const cued = new Map(n.cues.map((c) => [c.i, c.frac]));

  return (
    <div className="anim-rise absolute bottom-3 left-2 z-20 w-[400px] max-w-[calc(100%-1rem)] rounded-3xl border border-slate-700/70 bg-[#0e1628]/90 p-4 md:bottom-10 md:left-6 md:max-w-[calc(100%-3rem)] md:p-5 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-md">
      <div className="flex items-center gap-4">
        <div
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl border transition ${
            status === "error" ? "border-red-500/40 bg-red-950/60 text-red-300" : "border-cyan-500/30 bg-[#0c2a3a] text-cyan-400"
          } ${playing ? "shadow-[0_0_22px_rgba(34,211,238,0.35)]" : ""}`}
        >
          {status === "loading" ? (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-cyan-900 border-t-cyan-400" />
          ) : ready ? (
            <Equalizer active={playing} analyser={n.analyser} />
          ) : (
            <svg viewBox="0 0 24 24" className={`h-6 w-6 ${ic}`}>
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
            </svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-cyan-400">
            {status === "loading" ? ui.generating : ui.now} · {n.current.lang.toUpperCase()}
          </p>
          <p className="truncate text-[18px] font-bold text-slate-100">{narr.title[n.current.lang]}</p>
        </div>
        <button onClick={n.stop} aria-label="Close narration" className="rounded-full p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100">
          <svg viewBox="0 0 24 24" className={`h-5 w-5 ${ic}`}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {status === "error" ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-red-500/40 bg-red-950/50 px-4 py-3">
          <p className="text-[13px] text-red-200">{n.error}</p>
          <button onClick={n.retry} className="shrink-0 rounded-full bg-red-400/20 px-3 py-1.5 text-[13px] font-semibold text-red-100 hover:bg-red-400/30">
            {ui.retry}
          </button>
        </div>
      ) : status === "blocked" ? (
        <button
          onClick={n.toggle}
          className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-[16px] font-bold text-white shadow-[0_8px_24px_rgba(6,182,212,0.3)] hover:brightness-110"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
            <path d="M8 5v14l11-7z" />
          </svg>
          {ui.tap}
        </button>
      ) : (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={n.toggle}
            disabled={!ready}
            aria-label={playing ? "Pause" : "Play"}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 text-white shadow-[0_6px_18px_rgba(6,182,212,0.35)] transition hover:brightness-110 active:scale-95 disabled:opacity-40"
          >
            {playing ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-current">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <div className="flex-1">
            <div
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(time.d)}
              aria-valuenow={Math.round(time.t)}
              tabIndex={0}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                n.seek((e.clientX - r.left) / r.width);
              }}
              className={`relative h-2 cursor-pointer overflow-hidden rounded-full bg-slate-800 ${status === "loading" ? "animate-pulse" : ""}`}
            >
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
              {/* chapter marks: where each place is named */}
              {n.cues.map((c) => (
                <span
                  key={c.i}
                  className={`absolute top-0 h-full w-[3px] -translate-x-1/2 transition-colors ${progress >= c.frac ? "bg-white/80" : "bg-slate-500"}`}
                  style={{ left: `${c.frac * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[12px] tabular-nums text-slate-400">
              <span>{fmt(time.t)}</span>
              <span>{time.d ? fmt(time.d) : "–:––"}</span>
            </div>
          </div>
          <button
            onClick={n.replay}
            disabled={!ready}
            aria-label={ui.replay}
            title={ui.replay}
            className="rounded-full p-2 text-slate-300 transition hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className={`h-5 w-5 ${ic}`}>
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <button
            onClick={() => setShowText((v) => !v)}
            aria-label={ui.transcript}
            title={ui.transcript}
            aria-pressed={showText}
            className={`rounded-full p-2 transition hover:bg-slate-800 ${showText ? "text-cyan-300" : "text-slate-300"}`}
          >
            <svg viewBox="0 0 24 24" className={`h-5 w-5 ${ic}`}>
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M7 10h4M7 14h2M13 14h4M15 10h2" />
            </svg>
          </button>
        </div>
      )}

      {showText && status !== "error" && (
        <div className="mt-4 max-h-36 overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#060b18]/70 px-4 py-3">
          <Transcript text={narr.script[n.current.lang]} progress={progress} live={ready} />
        </div>
      )}

      <div className="mt-3 flex gap-2 overflow-x-auto [scrollbar-width:none] md:mt-4 md:flex-wrap md:overflow-visible">
        {narr.places.map((p, i) => {
          const active = n.activeIdx === i;
          const jumpable = cued.has(i) && ready;
          return (
            <button
              key={p.name}
              type="button"
              disabled={!jumpable}
              onClick={() => n.seekToPlace(i)}
              title={jumpable ? `${ui.jump}: ${p.blurb}` : p.blurb}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] transition duration-300 disabled:cursor-help ${
                active
                  ? "scale-105 border-cyan-400/80 bg-cyan-500/15 text-cyan-200 shadow-[0_0_14px_rgba(34,211,238,0.3)]"
                  : "border-slate-700/70 bg-[#060b18] text-slate-300 enabled:hover:border-cyan-400/50 enabled:hover:text-cyan-200"
              }`}
            >
              {active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />}
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
