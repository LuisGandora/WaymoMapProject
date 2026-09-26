// Thin client for the FastAPI backend (Server/app/main.py). No keys live here: the browser only ever talks to our own API.
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Stop = {
  id: string;
  lat: number;
  lng: number;
  street: string;
  score: number;
  tags: string[];
  frame_idx: number | null;
  photo: string | null; // "/static/frames/<id>.jpg", relative to API
  why: string;
  script: Record<string, string>;
  audio: Record<string, string>; // lang -> "/static/audio/<file>.mp3", relative to API
  place?: { name: string; rating: number; type: string } | null;
};

export type Frame = { lat: number; lng: number; url: string; segment: string };

export type Tour = {
  id: string;
  mood: string;
  minutes: number;
  start: string;
  path: { type: "LineString"; coordinates: [number, number][] }; // [lng, lat]
  frames: Frame[];
  stops: Stop[];
  safe?: boolean;
  summary: {
    distance_km: number; drive_minutes: number; stops: number; businesses: string[];
    safety?: Safety | null;
    weather?: { flood: boolean; storm: boolean; alerts: string[] };
  };
};

export type RouteReq = { mood: string; minutes: number; start: string; language: string; safe?: boolean };

export type Safety = {
  score: number; grade: "A" | "B" | "C" | "D"; km: number; hin_km: number; hin_pct: number; arterial_pct: number; calm_pct: number;
  flood_km: number; flood_alert: boolean; ksi_crashes: number; ksi_pedestrian: number; ksi_per_km: number; ksi_vs_area?: number; closures: number;
  vs_fastest?: { minutes: number; hin_km: number; score: number; arterial_pct: number };
  vs_default?: { minutes: number; hin_km: number; score: number; calm_pct: number; stops: number };
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

export const getConfig = () => fetch(`${API}/config`).then(j<{ moods: string[]; languages: Record<string, string>; starts: string[] }>);
export const getServiceArea = () => fetch(`${API}/service-area`).then(j<GeoJSON.Feature>);
export const getSegments = () => fetch(`${API}/segments`).then(j<GeoJSON.FeatureCollection>);
export const getPhotos = () => fetch(`${API}/photos`).then(j<GeoJSON.FeatureCollection>);
export const getTour = (id: string) => fetch(`${API}/tour/${id}`).then(j<Tour>);
export const getHazards = () => fetch(`${API}/hazards`).then(j<{ hin: GeoJSON.FeatureCollection; flood: GeoJSON.FeatureCollection; ksi?: GeoJSON.FeatureCollection }>);
export const getWeather = () => fetch(`${API}/weather`).then(j<{ alerts: { event: string; headline: string }[]; flood: boolean; storm: boolean; closures: unknown[] }>);

// POST /route returns a partial tour (no frames); fetch the full one right after so ride mode has everything.
export async function createTour(req: RouteReq): Promise<Tour> {
  const r = await fetch(`${API}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const { tour_id } = await j<{ tour_id: string }>(r);
  return getTour(tour_id);
}

export const media = (path: string | null | undefined) => (path ? `${API}${path}` : null);

// Narration points. The route drives past every scenic block it can fit, but a 30-minute tour with 30 numbered stops
// is one per minute, so only the best few get a marker: about one per 4 minutes, at least 4, kept in route order.
// Ride mode / narration should use this list too.
export function highlights(tour: Tour): Stop[] {
  const n = Math.max(4, Math.round(tour.minutes / 4));
  const keep = new Set([...tour.stops].sort((a, b) => b.score - a.score).slice(0, n).map((s) => s.id));
  return tour.stops.filter((s) => keep.has(s.id));
}
