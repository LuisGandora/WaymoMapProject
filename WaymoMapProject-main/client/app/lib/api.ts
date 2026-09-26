// Thin client for the FastAPI backend (Server/app/main.py). No keys live here: the browser only ever talks to our own API.
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Stop = {
  id: string;
  lat: number;
  lng: number;
  street: string;
  score: number | null;
  tags: string[];
  frame_idx: number | null;
  photo: string | null; // "/static/frames/<id>.jpg", relative to API
  why: string;
  script: Record<string, string>;
  audio: Record<string, string>; // lang -> "/static/audio/<file>.mp3", relative to API
  place?: { name: string; rating: number; type: string } | null;
};

// Where the tour starts: a real street piece that has a Street View frame. score/why are empty if unscored.
export type Origin = { id: string; lat: number; lng: number; street: string; photo: string; score: number | null; tags: string[]; why: string };

export type Frame = { lat: number; lng: number; url: string; segment: string };

export type Tour = {
  id: string;
  mood: string;
  minutes: number;
  start: string;
  origin?: Origin; // absent on tours cached before start/destination markers; the last stop is the destination
  path: { type: "LineString"; coordinates: [number, number][] }; // [lng, lat]
  frames: Frame[];
  stops: Stop[];
  summary: { distance_km: number; drive_minutes: number; stops: number; businesses: string[] };
};

export type LatLng = { lat: number; lng: number };
export type RouteReq = { mood: string; minutes: number; start: string; language: string } & Partial<LatLng>; // lat/lng = custom start, must be inside the service area

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

export const getConfig = () => fetch(`${API}/config`).then(j<{ moods: string[]; languages: Record<string, string>; starts: string[] }>);
export const getServiceArea = () => fetch(`${API}/service-area`).then(j<GeoJSON.Feature>);
export const getSegments = () => fetch(`${API}/segments`).then(j<GeoJSON.FeatureCollection>);
// One of the top routes the server ranked (score first, then staying inside the service area, then drive time).
export type RouteOption = { id: string; rank: number; score: number; inside_pct: number; drive_minutes: number; distance_km: number; stops: number; start_street: string; end_street: string };

export const getPhotos = () => fetch(`${API}/photos`).then(j<GeoJSON.FeatureCollection>);
export const getTour = (id: string) => fetch(`${API}/tour/${id}`).then(j<Tour>);

// POST /route returns the ranked options; fetch the best one in full right after so the map has everything.
export async function createTour(req: RouteReq): Promise<{ options: RouteOption[]; tour: Tour }> {
  const r = await fetch(`${API}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const { tour_id, options } = await j<{ tour_id: string; options: RouteOption[] }>(r);
  return { options, tour: await getTour(tour_id) };
}

export const media = (path: string | null | undefined) => (path ? `${API}${path}` : null);
