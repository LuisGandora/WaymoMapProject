# Implementation Plan: Trustworthy Ride Times and Scenic Scores

**Project:** ShellHacks 2026, idle Waymo to self-narrating Miami city tour
**Goal:** make two claims defensible: (1) "the tour fits your time budget", (2) "the scenic score matches what people think is scenic".
**Status:** nothing in this plan is built yet.

## Where we are today

**Ride times.** There is no vehicle model. Travel time is `length / OSM speed`, divided by a flat `SPEED_FACTOR = 0.8` (`Server/app/graph.py`, `Server/app/config.py`).
- The graph has 33,110 edges. Only 13,750 (42%) carry an explicit `maxspeed` tag; the rest get a speed guessed from road class.
- Median free-flow speed is about 43 km/h; after the 0.8 factor the network averages about 22 mph.
- 254 traffic-signal nodes are tagged in the graph but ignored. There are no stop-sign, turn, congestion or acceleration effects.
- The matrix, live Dijkstra and the measured `drive_minutes` all use the same edge times, so they are consistent with each other, but nothing checks them against reality. Expect them to run optimistic.
- Waymo publishes no vehicle parameters, so any "typical Waymo car" model is a set of assumed constants fitted to data, not something derived from Waymo.

**Scenic scores.** Gemini rates one Street View frame per ~100 m segment, 1-10 (`Server/pipeline/score.py`). There is no ground truth, no consistency check and no comparison with people.

## Part A: Car time model and calibration

**A1. Vehicle profile** in `Server/app/config.py`. Parameters, labelled "assumed, fitted":
- cruise fraction of the speed limit
- surface-street speed cap
- signal delay
- stop-sign delay
- left and right turn penalties

**A2. Per-edge delays** in `Server/app/graph.py`.
- Replace the flat divide with `length / (min(limit, cap) x cruise)`.
- Add a delay to each edge for the node it enters, keyed on that node's tag (signal, stop, or plain intersection). Dijkstra stays unchanged.
- First check how many stop-sign nodes the graph actually carries.
- Turn penalties need a turn-aware graph, so skip them at first.
- Keep `SPEED_FACTOR` as the fallback.

**A3. `Server/pipeline/calibrate.py`.**
- Sample 40-50 start/end pairs, from tour legs and random pairs 2-12 minutes apart.
- Query the Google Routes API for traffic-aware duration at several departure times (weekday morning, weekday evening, Sunday).
- Compare with the graph time; report bias, MAPE and R-squared.
- Fit the A1 parameters by least squares.
- Save only the fitted numbers and a summary to `Server/data/calibration.json`. Do not store Google's raw responses (terms of service).

**A4. Per-leg times.**
- Add `leg_minutes` and a cumulative `eta_minutes` to each stop in the tour (`Server/app/tour.py`).
- Show the ETA in the popup and the step slider.
- Add `Server/test_times.py`: legs sum to `drive_minutes`, and a tour never exceeds its budget.

**A5. Optional traffic multiplier.** A `depart` time mapped through a small hour-of-day table taken from the A3 runs.

**A6. Real-ride check.** Time 5-10 actual rides by stopwatch (a Waymo if possible, otherwise a normal car) and compare with the model.

**Targets:** MAPE of 15% or less and bias within +/-5% against Google's durations.

## Part B: Human-labeled scenic set

Google Maps reviews are not human labels for scenery (they rate businesses, not views). Labels come from our own team through a small labeling tool.

**B1. `Server/pipeline/label_sample.py`.** About 100 frames stratified across the Gemini score range, plus about 20 repeats to measure raters' self-consistency. Writes `Server/data/labels/sample.json`.

**B2. Backend endpoints.**
- `GET /labels/next?rater=` returns the next unrated frame.
- `POST /labels` takes `{rater, frame_id, rating}` and appends to `Server/data/labels/ratings.jsonl`.
- Rater names are free text; no login. Frames are already served under `/static`.

**B3. `client/app/label/page.tsx`.**
- Photo with 1-5 buttons and keyboard shortcuts.
- Ask the same question Gemini gets: "would a tourist want to see this out a car window?"
- Hide the Gemini score; show a progress bar.
- Optional pairwise mode: two frames, pick the nicer one.

**B4. Raters.** At least 3 teammates rate all 100 frames, about 10 minutes each.

**B5. `Server/pipeline/evaluate.py`.**
- Agreement between raters (mean pairwise Spearman).
- Median human score per frame; Spearman correlation against Gemini.
- Test-retest: rerun Gemini twice on the same frames and measure its self-agreement.
- Short written report.

**Targets:** human agreement 0.5 or more, Gemini vs humans 0.6 or more, Gemini test-retest 0.8 or more.

**B6. Acting on the result.**
- If the correlation is low, rewrite the scoring prompt with a rubric and rerun only the labeled frames.
- Optionally fit a monotone mapping from Gemini score to human median and apply it in `Server/pipeline/rollup.py`.

**B7. Optional weak checks, kept separate from the labels.**
- Places review text mentioning "mural", "waterfront" or "view" near a segment (check the Places terms before storing anything).
- Proximity to OSM viewpoints and artwork.

## Order of work

1. A3, then A1/A2 (biggest accuracy gap), then A4.
2. B1-B5 in parallel, since they mostly need teammates' time.
3. A5, A6, B6, B7 if time allows.

**Cost:** roughly 150 Routes API calls, a few dollars at most and possibly inside the free monthly credit.

## Risks

- Google's terms limit caching Street View and Places data and storing Routes results; keep only fitted parameters and summaries.
- The Waymo service polygon is hand-traced and approximate (about 50 m); say so on stage.
- Photo coverage exists only for Wynwood and Little Havana (about 12 minutes across), which caps how long a straight tour can be.
