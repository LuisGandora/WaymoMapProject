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
  summary: { distance_km: number; drive_minutes: number; stops: number; businesses: string[] };
};

export type RouteReq = { mood: string; minutes: number; start: string; language: string };

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

export const getConfig = () => fetch(`${API}/config`).then(j<{ moods: string[]; languages: Record<string, string>; starts: string[] }>);
export const getServiceArea = () => fetch(`${API}/service-area`).then(j<GeoJSON.Feature>);
export const getSegments = () => fetch(`${API}/segments`).then(j<GeoJSON.FeatureCollection>);
export const getTour = (id: string) => fetch(`${API}/tour/${id}`).then(j<Tour>);

// POST /route returns a partial tour (no frames); fetch the full one right after so ride mode has everything.
export async function createTour(req: RouteReq): Promise<Tour> {
  const r = await fetch(`${API}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const { tour_id } = await j<{ tour_id: string }>(r);
  return getTour(tour_id);
}

export const media = (path: string | null | undefined) => (path ? `${API}${path}` : null);
