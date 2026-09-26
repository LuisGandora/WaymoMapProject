// POST /api/narrate { mood, language } -> audio/mpeg
// Turns the tour's intro script into speech with ElevenLabs. The API key is read from the server environment
// (client/.env.local) and never sent to the browser.
import { isLang, resolveNarration } from "../../lib/narration";

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs premade "Rachel"; override with ELEVENLABS_VOICE_ID
const DEFAULT_MODEL = "eleven_multilingual_v2"; // speaks the script in whatever language it is written in

// Scripts are fixed, so each (script, language) pair only has to be paid for once per server run.
const cache = new Map<string, ArrayBuffer>();

export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "ELEVENLABS_API_KEY is missing from client/.env.local (restart npm run dev after adding it)" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as { mood?: unknown; language?: unknown } | null;
  const narration = resolveNarration(typeof body?.mood === "string" ? body.mood : "");
  const lang = isLang(body?.language) ? body.language : "en";
  const cacheKey = `${narration.id}:${lang}`;

  let audio = cache.get(cacheKey);
  if (!audio) {
    const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: narration.script[lang],
        model_id: process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL,
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
    audio = await r.arrayBuffer();
    cache.set(cacheKey, audio);
  }

  return new Response(audio, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-narration-id": narration.id, "x-narration-lang": lang },
  });
}
