"""Step 5: per mood, drive minutes between the top-30 segments and the demo starts -> data/matrix_<mood>.json.

python -m pipeline.matrix
minutes[a][b] = time leaving a's exit node -> entering b, plus driving b's own street piece.
"""
import json

import networkx as nx

from app import config, graph, router


def main():
    G = graph.get()
    segs = json.loads((config.DATA / "segments.json").read_text(encoding="utf-8"))
    starts = {f"start:{h}": graph.nearest(G, *c["start"]) for h, c in config.HOODS.items()}
    for mood in config.MATRIX_MOODS:
        cands = router.top_candidates(segs, config.mood_tags(mood))
        if not cands:
            print(f"{mood}: no matching segments, skipped")
            continue
        nodes = {s["id"]: {"enter": s["u"], "exit": s["v"], "traverse": graph.best_edge(G, s["u"], s["v"])["travel_time"] / 60}
                 for s in cands}
        nodes |= {k: {"enter": n, "exit": n, "traverse": 0} for k, n in starts.items()}
        dist = {x: nx.single_source_dijkstra_path_length(G, x, weight="travel_time") for x in {n["exit"] for n in nodes.values()}}
        minutes = {a: {b: round(dist[na["exit"]][nb["enter"]] / 60 + nb["traverse"], 2)
                       for b, nb in nodes.items() if nb["enter"] in dist[na["exit"]]} for a, na in nodes.items()}
        (config.DATA / f"matrix_{mood}.json").write_text(json.dumps({"nodes": nodes, "minutes": minutes}), encoding="utf-8")
        print(f"{mood}: {len(cands)} candidates")


if __name__ == "__main__":
    main()
