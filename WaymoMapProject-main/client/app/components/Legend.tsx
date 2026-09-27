"use client";

import { useState, type ReactNode } from "react";
import type { LayerVis } from "../lib/api";

// What each color and shape on the map means. Miniature by default (a small pill in the top-left corner, clear of the
// narration player and story card at the bottom); tap it to open. The road-safety rows double as switches for those map layers.
export default function Legend({ vis, onToggle, hidden }: { vis: LayerVis; onToggle: (k: keyof LayerVis) => void; hidden: boolean }) {
  const [open, setOpen] = useState(false);
  if (hidden) return null; // the cinematic narration owns the frame (letterbox bars, title card)
  const row = "flex items-center gap-2.5";
  const dot = (bg: string, size = 10, ring = false) => (
    <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: bg, boxShadow: ring ? `0 0 0 3px ${bg}66, 0 0 10px ${bg}` : undefined }} />
  );
  const swatch = (on: boolean, color: string) => <span className="inline-block h-2 w-2 rounded-full transition-opacity" style={{ background: color, opacity: on ? 1 : 0.25 }} />;
  // One switch row per danger layer; its samples dim when the layer is off.
  const toggle = (k: keyof LayerVis, label: string, body: ReactNode) => (
    <button
      type="button"
      role="switch"
      aria-checked={vis[k]}
      onClick={() => onToggle(k)}
      className={`w-full rounded-lg border px-2.5 py-1.5 text-left transition ${vis[k] ? "border-slate-600 bg-slate-800/60" : "border-slate-800 opacity-60 hover:opacity-90"}`}
    >
      <span className="mb-1 flex items-center justify-between text-[12px] font-semibold text-slate-100">
        {label}
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${vis[k] ? "bg-emerald-400 text-[#0e1628]" : "bg-slate-700 text-slate-300"}`}>{vis[k] ? "ON" : "OFF"}</span>
      </span>
      <span className={`block space-y-1 text-[11px] text-slate-300 ${vis[k] ? "" : "opacity-50"}`}>{body}</span>
    </button>
  );

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open legend"
        className="pointer-events-auto absolute left-4 top-4 z-[70] flex items-center gap-2 rounded-full border border-slate-700/70 bg-[#0e1628]/90 px-3 py-1.5 text-[12px] font-bold text-slate-100 shadow-lg backdrop-blur hover:border-cyan-400/60"
      >
        <span className="flex items-center gap-1">
          {swatch(vis.streets, "#22c55e")}
          {swatch(vis.hin, "#ef4444")}
          {swatch(vis.ksi, "#f97316")}
          {swatch(vis.flood, "#3b82f6")}
        </span>
        Legend
        <span aria-hidden className="text-slate-400">▸</span>
      </button>
    );

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-[70] max-h-[calc(100%-2rem)] w-[250px] overflow-y-auto rounded-2xl border border-slate-700/70 bg-[#0e1628]/95 text-[12px] text-slate-300 shadow-lg backdrop-blur">
      <button type="button" onClick={() => setOpen(false)} aria-label="Minimize legend" className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-bold text-slate-100">
        Legend
        <span aria-hidden className="text-slate-400">▾</span>
      </button>
      <div className="space-y-1.5 px-4 pb-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Your tour</div>
        <div className={row}><span className="inline-block h-1 w-5 shrink-0 rounded bg-cyan-400" />Route, arrows show direction</div>
        <div className={row}>{dot("#22c55e", 12, true)}START</div>
        <div className={row}>{dot("#ef4444", 12, true)}END (destination)</div>
        <div className={row}><span className="grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full bg-cyan-400 text-[8px] font-extrabold text-[#0e1628]">1</span>Highlighted stop</div>
        <div className="pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Scenic score (tap to show or hide)</div>
        {toggle("streets", "Scenic streets", <span className={row}><span className="inline-block h-1.5 w-5 shrink-0 rounded" style={{ background: "linear-gradient(90deg,#475569,#eab308,#22c55e)" }} />Low to high (streets)</span>)}
        <div className="pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Road safety (tap to show or hide)</div>
        {toggle("hin", "High-injury corridors", <span className={row}><span className="inline-block h-0 w-5 shrink-0 border-t-[3px] border-dashed border-red-500" />Dashed red streets</span>)}
        {toggle(
          "ksi",
          "Crash dots",
          <>
            <span className={row}>{dot("#f97316")}Serious-injury crash</span>
            <span className={row}>{dot("#dc2626")}Fatal crash</span>
            <span className={row}>{dot("#f97316", 14)}Larger dot: pedestrian involved</span>
          </>,
        )}
        {toggle("flood", "Flood zones", <span className={row}><span className="inline-block h-3 w-5 shrink-0 rounded-sm bg-blue-500/40" />FEMA flood zone</span>)}
        <div className="pt-1 text-[11px] text-slate-500">Crash dots: killed or seriously injured, FDOT Signal Four. Click one for details.</div>
      </div>
    </div>
  );
}
