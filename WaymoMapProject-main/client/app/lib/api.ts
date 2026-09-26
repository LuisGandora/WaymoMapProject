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

export type LatLng = { lat: number; lng: number };

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
  origin?: { id: string; lat: number; lng: number; street: string; photo: string }; // the photographed street the tour starts on
  dest_id?: string | null; // set for a one-way tour: that stop is the destination
  summary: {
    distance_km: number; drive_minutes: number; stops: number; businesses: string[];
    safety?: Safety | null;
    weather?: { flood: boolean; storm: boolean; alerts: string[] };
  };
};

export type RouteReq = { mood: string; minutes: number; start: string; language: string; safe?: boolean; start_lat?: number; start_lng?: number; end_lat?: number; end_lng?: number };

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

// The stops the map numbers and the step bar walks through, in route order. A one-way tour always ends on its destination.
export function navStops(tour: Tour): Stop[] {
  const dest = tour.stops.find((s) => s.id === tour.dest_id);
  const list = highlights(tour).filter((s) => s.id !== dest?.id);
  return dest ? [...list, dest] : list;
}

// Straight-line direction and distance between two points, for "head NE, ~0.9 km to the next stop".
export function leg(a: LatLng, b: LatLng): { dir: string; km: number } {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][(Math.round((Math.atan2(y, x) / r) / 45) + 8) % 8];
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return { dir, km: 2 * 6371 * Math.asin(Math.sqrt(h)) };
}
