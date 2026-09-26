// POST /api/narrate { mood, language } -> audio/mpeg
// Turns the tour's intro script into speech with ElevenLabs. The API key is read from the server environment
// (client/.env.local) and never sent to the browser.
//
// Cache: a clip is paid for once per (text, voice, language, model). Hits are served from memory first, then from the
// `narrations` collection in Mongo (MONGO_URI in client/.env.local, optional), so a redeploy or a second instance does
// not pay again. Mongo being absent or down never blocks narration: the request just falls through to ElevenLabs.
import { createHash } from "node:crypto";
import { Binary, MongoClient, type Collection } from "mongodb";
import { isLang, resolveNarration } from "../../lib/narration";

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs premade "Rachel"; override with ELEVENLABS_VOICE_ID
const DEFAULT_MODEL = "eleven_multilingual_v2"; // speaks the script in whatever language it is written in

// sha256 of (text, voice, lang, model): the same words in the same voice, language and model are the same clip.
const clipKey = (text: string, voice: string, lang: string, model: string) =>
  createHash("sha256").update(JSON.stringify([text, voice, lang, model])).digest("hex");

// In-process cache, keyed like the Mongo documents.
const memory = new Map<string, Uint8Array<ArrayBuffer>>();

type Clip = { _id: string; text: string; voice: string; lang: string; model: string; audio: Binary; created: Date };

// One Mongo connection per server process, kept on globalThis so `next dev` hot reloads don't open a new pool each
// time. Resolves to null without MONGO_URI or when the server can't be reached (logged once).
const g = globalThis as unknown as { __narrations?: Promise<Collection<Clip> | null> };
function narrations(): Promise<Collection<Clip> | null> {
  g.__narrations ??= (async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) return null;
    try {
      const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 3000 }).connect();
      return client.db(process.env.MONGO_DB || "waymotour").collection<Clip>("narrations");
    } catch (e) {
      console.error("narrate: Mongo unavailable, caching in memory only:", e instanceof Error ? e.message : e);
      return null;
    }
  })();
  return g.__narrations;
}

export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "ELEVENLABS_API_KEY is missing from client/.env.local (restart npm run dev after adding it)" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as { mood?: unknown; language?: unknown } | null;
  const narration = resolveNarration(typeof body?.mood === "string" ? body.mood : "");
  const lang = isLang(body?.language) ? body.language : "en";
  const text = narration.script[lang];
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  const id = clipKey(text, voice, lang, model);
  const headers = (from: "memory" | "mongo" | "elevenlabs") => ({
    "content-type": "audio/mpeg", "cache-control": "no-store", "x-narration-id": narration.id, "x-narration-lang": lang, "x-narration-cache": from,
  });

  const hit = memory.get(id);
  if (hit) return new Response(hit, { headers: headers("memory") });

  const coll = await narrations();
  if (coll) {
    try {
      const doc = await coll.findOne({ _id: id }, { projection: { audio: 1 } });
      if (doc?.audio) {
        const audio = new Uint8Array(doc.audio.buffer);
        memory.set(id, audio);
        return new Response(audio, { headers: headers("mongo") });
      }
    } catch (e) {
      console.error("narrate: Mongo read failed, asking ElevenLabs:", e instanceof Error ? e.message : e);
    }
  }

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    console.error(`ElevenLabs ${r.status}:`, raw);
    let message: string | undefined;
    try {
      const d = JSON.parse(raw)?.detail;
      message = typeof d === "string" ? d : d?.message;
    } catch {}
    const hint = r.status === 401 ? "API key rejected" : r.status === 404 ? "voice not found, check ELEVENLABS_VOICE_ID" : r.status === 429 ? "rate limit or quota reached" : `error ${r.status}`;
    return Response.json({ error: `ElevenLabs: ${message ?? hint}` }, { status: 502 });
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  memory.set(id, audio);
  if (coll) {
    try {
      // $setOnInsert: two requests racing for the same new clip both succeed, the first one's bytes stay.
      await coll.updateOne({ _id: id }, { $setOnInsert: { text, voice, lang, model, audio: new Binary(audio), created: new Date() } }, { upsert: true });
    } catch (e) {
      console.error("narrate: Mongo write failed (clip still served):", e instanceof Error ? e.message : e);
    }
  }

  return new Response(audio, { headers: headers("elevenlabs") });
}
