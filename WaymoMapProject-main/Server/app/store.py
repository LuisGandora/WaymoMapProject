"""Tours live in data/tours/<id>.json (also the offline demo fallback), mirrored to Mongo when MONGO_URI is set.

The Mongo document also carries the narration MP3s as raw bytes under `mp3.<stop index>-<lang>`, next to the /static
path kept in stops[].audio, so a deployed API can serve audio it did not render itself. The bytes never go in the JSON
file and are projected out of get(), so a tour document stays small and JSON-serialisable for the API.
"""
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
        doc = c.find_one({"_id": tour_id}, {"_id": 0, "mp3": 0})  # the MP3 bytes are fetched on their own: audio()
        if doc:
            return doc
    f = TOURS / f"{tour_id}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def save(tour):
    TOURS.mkdir(parents=True, exist_ok=True)
    (TOURS / f"{tour['id']}.json").write_text(json.dumps(tour, ensure_ascii=False), encoding="utf-8")
    if (c := _coll()) is not None:
        c.update_one({"_id": tour["id"]}, {"$set": tour}, upsert=True)  # $set, not replace: keeps the mp3 clips already stored


def save_audio(tour_id, key, data: bytes):
    """Keep one narration MP3 (key "<stop index>-<lang>") inside the tour's Mongo document.

    No-op without Mongo. The file under data/media/audio stays the source of truth, so a Mongo hiccup (or a tour
    that outgrows the 16 MB document limit) only logs and the /static path keeps working.
    """
    if (c := _coll()) is None:
        return
    try:
        c.update_one({"_id": tour_id}, {"$set": {f"mp3.{key}": data}})
    except Exception as e:
        print(f"store: could not keep mp3 {key} for {tour_id} in Mongo: {e}")


def audio(tour_id, key):
    """The MP3 bytes for one stop and language from the tour's Mongo document, or None."""
    if (c := _coll()) is None:
        return None
    doc = c.find_one({"_id": tour_id}, {f"mp3.{key}": 1})
    return (doc or {}).get("mp3", {}).get(key)
