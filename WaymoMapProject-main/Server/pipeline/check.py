"""Backward-compatible verify entry (default: only AI score >= 7). Prefer pipeline.verify for full control."""
import argparse

from .verify import run


def main():
    ap = argparse.ArgumentParser(description="Verify AI scores (alias for pipeline.verify, default min-score 7)")
    ap.add_argument("--min-score", type=int, default=7)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    run(min_score=args.min_score, limit=args.limit, force=args.force)


if __name__ == "__main__":
    main()
