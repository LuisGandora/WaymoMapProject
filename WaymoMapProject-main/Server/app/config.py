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


def has_frame(seg_id) -> bool:
    """A street piece only counts as a real tour location if its Street View frame is on disk."""
    return (MEDIA / "frames" / f"{seg_id}.jpg").exists()

# Do not name the Maps key GOOGLE_API_KEY: google-genai treats that as *its* key
# and ignores GEMINI_API_KEY when both are set.
GOOGLE_KEY = os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
# LiteLLM: one key + base URL for gpt-oss-120b, Glimmer vision, and scripts.
# sk-… keys are LiteLLM *proxy* virtual keys — set LLM_BASE_URL to your gateway (see .env.example).
LLM_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("GEMINI_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-oss-120b")


def _normalize_llm_base(raw: str) -> str:
    """OpenAI-compatible root on the LiteLLM proxy (…/v1), not provider URLs like api.openai.com."""
    raw = (raw or "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.endswith("/v1"):
        return raw
    return f"{raw}/v1"


LLM_BASE = _normalize_llm_base(os.getenv("LLM_BASE_URL") or os.getenv("LITELLM_BASE_URL") or "")
IDENTIFY_MODEL = os.getenv("IDENTIFY_MODEL", "meta-muse-glimmer-30b")
VERIFY_GAP = float(os.getenv("VERIFY_GAP", "2"))
if LLM_KEY:
    os.environ["OPENAI_API_KEY"] = LLM_KEY
ELEVEN_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVEN_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "")
MONGO_URI = os.getenv("MONGO_URI", "")
FL511_KEY = os.getenv("FL511_API_KEY", "")  # optional: live closures/incidents for the safety layer
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
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
