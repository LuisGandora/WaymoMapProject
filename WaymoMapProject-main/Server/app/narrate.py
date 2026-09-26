"""External calls for a stop: Places + Wikipedia facts, gpt-oss-120b script, ElevenLabs MP3. Backend only."""
import httpx

from . import config

PLACES = "https://places.googleapis.com/v1/places:searchNearby"
WIKI = "https://en.wikipedia.org/w/api.php"


def place_near(lat, lng):
    """Nearest well-rated business within 150 m, or None (also None when no key is set)."""
    if not config.GOOGLE_KEY:
        return None
    r = httpx.post(
        PLACES,
        headers={"X-Goog-Api-Key": config.GOOGLE_KEY, "X-Goog-FieldMask": "places.displayName,places.rating,places.primaryTypeDisplayName"},
        json={"maxResultCount": 5, "rankPreference": "DISTANCE",
              "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 150}}},
        timeout=15,
    )
    r.raise_for_status()
    for p in r.json().get("places", []):
        if p.get("rating", 0) >= 4.0:
            return {"name": p["displayName"]["text"], "rating": p["rating"],
                    "type": p.get("primaryTypeDisplayName", {}).get("text", "")}


def wiki_near(lat, lng):
    """Extract of the nearest Wikipedia article within 500 m, or None."""
    q = {"action": "query", "format": "json", "generator": "geosearch", "ggscoord": f"{lat}|{lng}",
         "ggsradius": 500, "ggslimit": 1, "prop": "extracts", "exintro": 1, "explaintext": 1, "exchars": 600}
    pages = httpx.get(WIKI, params=q, timeout=15, headers={"User-Agent": "WaymoMapProject/0.1"}).json().get("query", {}).get("pages", {})
    for p in pages.values():
        return {"title": p["title"], "extract": p.get("extract", "")}


def script(stop, lang):
    """~20 s spoken script in `lang`, grounded only in the facts we hand the LLM."""
    from . import llm

    facts = {"street": stop["street"], "tags": stop["tags"], "place": stop.get("place"), "wikipedia": stop.get("wiki")}
    prompt = (f"Write a spoken tour-guide script of about 50 words in {config.LANGS[lang]} for a passenger in a robotaxi "
              f"passing this spot in Miami. Use ONLY these facts, invent nothing: {facts}. Output only the script.")
    return llm.complete([{"role": "user", "content": prompt}])


def tts(text, out_path):
    r = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{config.ELEVEN_VOICE}",
        headers={"xi-api-key": config.ELEVEN_KEY},
        json={"text": text, "model_id": "eleven_multilingual_v2"},
        timeout=60,
    )
    r.raise_for_status()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(r.content)
