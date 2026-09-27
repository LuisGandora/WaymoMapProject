"""Tours live in data/tours/<id>.json (also the offline demo fallback), mirrored to Mongo when MONGO_URI is set.

The Mongo document also carries the narration MP3s as raw bytes under `mp3.<stop index>-<lang>`, next to the /static
path kept in stops[].audio, so a deployed API can serve audio it did not render itself. The bytes never go in the JSON
file and are projected out of get(), so a tour document stays small and JSON-serialisable for the API.

Mongo never decides whether a request works: reads go to the file first (every save writes it), and after any Mongo
error (Atlas down, IP not allowlisted, venue DNS failing the mongodb+srv lookup) Mongo is skipped for MONGO_RETRY_S,
so an outage costs one timeout instead of a 500 on every request.
"""
import json
import threading
import time

from . import config

TOURS = config.DATA / "tours"
MONGO_RETRY_S = 60
_mongo = {"coll": None, "down_until": 0.0}
_connect = threading.Lock()  # concurrent first requests share one client instead of each opening (and leaking) their own


def _coll():
    """The tours collection, or None without MONGO_URI or while Mongo is marked down."""
    if not config.MONGO_URI or time.time() < _mongo["down_until"]:
        return None
    if _mongo["coll"] is None:
        with _connect:
            if _mongo["coll"] is None and time.time() >= _mongo["down_until"]:
                try:  # a mongodb+srv URI resolves DNS right here, so this can fail (or take seconds) on a bad network
                    from pymongo import MongoClient

                    _mongo["coll"] = MongoClient(config.MONGO_URI, serverSelectionTimeoutMS=3000, connectTimeoutMS=3000,
                                                 socketTimeoutMS=5000)["waymotour"]["tours"]
                except Exception as e:
                    _down("could not connect", e)
    return _mongo["coll"]


def _down(what, e):
    """Log a Mongo failure and skip Mongo for MONGO_RETRY_S; the JSON files keep everything working meanwhile."""
    _mongo["down_until"] = time.time() + MONGO_RETRY_S
    print(f"store: Mongo {what}: {type(e).__name__}: {e}; using data/tours only for {MONGO_RETRY_S} s")


def get(tour_id):
    """The stored tour: its JSON file if this machine has one, else the Mongo copy (a tour another instance built)."""
    f = TOURS / f"{tour_id}.json"
    for _ in range(3) if f.exists() else ():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):  # caught mid-write by a narration save(): read again (then Mongo)
            time.sleep(0.05)
    if (c := _coll()) is not None:
        try:
            return c.find_one({"_id": tour_id}, {"_id": 0, "mp3": 0})  # the MP3 bytes are fetched on their own: audio()
        except Exception as e:
            _down(f"read of {tour_id} failed", e)
    return None


def save(tour, fresh=False):
    """Write the JSON file, then mirror to Mongo. fresh=True (a tour just built) also drops narration clips left from a
    previous build of the same id, since they are keyed by stop position. A Mongo failure only logs: the file is the truth."""
    TOURS.mkdir(parents=True, exist_ok=True)
    (TOURS / f"{tour['id']}.json").write_text(json.dumps(tour, ensure_ascii=False), encoding="utf-8")
    if (c := _coll()) is not None:
        try:  # $set, not replace: keeps the mp3 clips already stored
            c.update_one({"_id": tour["id"]}, {"$set": tour, **({"$unset": {"mp3": ""}} if fresh else {})}, upsert=True)
        except Exception as e:
            _down(f"could not mirror {tour['id']}", e)


def save_audio(tour_id, key, data: bytes):
    """Keep one narration MP3 (key "<stop index>-<lang>") inside the tour's Mongo document.

    No-op without Mongo. The file under data/media/audio stays the source of truth, so a Mongo hiccup (or a tour
    that outgrows the 16 MB document limit) only logs and the /static path keeps working.
    """
    if (c := _coll()) is None:
        return
    try:
        c.update_one({"_id": tour_id}, {"$set": {f"mp3.{key}": data}}, upsert=True)  # the tour may exist only as a file so far
    except Exception as e:
        _down(f"could not keep mp3 {key} for {tour_id}", e)


def audio(tour_id, key):
    """The MP3 bytes for one stop and language from the tour's Mongo document, or None."""
    if (c := _coll()) is None:
        return None
    try:
        doc = c.find_one({"_id": tour_id}, {f"mp3.{key}": 1})
    except Exception as e:
        _down(f"read of mp3 {key} for {tour_id} failed", e)
        return None
    return (doc or {}).get("mp3", {}).get(key)
