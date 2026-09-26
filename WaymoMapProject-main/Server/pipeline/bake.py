"""Step 6: pre-bake a demo tour (route + narration + MP3s in every language) so the stage demo makes no live calls.

python -m pipeline.bake --mood murals+sunset --minutes 30 --start wynwood [--langs en es ht pt]
"""
import argparse

from app import config, tour


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mood", required=True, choices=config.MATRIX_MOODS)
    ap.add_argument("--minutes", type=int, required=True)
    ap.add_argument("--start", default="wynwood", choices=list(config.HOODS))
    ap.add_argument("--langs", nargs="*", default=list(config.LANGS), choices=list(config.LANGS))
    a = ap.parse_args()
    t = tour.build(a.mood, a.minutes, a.start)
    for lang in a.langs:
        tour.narrate_tour(t["id"], lang)
        print(f"{t['id']}: {lang} done")
    print(f"baked -> data/tours/{t['id']}.json (serve it at GET /tour/{t['id']})")


if __name__ == "__main__":
    main()
