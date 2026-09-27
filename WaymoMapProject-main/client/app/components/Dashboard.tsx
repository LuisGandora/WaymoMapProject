"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createTour, getConfig, getHealth, type LatLng, type Source, type SourceOffer, type Tour } from "../lib/api";
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
  { id: "downtown", label: "Downtown" },
  { id: "brickell", label: "Brickell" },
  { id: "design_district", label: "Design District" },
  { id: "coconut_grove", label: "Coconut Grove" },
  { id: "coral_gables", label: "Coral Gables" },
] as const;

// Which intro story (lib/narration.ts) fits each start; Wynwood picks by mood as before.
const INTRO_BY_START: Partial<Record<string, string>> = {
  design_district: "wynwood", // street art next door
  little_havana: "food", // Calle Ocho, ventanitas, Versailles
  downtown: "landmarks", // Freedom Tower
  brickell: "museums", // the bayfront museums
  coconut_grove: "landmarks", // Vizcaya
  coral_gables: "landmarks", // the Biltmore
};

// Where the scenic scores come from (Server/app/tour.py SOURCES).
export const SOURCES: readonly { id: Source; label: string; hint: string }[] = [
  { id: "photo", label: "Street View AI", hint: "Blocks rated by AI from their Street View photos. Wynwood." },
  { id: "popular", label: "Popular online", hint: "Streets ranked by the places people map and read about online. All of Miami's service area." },
];

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
  source: Source;
};

const icon = "h-5 w-5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]";

function Label({ children, glyph }: { children: ReactNode; glyph: ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-2.5 text-[15px] text-slate-100 md:text-[16px]">
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
        className="h-[52px] w-full cursor-pointer appearance-none rounded-2xl border border-slate-700/70 bg-[#060b18] px-5 pr-12 text-[16px] text-slate-100 outline-none transition focus:border-cyan-400/70"
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
  const [settings, setSettings] = useState<TourSettings>({ mood: "murals+sunset", language: "es", start: "wynwood", minutes: 15, safe: true, source: "photo" });
  const [tour, setTour] = useState<Tour | null>(null);
  const [startPt, setStartPt] = useState<LatLng | null>(null); // start / destination picked on the map (inside the service area)
  const [endPt, setEndPt] = useState<LatLng | null>(null);
  const [picking, setPicking] = useState<"start" | "end" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TourSettings>(k: K, v: TourSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  // Only offer moods / starts the backend has real scored blocks for (GET /config). The lists above are the labels;
  // Wynwood alone has no waterfront or art deco, so those stay hidden until another neighborhood is scored.
  // Each scenery source offers its own starts, and the moods that work from each start (by_start).
  const [offers, setOffers] = useState<Partial<Record<Source, SourceOffer>> | null>(null);
  // Per-stop voices need the backend's narration keys; without them the step bar would show an error at every stop.
  const [spotReady, setSpotReady] = useState(false);
  useEffect(() => {
    getConfig()
      .then((c) => setOffers(c.sources ?? { photo: { moods: c.moods, starts: c.starts, by_start: {} } }))
      .catch((e) => console.warn("config:", e));
    getHealth()
      .then((h) => setSpotReady(h.narration))
      .catch(() => setSpotReady(false));
  }, []);
  const offer = offers?.[settings.source];
  const starts = offer ? STARTS.filter((h) => offer.starts.includes(h.id)) : STARTS;
  // What the tour is built with: the rider's picks, or the first offered start / mood when a pick isn't offered for this
  // source and start (e.g. no murals from Coral Gables). Worked out here rather than written back into settings.
  const start = starts.some((h) => h.id === settings.start) ? settings.start : (starts[0]?.id ?? settings.start);
  const moodIds = offer ? (offer.by_start[start] ?? offer.moods) : null;
  const moods = moodIds ? MOODS.filter((m) => moodIds.includes(m.id)) : MOODS;
  const mood = moods.some((m) => m.id === settings.mood) ? settings.mood : (moods[0]?.id ?? settings.mood);
  const picks = { ...settings, start, mood };

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
    // The intro story matches where the tour starts (a map-picked start keeps the mood's story; the map only flies to its places near the route).
    if (rank === 0 && voice) narration.start((!startPt && INTRO_BY_START[picks.start]) || picks.mood, settings.language);
    const of = rank > 0 && tour ? { mood: tour.mood, minutes: tour.minutes, start: tour.start, safe: !!tour.safe, source: tour.source ?? "photo" } : {};
    setLoading(true);
    setError(null);
    try {
      setTour(
        await createTour({
          ...picks,
          ...of,
          rank,
          ...(startPt && { start_lat: startPt.lat, start_lng: startPt.lng }),
          ...(endPt && { end_lat: endPt.lat, end_lng: endPt.lng }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      narration.stop(); // no tour was built: don't keep narrating (and flying the camera over) an empty map
    } finally {
      setLoading(false);
    }
  }

  return (
    // Phones stack the map on top and the controls underneath (one scroll); md+ keeps the sidebar beside the map.
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[#030712] text-slate-100 md:h-screen md:flex-row">
      <aside className="order-2 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-slate-800/60 bg-[#0e1628] md:order-none md:w-1/4 md:min-w-[360px] md:flex-none md:shrink-0 md:overflow-visible md:border-r md:border-t-0">
        <header className="flex items-center gap-4 border-b border-slate-800/70 px-5 py-4 md:px-8 md:py-6">
          <div className="grid h-11 w-11 place-items-center rounded-2xl border border-cyan-500/20 bg-[#0c2a3a] text-cyan-400 md:h-[58px] md:w-[58px]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round] md:h-8 md:w-8">
              <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
              <circle cx="7" cy="17" r="2" />
              <path d="M9 17h6" />
              <circle cx="17" cy="17" r="2" />
            </svg>
          </div>
          <div>
            <h1 className="text-[24px] font-extrabold leading-none tracking-tight md:text-[30px]">
              Waymo <span className="text-cyan-400">Haven</span>
            </h1>
            <p className="mt-1.5 text-[12px] font-medium tracking-[0.08em] text-slate-300 md:mt-2 md:text-[15px]">AUTONOMOUS CITY TOURS</p>
          </div>
        </header>

        <div className="stagger space-y-6 px-5 py-5 md:min-h-0 md:flex-1 md:space-y-7 md:overflow-y-auto md:px-8 md:py-7">
          <section>
            <Label
              glyph={
                <svg viewBox="0 0 24 24" className={icon}>
                  <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" />
                </svg>
              }
            >
              Scenic Picks From
            </Label>
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Where the scenic scores come from">
              {SOURCES.filter((o) => !offers || offers[o.id]?.starts.length).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.source === o.id}
                  onClick={() => set("source", o.id)}
                  className={`flex-1 rounded-xl border py-2 text-center text-[15px] font-bold transition ${
                    settings.source === o.id ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-300" : "border-slate-700/70 bg-[#060b18] text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-slate-400">{SOURCES.find((o) => o.id === settings.source)?.hint}</p>
          </section>

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
            <Select value={mood} options={moods} onChange={(v) => set("mood", v)} />
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
            <Select value={start} options={starts} onChange={(v) => { set("start", v); setStartPt(null); }} />
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
              className={`flex w-full items-center justify-between rounded-2xl border px-5 py-3 text-left transition ${
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

        <footer className="border-t border-slate-800/70 px-5 py-4 md:px-8 md:py-5">
          {tour && (
            // One compact row, so the settings above keep their room while a route is on the map.
            <div className="mb-3 flex items-center gap-2 rounded-2xl border border-slate-700/70 bg-[#060b18] py-2 pl-4 pr-2">
              <span className="min-w-0 flex-1 truncate text-[14px] text-slate-300" title={(tour.options ?? 1) > 1 ? "Best scenery for the quickest trip first" : undefined}>
                {(tour.options ?? 1) > 1 ? (
                  <>
                    Route <b className="text-cyan-300">{(tour.rank ?? 0) + 1}</b> of {tour.options}
                  </>
                ) : tour.dest_id ? (
                  "One-way to your destination"
                ) : (
                  "Your route"
                )}
              </span>
              {(tour.options ?? 1) > 1 && (
                <button
                  onClick={() => generate(((tour.rank ?? 0) + 1) % tour.options!)}
                  disabled={loading}
                  className="h-9 shrink-0 rounded-xl border border-cyan-400/60 bg-cyan-500/10 px-3 text-[13px] font-bold text-cyan-300 transition hover:bg-cyan-500/20 disabled:cursor-wait disabled:opacity-50"
                >
                  Next route →
                </button>
              )}
              <button
                onClick={exitRoute}
                title="Exit route"
                className="h-9 shrink-0 rounded-xl border border-slate-700/70 px-3 text-[13px] text-slate-300 transition hover:border-red-400/60 hover:text-red-300"
              >
                ✕ Exit
              </button>
            </div>
          )}
          {/* Safer Route sits here, always in view next to Generate: it's the feature the whole route is built around. */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.safe}
            onClick={() => set("safe", !settings.safe)}
            className={`mb-3 flex w-full items-center gap-3 rounded-2xl border px-4 py-2.5 text-left transition ${
              settings.safe ? "border-emerald-400/70 bg-emerald-500/10" : "border-slate-700/70 bg-[#060b18] hover:border-slate-500"
            }`}
          >
            <svg viewBox="0 0 24 24" className={`${icon} shrink-0 ${settings.safe ? "text-emerald-300" : "text-slate-400"}`}>
              <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-slate-100">Safer Route</span>
              <span className="block truncate text-[12px] leading-tight text-slate-400" title="Avoids Miami-Dade's high-injury corridors and big arterials, and flood zones during flood alerts">
                Avoids high-injury roads &amp; flood zones
              </span>
            </span>
            <span className={`shrink-0 rounded-full px-3 py-1 text-[13px] font-bold ${settings.safe ? "bg-emerald-400 text-[#0e1628]" : "bg-slate-700 text-slate-200"}`}>
              {settings.safe ? "ON" : "OFF"}
            </span>
          </button>
          <button
            onClick={() => generate()}
            disabled={loading}
            className={`${loading ? "shimmer" : ""} relative flex h-[60px] w-full items-center overflow-hidden justify-center gap-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-[19px] md:h-[64px] md:text-[20px] font-bold text-white shadow-[0_10px_30px_rgba(6,182,212,0.3)] transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-80`}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M9.9 15.5A2 2 0 0 0 8.5 14.1L2.4 12.5a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" />
              <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
            </svg>
            {loading ? "Building…" : "Generate City Tour"}
          </button>
        </footer>
      </aside>

      <main className="relative order-1 h-[60dvh] shrink-0 bg-[#030712] md:order-none md:h-auto md:flex-1 md:shrink bg-[radial-gradient(rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:28px_28px]">
        <MapPanel
          tour={tour}
          loading={loading}
          error={error}
          story={narration.story}
          cinematic={narration.status === "playing"}
          language={settings.language}
          spotVoice={voice && spotReady}
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
          player={narration.current ? <NarrationPlayer n={narration} /> : null}
        />
      </main>
    </div>
  );
}
