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

# 4) skip: ranks 0..N-1 give N different, spread-out destinations, none over budget
from app import tour
ds = [tour.build("murals+sunset", 30, "wynwood", rank=r) for r in range(3)]
assert len({t["dest_id"] for t in ds}) == 3 and all(t["options"] > 1 and t["summary"]["drive_minutes"] <= 30 for t in ds)
seg = tour.segments()
assert all(router.haversine_m((seg[a["dest_id"]]["lat"], seg[a["dest_id"]]["lng"]), (seg[b["dest_id"]]["lat"], seg[b["dest_id"]]["lng"])) >= tour.APART_M
           for i, a in enumerate(ds) for b in ds[i + 1:])
print("ok")
