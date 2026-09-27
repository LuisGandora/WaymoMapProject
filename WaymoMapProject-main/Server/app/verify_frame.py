"""Orchestrate identify -> Google rating -> compare to AI score (one frame)."""
from . import config, identify, places_rating, verify_logic


def resolve_rating_ref(subject: dict, lat: float, lng: float) -> dict | None:
    return places_rating.resolve_rating(subject, lat, lng)


def verify_frame(frame: dict, point: dict, *, jpeg: bytes | None = None, skip_identify: bool = False) -> dict:
    """
    Returns fields to merge onto the frame row. Does not mutate score.
    review_score is -1 when Google has no usable rating.
    """
    tags = frame.get("tags") or []
    ai = frame.get("score", 0)
    subject = frame.get("subject") if skip_identify and frame.get("subject") else None
    if subject is None:
        if jpeg is None:
            path = config.MEDIA / "frames" / f"{frame['id']}.jpg"
            jpeg = path.read_bytes() if path.exists() else None
        if jpeg:
            subject = identify.identify(jpeg, point, tags)
        else:
            subject = identify.fallback_subject(point, tags)
            subject["source"] = "no_image"

    rating_ref = resolve_rating_ref(subject, point["lat"], point["lng"])
    if rating_ref is None and subject.get("kind") in ("generic_street", "unknown"):
        # Glimmer saw nothing specific: fall back to a rated place of the AI tags' kind right by the frame.
        kind = identify.fallback_subject(point, tags)["kind"]
        rating_ref = places_rating.search_nearby_typed(point["lat"], point["lng"], kind, radius_m=150)
    review_score = verify_logic.review_score_from_ref(rating_ref)
    status = verify_logic.compare_to_ai(ai, review_score, gap=config.VERIFY_GAP)

    out = {
        "subject": subject,
        "rating_ref": rating_ref,
        "review_score": review_score,
        "verify_status": status,
        "check": status,
    }
    if rating_ref:
        out["place"] = {
            "name": rating_ref["name"],
            "rating": rating_ref["stars"],
            "type": rating_ref.get("primary_type", ""),
            "provider": rating_ref["provider"],
            "review_count": rating_ref["review_count"],
        }
    return out
