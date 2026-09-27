"""Pure verify math: normalize Google stars to /10 and compare to the AI score."""
from . import config


def stars_to_ten(stars: float) -> float:
    """Map x/5 stars to x/10 (multiply by 2)."""
    return round(float(stars) * 2, 1)


def review_score_from_ref(rating_ref: dict | None) -> float:
    """-1 when there is no usable rating; else normalized /10 score."""
    if not rating_ref:
        return -1
    count = rating_ref.get("review_count") or 0
    stars = rating_ref.get("stars")
    if count <= 0 or stars is None:
        return -1
    return stars_to_ten(stars)


def compare_to_ai(ai_score: int | float, review_score: float, *, gap: float | None = None) -> str:
    """Return verify_status. review_score -1 => no_rating (informational; routing does not read it)."""
    gap = config.VERIFY_GAP if gap is None else gap
    if review_score < 0:
        return "no_rating"
    delta = float(ai_score) - review_score
    if delta >= gap:
        return "potential_mistake"
    if delta <= -gap:
        return "users_choice"
    return "agree"
