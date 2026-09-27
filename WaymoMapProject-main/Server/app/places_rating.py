"""Google Places (New): resolve a named subject to star rating + review count."""
import math

import httpx

from . import config

SEARCH_TEXT = "https://places.googleapis.com/v1/places:searchText"
SEARCH_NEARBY = "https://places.googleapis.com/v1/places:searchNearby"
_MASK = "places.id,places.displayName,places.rating,places.userRatingCount,places.primaryType,places.location"

# kind -> Nearby includedPrimaryTypes (Places API New)
_KIND_TYPES = {
    "restaurant": ["restaurant", "cafe", "bakery"],
    "food": ["restaurant", "cafe", "bakery"],
    "landmark": ["tourist_attraction", "museum", "church"],
    "historic": ["tourist_attraction", "museum", "church"],
    "art_installation": ["art_gallery", "tourist_attraction", "museum"],
    "mural_district": ["art_gallery", "tourist_attraction"],
    "mural": ["art_gallery", "tourist_attraction"],
    "art_deco": ["tourist_attraction", "museum"],
    "museum": ["museum", "art_gallery"],
    "park": ["park", "tourist_attraction"],
    "waterfront": ["marina", "park", "tourist_attraction"],
}


def _headers():
    return {
        "X-Goog-Api-Key": config.GOOGLE_KEY,
        "X-Goog-FieldMask": _MASK,
        "Content-Type": "application/json",
    }


def _normalize_place(p: dict) -> dict | None:
    stars = p.get("rating")
    count = p.get("userRatingCount") or 0
    if stars is None or count <= 0:
        return None
    loc = p.get("location") or {}
    return {
        "provider": "google",
        "place_id": p.get("id", ""),
        "name": p.get("displayName", {}).get("text", ""),
        "stars": float(stars),
        "review_count": int(count),
        "primary_type": p.get("primaryType", ""),
        "lat": loc.get("latitude"),
        "lng": loc.get("longitude"),
    }


def _haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def search_text(query: str, lat: float, lng: float, *, radius_m: float = 2500) -> dict | None:
    if not config.GOOGLE_KEY or not (query or "").strip():
        return None
    body = {
        "textQuery": query.strip(),
        "maxResultCount": 5,
        "locationBias": {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": min(radius_m, 50000),
            }
        },
    }
    try:
        r = httpx.post(SEARCH_TEXT, headers=_headers(), json=body, timeout=20)
        r.raise_for_status()
    except httpx.HTTPError:
        return None
    best = None
    best_d = 1e18
    for p in r.json().get("places", []):
        norm = _normalize_place(p)
        if not norm:
            continue
        plat, plng = norm.get("lat"), norm.get("lng")
        if plat is None or plng is None:
            d = 0
        else:
            d = _haversine_m(lat, lng, plat, plng)
        if d < best_d:
            best_d = d
            best = norm
    return best


def search_nearby_typed(lat: float, lng: float, kind: str, *, radius_m: float = 200) -> dict | None:
    if not config.GOOGLE_KEY:
        return None
    types = _KIND_TYPES.get(kind) or ["tourist_attraction", "restaurant", "art_gallery", "park"]
    body = {
        "maxResultCount": 10,
        "rankPreference": "DISTANCE",
        "includedPrimaryTypes": types[:5],
        "locationRestriction": {
            "circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius_m}
        },
    }
    try:
        r = httpx.post(SEARCH_NEARBY, headers=_headers(), json=body, timeout=20)
        r.raise_for_status()
    except httpx.HTTPError:
        return None
    for p in r.json().get("places", []):
        norm = _normalize_place(p)
        if norm:
            return norm
    return None


def resolve_rating(subject: dict, lat: float, lng: float) -> dict | None:
    """Named subject via text search first; typed nearby only as fallback. None => review_score -1."""
    query = (subject or {}).get("google_search_query") or (subject or {}).get("label")
    kind = (subject or {}).get("kind", "unknown")
    if query and kind not in ("generic_street", "unknown"):
        hit = search_text(query, lat, lng)
        if hit:
            return hit
    if kind not in ("generic_street", "unknown"):
        return search_nearby_typed(lat, lng, kind)
    if query:
        return search_text(query, lat, lng)
    return None
