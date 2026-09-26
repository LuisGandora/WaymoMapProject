"""The drivable street graph: OSM streets clipped to the service polygon, no highways, cached to disk."""
import json
from functools import lru_cache

import geopandas as gpd
import osmnx as ox
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.validation import make_valid

from . import config

# Inclusion list, not exclusion: motorway/trunk (and service roads/alleys) are simply absent.
ROADS = '["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|primary_link|secondary_link|tertiary_link)$"]'


def polygon():
    """Service area as one valid (Multi)Polygon, EPSG:4326. Hand-traced shapes often self-intersect."""
    gj = json.loads(config.AREA.read_text(encoding="utf-8"))
    feats = gj["features"] if gj["type"] == "FeatureCollection" else [gj]
    geom = unary_union([shape(f["geometry"]) for f in feats])  # disconnected traces -> MultiPolygon
    return geom if geom.is_valid else make_valid(geom).buffer(0)


def area_sq_miles(geom):
    gs = gpd.GeoSeries([geom], crs="EPSG:4326")
    return float(gs.to_crs(gs.estimate_utm_crs()).area.iloc[0] / 2_589_988)


def build():
    # truncate_by_edge keeps streets that cross the boundary; strongest component so every node
    # is reachable both ways (removing one-ways can strand fragments, and loops need A->B->A).
    G = ox.graph_from_polygon(polygon(), custom_filter=ROADS, simplify=True, truncate_by_edge=True)
    G = ox.truncate.largest_component(G, strongly=True)
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
