"""Paths, env vars and the few constants shared by the API and the pipeline."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DATA = ROOT / "data"
MEDIA = DATA / "media"  # frames/*.jpg and audio/*.mp3, served at /static
AREA = Path(os.getenv("SERVICE_AREA", DATA / "service_area.geojson"))
GRAPH_FILE = DATA / "graph.graphml"
# Grow the traced service polygon by this many miles: the street graph, the sampled/scored blocks and the "inside the area"
# checks all use the grown shape. 0 = exactly the traced polygon. Delete data/graph.graphml after changing it.
AREA_BUFFER_MILES = float(os.getenv("AREA_BUFFER_MILES", "0"))


def has_frame(seg_id) -> bool:
    """A street piece only counts as a real tour location if its Street View frame is on disk."""
    return (MEDIA / "frames" / f"{seg_id}.jpg").exists()

# Do not name the Maps key GOOGLE_API_KEY: google-genai treats that as *its* key
# and ignores GEMINI_API_KEY when both are set.
GOOGLE_KEY = os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
# Ranking + scripts: LiteLLM, OpenAI-compatible (gpt-oss-120b).
LLM_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("GEMINI_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")
LLM_BASE = (os.getenv("LLM_BASE_URL") or "").rstrip("/")
if LLM_KEY:
    os.environ["OPENAI_API_KEY"] = LLM_KEY
ELEVEN_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVEN_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "")
MONGO_URI = os.getenv("MONGO_URI", "")
FL511_KEY = os.getenv("FL511_API_KEY", "")  # optional: live closures/incidents for the safety layer
CORS_ORIGINS = [o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
CORS_ORIGIN_REGEX = os.getenv("CORS_ORIGIN_REGEX") or None  # e.g. https://waymo-.*\.vercel\.app for Vercel preview deploys
# Calibration knob: OSM speeds are free-flow; robotaxis in Miami traffic are slower.
SPEED_FACTOR = float(os.getenv("SPEED_FACTOR", "0.8"))

LANGS = {"en": "English", "es": "Spanish", "ht": "Haitian Creole", "pt": "Portuguese"}
TAGS = ["mural", "waterfront", "art_deco", "historic", "food", "greenery", "nothing"]

# mood -> tags a segment must have (None = anything). "a+b" combos union their tags.
MOODS = {
    "murals": ["mural"],
    "water": ["waterfront"],
    "art_deco": ["art_deco"],
    "historic": ["historic"],
    "food": ["food"],
    "sunset": ["waterfront", "greenery"],  # ponytail: no real sun position, add astral later
    "surprise": None,
}
MATRIX_MOODS = [*MOODS, "murals+sunset"]  # every mood the router accepts has a matrix file

# Demo neighborhoods: bbox (W, S, E, N) limits which streets get sampled/scored; start = loop start.
# ponytail: rough boxes, adjust after tracing the real polygon.
HOODS = {
    "wynwood": {"bbox": (-80.2100, 25.7950, -80.1900, 25.8100), "start": (25.8010, -80.1995)},
    "little_havana": {"bbox": (-80.2450, 25.7600, -80.2150, 25.7750), "start": (25.7657, -80.2290)},
}


def mood_tags(mood: str):
    parts = mood.split("+")
    if any(MOODS[p] is None for p in parts):
        return None
    return sorted({t for p in parts for t in MOODS[p]})
