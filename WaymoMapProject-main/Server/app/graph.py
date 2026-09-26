"""The drivable street graph: OSM streets clipped to the service polygon, no highways, cached to disk."""
import json
from functools import lru_cache

import osmnx as ox
from shapely.geometry import shape

from . import config

# Inclusion list, not exclusion: motorway/trunk (and service roads/alleys) are simply absent.
ROADS = '["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|primary_link|secondary_link|tertiary_link)$"]'


def polygon():
    gj = json.loads(config.AREA.read_text())
    geom = gj["features"][0]["geometry"] if gj["type"] == "FeatureCollection" else gj
    return shape(geom)


def build():
    G = ox.graph_from_polygon(polygon(), custom_filter=ROADS, simplify=True)
    G = ox.routing.add_edge_speeds(G)
    G = ox.routing.add_edge_travel_times(G)
    config.GRAPH_FILE.parent.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(G, config.GRAPH_FILE)
    return G


@lru_cache
def get():
    """Loaded once per process. Delete data/graph.graphml to force a fresh OSM pull."""
    G = ox.load_graphml(config.GRAPH_FILE) if config.GRAPH_FILE.exists() else build()
    for _, _, d in G.edges(data=True):
        d["travel_time"] /= config.SPEED_FACTOR
    return G


def nearest(G, lat, lng):
    # ponytail: brute force over nodes (~tens of thousands), fine at build time; use a KD-tree if hot.
    return min(G.nodes, key=lambda n: (G.nodes[n]["y"] - lat) ** 2 + ((G.nodes[n]["x"] - lng) * 0.9) ** 2)


def best_edge(G, u, v):
    return min(G[u][v].values(), key=lambda d: d["travel_time"])
