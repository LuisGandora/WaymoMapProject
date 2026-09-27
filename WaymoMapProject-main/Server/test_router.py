"""Self-check: python test_router.py (no keys, no network)."""
from shapely.geometry import Point

from app import config, graph, router

# 1) insertion picks value-per-minute and respects the budget
T = {("s", "s"): 0, ("s", "a"): 5, ("a", "s"): 5, ("s", "b"): 10, ("b", "s"): 10, ("a", "b"): 6, ("b", "a"): 6}
t = lambda x, y: T[(x, y)]
route, total = router.build_loop(t, {"a": 9, "b": 8}, "s", ["a", "b"], 12)
assert route == ["s", "a", "s"] and total == 10, (route, total)  # b would push past 12
route, total = router.build_loop(t, {"a": 9, "b": 8}, "s", ["a", "b"], 30)
assert set(route) == {"s", "a", "b"} and total <= 30, (route, total)

route, total = router.build_loop(t, {"a": 9, "b": 8}, "s", ["a", "b"], 30, end="b")  # fixed destination
assert route[0] == "s" and route[-1] == "b" and "a" in route, route

# 2) mood filter + spacing: adjacent pieces of one street collapse to one candidate
segs = [{"id": i, "lat": 25.8 + i * 0.0001, "lng": -80.2, "score": 10 - i, "tags": ["mural"]} for i in range(3)]
assert len(router.top_candidates(segs, ["mural"])) == 1
assert router.top_candidates(segs, ["food"]) == []

# 3) demo starts really are inside the (placeholder or traced) polygon
poly = graph.polygon()
for h, c in config.HOODS.items():
    assert poly.contains(Point(c["start"][1], c["start"][0])), f"{h} start is outside the service polygon"

# 4) the default tour is a loop, and skipping walks through ranked loops: each one different, all within budget, best first
from app import tour
ts = [tour.build("murals+sunset", 30, "wynwood", rank=r) for r in range(3)]
for t in ts:
    assert t["dest_id"] is None and t["stops"] and t["summary"]["drive_minutes"] <= 30 * 1.1 + 0.1, t["summary"]
    assert t["path"]["coordinates"][0] == t["path"]["coordinates"][-1], "a loop ends where it starts"
assert ts[0]["options"] > 1 and len({frozenset(s["id"] for s in t["stops"]) for t in ts}) == 3, "ranked loops must differ"
assert sum(s["score"] for s in ts[0]["stops"]) >= sum(s["score"] for s in ts[2]["stops"]), "rank 0 is the most scenic"
print("ok")
