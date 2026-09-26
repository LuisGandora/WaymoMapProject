# Implementation Plan 2: Distance-Formula Benchmark for Route Timing

**Idea:** use the latitude/longitude distance formula ([Omni Calculator](https://www.omnicalculator.com/other/latitude-longitude-distance)) on each street between stops, divide by the speed limit, and use that as a benchmark for our route times.
**Verdict:** yes as a benchmark and sanity check, and possibly as a speed-up. No as ground truth for real travel time.

## What the formula is

The calculator computes the great-circle (haversine) distance between two points:

```
a = sin^2(dlat / 2) + cos(lat1) * cos(lat2) * sin^2(dlon / 2)
d = 2 * R * asin(sqrt(a))          R = 6371 km
time = d / speed_limit
```

The project already has this: `haversine_m` in `Server/app/router.py` (`12742000` is `2 * R` in metres). It is used for snapping starts and for the tour checks.

## Why it can't be ground truth for time

Ground truth needs something measured in the real world. This formula is a calculation, so it can only agree or disagree with our model, not tell us what a real ride takes. What it does give is a floor and an independent check.

| Issue | Effect |
|---|---|
| It gives straight-line distance | A leg between two stops runs along grid streets with turns, so real distance is longer. Our tours run about 1.6x the straight start-to-end distance (from my earlier runs, e.g. 10.0 km of path for 6.3 km straight). |
| Distance / speed limit is free-flow | It ignores signals, stop signs, turns, traffic and acceleration. The graph has 254 signal nodes tagged, and none affect timing today. |
| Speed limits are partly guessed | Only 42% of edges carry an explicit `maxspeed` tag; the rest are guessed from road class, so a "limit" is often an assumption. |
| The graph already uses it | OSM edge lengths come from great-circle distances, so the formula and the graph should agree by construction. Agreement proves the code is consistent, not that times are accurate. |

Real ground truth is Google Routes traffic-aware durations and timed real rides. Those are Part A in `implementation.md`.

## Where it is useful

1. **Floor test (correctness).** For every leg, straight-line distance / max allowed speed is a lower bound on drive time. If a measured leg time is below it, the model has a bug (units, speed, or path).
2. **Length check (correctness).** Sum the haversine distance between consecutive points of a tour's path polyline and compare with `summary.distance_km` and the sum of edge `length` values. Expect a gap near zero; more than about 2% means a geometry or unit error.
3. **Circuity metric (quality).** `path length / straight-line start-to-end distance` per route. It measures how direct a route is, so it backs up the "no doubling back" requirement. Baseline from earlier runs is about 1.6, which includes the detours to stops. Could also serve as a ranking tie-breaker or a guard.
4. **A\* speed-up (performance).**
   - Use `haversine / fastest possible speed` as the heuristic in `nx.astar_path` for point-to-point legs.
   - It is admissible (never overestimates) if the speed used is the fastest effective speed in the graph: the maximum edge speed is about 72.4 km/h, times `SPEED_FACTOR` 0.8, about 57.9 km/h (16.1 m/s).
   - Tours currently build in about 0.3 to 2 seconds. The likely bigger cost is building the corridor subgraph and the up-to-40 candidate routes, not the per-leg searches. **Profile first**; only switch to A\* if leg searches are a real share of the time.

## Implementation steps

1. **`Server/pipeline/benchmark.py`.**
   - Build N tours (both starts, several moods, 15/30/45 minutes).
   - For each, report: floor violations (count), length mismatch (%), circuity (mean and max), and how measured leg time compares with the haversine floor.
   - Print a short table and exit non-zero if any floor violation or length mismatch above 2%.
2. **Extend `Server/test_times.py`** (from `implementation.md` A4) with the floor test and the length check on two or three fixed tours, so they run without keys or network.
3. **Add `leg_minutes`** to each stop (A4). The floor test needs per-leg times.
4. **A\* trial.** In the benchmark, time `nx.shortest_path` against `nx.astar_path` for the same legs. Adopt A\* in `Server/app/tour.py` only if the saving is meaningful, and assert both give the same path time.
5. **Report the benchmark honestly** as an internal consistency check, and keep the real-world calibration (Google Routes, stopwatch rides) as the accuracy claim.

## Acceptance criteria

- Zero floor violations across all benchmarked tours.
- Path length within 2% of the sum of edge lengths.
- Circuity reported per route; investigate anything above about 2.0.
- A\* adopted only with identical path times and a measured speed-up.

## What this does and doesn't change

- It will catch bugs and make the "no doubling back" claim measurable.
- It will not make the time estimates more accurate. That still depends on adding signal, stop and turn delays and calibrating against Google's traffic-aware times.
