"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createTour, getConfig, type LatLng, type Tour } from "../lib/api";
import MapPanel from "./MapPanel";
import NarrationPlayer, { useNarration } from "./NarrationPlayer";

// ids must match Server/app/config.py (MOODS / MATRIX_MOODS, LANGS, HOODS) — GET /config returns the live list.
export const MOODS = [
  { id: "murals+sunset", label: "Murals & Sunset" },
  { id: "murals", label: "Street Art & Murals" },
  { id: "food", label: "Cuban Food & Cafés" },
  { id: "historic", label: "Historic Miami" },
  { id: "art_deco", label: "Art Deco" },
  { id: "water", label: "Waterfront" },
  { id: "surprise", label: "Surprise me" },
] as const;

export const LANGUAGES = [
  { id: "es", label: "Spanish" },
  { id: "en", label: "English" },
  { id: "pt", label: "Portuguese" },
] as const;

export const STARTS = [
  { id: "wynwood", label: "Wynwood" },
  { id: "little_havana", label: "Little Havana" },
] as const;

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 30;
// Time budgets offered: what Wynwood's scored blocks fill cleanly (a 30-min loop already uses every mural block).
export const DURATIONS = [10, 15, 20, 30] as const;

export type TourSettings = {
  mood: (typeof MOODS)[number]["id"];
  language: (typeof LANGUAGES)[number]["id"];
  start: (typeof STARTS)[number]["id"];
  minutes: number; // MIN_MINUTES..MAX_MINUTES
  safe: boolean;
};

const icon = "h-5 w-5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]";

function Label({ children, glyph }: { children: ReactNode; glyph: ReactNode }) {
  return (
    <label className="mb-3 flex items-center gap-2.5 text-[17px] text-slate-100">
      <span className="text-cyan-400">{glyph}</span>
      {children}
    </label>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-[62px] w-full cursor-pointer appearance-none rounded-2xl border border-slate-700/70 bg-[#060b18] px-5 pr-12 text-[17px] text-slate-100 outline-none transition focus:border-cyan-400/70"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} className="bg-[#0b1224]">
            {o.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 24 24" className={`${icon} pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-slate-300`}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

// "Pick on map" / "Clear" buttons for a start or destination the user sets by clicking the map.
function PickRow({ kind, picking, set, onToggle, onClear }: { kind: "start" | "end"; picking: "start" | "end" | null; set: boolean; onToggle: () => void; onClear: () => void }) {
  const active = picking === kind;
  const tone = kind === "start" ? "border-green-400/80 bg-green-500/15 text-green-300" : "border-red-400/80 bg-red-500/15 text-red-300";
  return (
    <div className="mt-3 flex gap-3">
      <button
        onClick={onToggle}
        className={`h-11 flex-1 rounded-xl border text-[15px] transition ${active ? tone : "border-slate-700/70 bg-[#060b18] text-slate-200 hover:border-slate-500"}`}
      >
        {active ? "Click the map… (cancel)" : set ? `Change ${kind === "start" ? "start" : "destination"}` : `Pick ${kind === "start" ? "start" : "destination"} on map`}
      </button>
      {set && (
        <button onClick={onClear} className="h-11 rounded-xl border border-slate-700/70 bg-[#060b18] px-4 text-[15px] text-slate-300 hover:border-slate-500">
          Clear
        </button>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [settings, setSettings] = useState<TourSettings>({ mood: "murals+sunset", language: "es", start: "wynwood", minutes: 15, safe: true });
  const [tour, setTour] = useState<Tour | null>(null);
  const [startPt, setStartPt] = useState<LatLng | null>(null); // start / destination picked on the map (inside the service area)
  const [endPt, setEndPt] = useState<LatLng | null>(null);
  const [picking, setPicking] = useState<"start" | "end" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TourSettings>(k: K, v: TourSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  // Only offer moods / starts the backend has real scored blocks for (GET /config). The lists above are the labels;
  // Wynwood alone has no waterfront or art deco, so those stay hidden until another neighborhood is scored.
  const [avail, setAvail] = useState<{ moods: string[]; starts: string[] } | null>(null);
  useEffect(() => {
    getConfig()
      .then((c) => {
        setAvail({ moods: c.moods, starts: c.starts });
        // If the current pick isn't offered, move to the first one that is.
        setSettings((s) => ({
          ...s,
          mood: c.moods.includes(s.mood) ? s.mood : (MOODS.find((m) => c.moods.includes(m.id))?.id ?? s.mood),
          start: c.starts.includes(s.start) ? s.start : (STARTS.find((h) => c.starts.includes(h.id))?.id ?? s.start),
        }));
      })
      .catch((e) => console.warn("config:", e));
  }, []);
  const moods = avail ? MOODS.filter((m) => avail.moods.includes(m.id)) : MOODS;
  const starts = avail ? STARTS.filter((h) => avail.starts.includes(h.id)) : STARTS;

  // ElevenLabs intro narration (app/api/narrate). Started before any await so the click still counts for autoplay.
  const narration = useNarration();
  const [voice, setVoice] = useState(true);

  // Leave the current route: back to the empty map (and stop any narration).
  function exitRoute() {
    narration.stop();
    setTour(null);
    setError(null);
  }

  // rank 0 = the best-ranked route; Skip asks for the next one of the SAME tour (its own mood/minutes/start/safe, even if the
  // sliders moved since) and doesn't replay the intro narration.
  async function generate(rank = 0) {
    if (rank === 0 && voice) narration.start(settings.mood, settings.language);
    const of = rank > 0 && tour ? { mood: tour.mood, minutes: tour.minutes, start: tour.start, safe: !!tour.safe } : {};
    setLoading(true);
    setError(null);
    try {
      setTour(
        await createTour({
          ...settings,
          ...of,
          rank,
          ...(startPt && { start_lat: startPt.lat, start_lng: startPt.lng }),
          ...(endPt && { end_lat: endPt.lat, end_lng: endPt.lng }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#030712] text-slate-100">
      <aside className="flex w-1/4 min-w-[360px] shrink-0 flex-col border-r border-slate-800/60 bg-[#0e1628]">
        <header className="flex items-center gap-4 border-b border-slate-800/70 px-8 py-8">
          <div className="grid h-[58px] w-[58px] place-items-center rounded-2xl border border-cyan-500/20 bg-[#0c2a3a] text-cyan-400">
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
              <circle cx="7" cy="17" r="2" />
              <path d="M9 17h6" />
              <circle cx="17" cy="17" r="2" />
            </svg>
          </div>
          <div>
            <h1 className="text-[30px] font-extrabold leading-none tracking-tight">
              Waymo <span className="text-cyan-400">Haven</span>
            </h1>
            <p className="mt-2 text-[15px] font-medium tracking-[0.08em] text-slate-300">AUTONOMOUS CITY TOURS</p>
          </div>
        </header>

        <div className="stagger flex-1 space-y-10 overflow-y-auto px-8 py-10">
          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                  <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                  <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                  <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z" />
                </svg>
              }
            >
              Tour Mood
            </Label>
            <Select value={settings.mood} options={moods} onChange={(v) => set("mood", v)} />
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
                </svg>
              }
            >
              Narration Language
            </Label>
            <Select value={settings.language} options={LANGUAGES} onChange={(v) => set("language", v)} />
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              }
            >
              Start From
            </Label>
            <Select value={settings.start} options={starts} onChange={(v) => { set("start", v); setStartPt(null); }} />
            <PickRow
              kind="start"
              picking={picking}
              set={!!startPt}
              onToggle={() => setPicking((p) => (p === "start" ? null : "start"))}
              onClear={() => { setStartPt(null); setTour(null); }}
            />
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <path d="M4 22V4M4 4h13l-2 4 2 4H4" />
                </svg>
              }
            >
              Destination
            </Label>
            <PickRow
              kind="end"
              picking={picking}
              set={!!endPt}
              onToggle={() => setPicking((p) => (p === "end" ? null : "end"))}
              onClear={() => { setEndPt(null); setTour(null); }}
            />
            <p className="mt-2 text-[13px] text-slate-400">
              {endPt ? "One-way tour: start to your destination, past scenic blocks on the way." : "Not set: a loop of the most scenic blocks that fits your time budget, back to where you started."}
            </p>
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              }
            >
              Time Budget
            </Label>
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Time budget in minutes">
              {DURATIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={settings.minutes === m}
                  onClick={() => set("minutes", m)}
                  className={`flex-1 rounded-xl border py-2 text-center text-[17px] font-bold transition ${
                    settings.minutes === m ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-300" : "border-slate-700/70 bg-[#060b18] text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {m} min
                </button>
              ))}
            </div>
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              }
            >
              Safer Route
            </Label>
            <button
              type="button"
              onClick={() => set("safe", !settings.safe)}
              className={`flex h-[62px] w-full items-center justify-between rounded-2xl border px-5 text-left transition ${
                settings.safe ? "border-emerald-400/70 bg-emerald-500/10" : "border-slate-700/70 bg-[#060b18] hover:border-slate-500"
              }`}
            >
              <span className="text-[14px] leading-tight text-slate-300">Avoid high-injury corridors, big arterials, live closures, flood zones in storms</span>
              <span className={`ml-4 rounded-full px-3 py-1 text-[13px] font-bold ${settings.safe ? "bg-emerald-400 text-[#0e1628]" : "bg-slate-700 text-slate-200"}`}>
                {settings.safe ? "ON" : "OFF"}
              </span>
            </button>
          </section>

          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <path d="M11 5 6 9H2v6h4l5 4V5z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
                </svg>
              }
            >
              Voice Narration
            </Label>
            <button
              type="button"
              onClick={() => {
                if (voice) narration.stop();
                setVoice(!voice);
              }}
              className={`flex h-[62px] w-full items-center justify-between rounded-2xl border px-5 text-left transition ${
                voice ? "border-cyan-400/70 bg-cyan-500/10" : "border-slate-700/70 bg-[#060b18] hover:border-slate-500"
              }`}
            >
              <span className="text-[14px] leading-tight text-slate-300">A spoken intro, plus a voice for each spot you reach, in the narration language</span>
              <span className={`ml-4 rounded-full px-3 py-1 text-[13px] font-bold ${voice ? "bg-cyan-400 text-[#0e1628]" : "bg-slate-700 text-slate-200"}`}>
                {voice ? "ON" : "OFF"}
              </span>
            </button>
          </section>
        </div>

        <footer className="border-t border-slate-800/70 px-8 py-8">
          {tour && (
            <div className="mb-4 rounded-2xl border border-slate-700/70 bg-[#060b18] px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] text-slate-300">
                  {(tour.options ?? 1) > 1 ? (
                    <>
                      Route <b className="text-cyan-300">{(tour.rank ?? 0) + 1}</b> of {tour.options}
                      <span className="block text-[12px] text-slate-500">best scenery for the quickest trip first</span>
                    </>
                  ) : (
                    <>
                      Your route
                      <span className="block text-[12px] text-slate-500">{tour.dest_id ? "one-way to your destination" : "the only route for these settings"}</span>
                    </>
                  )}
                </span>
                {(tour.options ?? 1) > 1 && (
                  <button
                    onClick={() => generate(((tour.rank ?? 0) + 1) % tour.options!)}
                    disabled={loading}
                    className="h-10 shrink-0 rounded-xl border border-cyan-400/60 bg-cyan-500/10 px-4 text-[14px] font-bold text-cyan-300 transition hover:bg-cyan-500/20 disabled:cursor-wait disabled:opacity-50"
                  >
                    Skip →
                  </button>
                )}
              </div>
              <button
                onClick={exitRoute}
                className="mt-3 h-9 w-full rounded-xl border border-slate-700/70 text-[13px] text-slate-300 transition hover:border-red-400/60 hover:text-red-300"
              >
                ✕ Exit route
              </button>
            </div>
          )}
          <button
            onClick={() => generate()}
            disabled={loading}
            className={`${loading ? "shimmer" : ""} relative flex h-[72px] w-full items-center overflow-hidden justify-center gap-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-[21px] font-bold text-white shadow-[0_10px_30px_rgba(6,182,212,0.3)] transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-80`}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M9.9 15.5A2 2 0 0 0 8.5 14.1L2.4 12.5a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" />
              <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
            </svg>
            {loading ? "Building…" : "Generate City Tour"}
          </button>
        </footer>
      </aside>

      <main className="relative flex-1 bg-[#030712] bg-[radial-gradient(rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:28px_28px]">
        <MapPanel
          tour={tour}
          loading={loading}
          error={error}
          story={narration.story}
          cinematic={narration.status === "playing"}
          language={settings.language}
          spotVoice={voice}
          onSpotPlay={narration.stop}
          picking={picking}
          startPt={startPt}
          endPt={endPt}
          onPick={(p) => {
            if (picking === "start") setStartPt(p);
            else setEndPt(p);
            setPicking(null);
            setTour(null);
            setError(null);
          }}
        />
        <NarrationPlayer n={narration} />
      </main>
    </div>
  );
}
