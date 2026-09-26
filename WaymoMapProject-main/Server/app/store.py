"""Tours live in data/tours/<id>.json (also the offline demo fallback), mirrored to Mongo when MONGO_URI is set."""
import json
from functools import lru_cache

from . import config

TOURS = config.DATA / "tours"


@lru_cache
def _coll():
    if not config.MONGO_URI:
        return None
    from pymongo import MongoClient

    return MongoClient(config.MONGO_URI, serverSelectionTimeoutMS=3000)["waymotour"]["tours"]


def get(tour_id):
    if (c := _coll()) is not None:
        doc = c.find_one({"_id": tour_id}, {"_id": 0})
        if doc:
            return doc
    f = TOURS / f"{tour_id}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def save(tour):
    TOURS.mkdir(parents=True, exist_ok=True)
    (TOURS / f"{tour['id']}.json").write_text(json.dumps(tour, ensure_ascii=False), encoding="utf-8")
    if (c := _coll()) is not None:
        c.replace_one({"_id": tour["id"]}, {**tour, "_id": tour["id"]}, upsert=True)
