"""Vision identify (Muse Glimmer via LiteLLM, same gateway as gpt-oss-120b) -> subject for Places lookup."""
import json

from . import config, llm

_PROMPT = """You analyze a Miami street-view photo for a robotaxi scenic tour.
Identify the main thing a tourist would care about (mural district, landmark, restaurant, park, historic building, or generic street).
Reply with JSON only:
{
  "kind": "mural_district|art_installation|landmark|historic|restaurant|food|museum|park|waterfront|generic_street|unknown",
  "label": "short human name",
  "google_search_query": "specific Google Maps search query including Miami/Wynwood if helpful",
  "confidence": 0.0-1.0
}
Use generic_street or unknown if nothing notable. For murals prefer district or wall names when visible."""


def fallback_subject(point: dict, tags: list[str]) -> dict:
    street = point.get("street") or "street"
    tag = next((t for t in tags if t != "nothing"), "area")
    label = f"{tag.replace('_', ' ')} on {street}, Miami"
    kind_map = {
        "mural": "mural_district",
        "art_deco": "landmark",
        "historic": "historic",
        "food": "food",
        "waterfront": "waterfront",
        "greenery": "park",
    }
    return {
        "kind": kind_map.get(tag, "generic_street"),
        "label": label,
        "google_search_query": f"{label} Wynwood",
        "confidence": 0.2,
        "source": "tags_fallback",
    }


def identify(jpeg: bytes, point: dict, tags: list[str] | None = None) -> dict:
    """Run Glimmer when LLM_BASE_URL is set; otherwise tag/street fallback (no Meta 401)."""
    tags = tags or []
    ctx = (
        f" Street: {point.get('street', '?')}. "
        f"Lat/lng: {point.get('lat')},{point.get('lng')}. "
        f"Prior AI tags: {', '.join(tags) or 'none'}."
    )
    if not config.LLM_KEY:
        sub = fallback_subject(point, tags)
        sub["source"] = "no_llm_key"
        return sub
    if not config.LLM_BASE:
        sub = fallback_subject(point, tags)
        sub["source"] = "no_llm_base_url"
        return sub
    try:
        data = llm.complete_json(
            [llm.user_text_and_image(_PROMPT + ctx, jpeg)],
            model=config.IDENTIFY_MODEL,
            timeout=90,
        )
        sub = {
            "kind": str(data.get("kind", "unknown")),
            "label": str(data.get("label", "")),
            "google_search_query": str(data.get("google_search_query", "")),
            "confidence": float(data.get("confidence", 0.5)),
            "source": "glimmer",
        }
        if not sub["google_search_query"]:
            sub["google_search_query"] = sub["label"] + " Miami"
        return sub
    except (llm.LLMError, json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
        sub = fallback_subject(point, tags)
        sub["source"] = "glimmer_error"
        sub["error"] = str(e)[:120]
        return sub
