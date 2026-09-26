"use client";

import { useState, type ReactNode } from "react";
import MapPanel from "./MapPanel";

export const MOODS = [
  { id: "wynwood", label: "Wynwood Murals & Art" },
  { id: "south_beach", label: "South Beach Art Deco & Ocean" },
  { id: "downtown", label: "Miami Downtown Skyline" },
  { id: "brickell", label: "Brickell Nightlife & Bay" },
] as const;

export const LANGUAGES = [
  { id: "en", label: "English (US)" },
  { id: "es", label: "Spanish (Latin America)" },
  { id: "fr", label: "French" },
  { id: "zh", label: "Chinese (Mandarin)" },
] as const;

export const DURATIONS = [15, 30, 45] as const;

export type TourSettings = {
  mood: (typeof MOODS)[number]["id"];
  language: (typeof LANGUAGES)[number]["id"];
  minutes: (typeof DURATIONS)[number];
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

export default function Dashboard() {
  const [settings, setSettings] = useState<TourSettings>({ mood: "wynwood", language: "es", minutes: 30 });
  const [requested, setRequested] = useState<TourSettings | null>(null);
  const set = <K extends keyof TourSettings>(k: K, v: TourSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

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

        <div className="flex-1 space-y-10 overflow-y-auto px-8 py-10">
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
            <Select value={settings.mood} options={MOODS} onChange={(v) => set("mood", v)} />
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
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              }
            >
              Time Budget
            </Label>
            <div className="grid grid-cols-3 gap-4">
              {DURATIONS.map((m) => {
                const active = settings.minutes === m;
                return (
                  <button
                    key={m}
                    onClick={() => set("minutes", m)}
                    className={`h-[58px] rounded-2xl border text-[17px] transition ${
                      active
                        ? "border-cyan-400/80 bg-cyan-500/15 text-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.18)]"
                        : "border-slate-700/70 bg-[#060b18] text-slate-200 hover:border-slate-500"
                    }`}
                  >
                    {m} min
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="border-t border-slate-800/70 px-8 py-8">
          <button
            onClick={() => setRequested({ ...settings })}
            className="flex h-[72px] w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-[21px] font-bold text-white shadow-[0_10px_30px_rgba(6,182,212,0.3)] transition hover:brightness-110 active:scale-[0.99]"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M9.9 15.5A2 2 0 0 0 8.5 14.1L2.4 12.5a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" />
              <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
            </svg>
            Generate City Tour
          </button>
        </footer>
      </aside>

      <main className="relative flex-1 bg-[#030712] bg-[radial-gradient(rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:28px_28px]">
        <MapPanel settings={settings} requested={requested} />
      </main>
    </div>
  );
}
