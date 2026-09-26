"""Pure route-building logic: pick candidates, then cheapest-insertion into a loop. No I/O."""
import math

INF = math.inf


def haversine_m(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def top_candidates(segments, tags, n=30, sep_m=250):
    """Best-scored segments matching any of `tags` (None = any), at least sep_m apart."""
    pool = [s for s in segments if tags is None or set(tags) & set(s["tags"])]
    pool.sort(key=lambda s: -s["score"])
    picked = []
    for s in pool:
        if all(haversine_m((s["lat"], s["lng"]), (p["lat"], p["lng"])) >= sep_m for p in picked):
            picked.append(s)
        if len(picked) == n:
            break
    return picked


def build_loop(t, scores, start, candidates, budget):
    """Insert candidates into [start, start] by best score / added minutes until the budget is used.

    t(a, b): minutes to drive a -> b (including traversing b). Returns (route, total_minutes).
    """
    route, total, left = [start, start], t(start, start), list(candidates)
    while True:
        best = None
        for c in left:
            for i in range(len(route) - 1):
                a, b = route[i], route[i + 1]
                base, x, y = t(a, b), t(a, c), t(c, b)
                if INF in (base, x, y):
                    continue
                added = x + y - base
                if total + added > budget:
                    continue  # doesn't fit here; a shorter detour might still fit
                value = scores[c] / max(added, 0.1)
                if best is None or value > best[0]:
                    best = (value, c, i + 1, added)
        if best is None:
            return route, total
        _, c, pos, added = best
        route.insert(pos, c)
        left.remove(c)
        total += added
