"""Smoke-test LiteLLM proxy: list models and optional one-line completion.

python -m pipeline.llm_check [--ping]

Requires LLM_API_KEY and LLM_BASE_URL in Server/.env (same gateway for gpt-oss-120b and Glimmer).
"""
import argparse
import json
import sys

import httpx

from app import config, llm


def list_models():
    assert config.LLM_KEY, "set LLM_API_KEY"
    assert config.LLM_BASE, "set LLM_BASE_URL (proxy …/v1 — see .env.example)"
    url = f"{config.LLM_BASE.rstrip('/')}/models"
    r = httpx.get(url, headers={"Authorization": f"Bearer {config.LLM_KEY}"}, timeout=15)
    r.raise_for_status()
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ping", action="store_true", help="run a tiny completion on LLM_MODEL")
    ap.add_argument(
        "--base-url",
        help="override LLM_BASE_URL for this run (e.g. http://127.0.0.1:4000/v1)",
    )
    args = ap.parse_args()
    base = config._normalize_llm_base(args.base_url) if args.base_url else config.LLM_BASE
    print(f"LLM_BASE_URL={base}")
    print(f"LLM_MODEL={config.LLM_MODEL}")
    print(f"IDENTIFY_MODEL={config.IDENTIFY_MODEL}")
    try:
        if args.base_url:
            url = f"{base.rstrip('/')}/models"
            r = httpx.get(url, headers={"Authorization": f"Bearer {config.LLM_KEY}"}, timeout=15)
            r.raise_for_status()
            data = r.json()
        else:
            data = list_models()
        ids = [m.get("id") for m in data.get("data", []) if m.get("id")]
        print(f"models ({len(ids)}):", ", ".join(ids[:20]) + ("…" if len(ids) > 20 else ""))
        if config.LLM_MODEL not in ids:
            print(f"warning: LLM_MODEL not in list", file=sys.stderr)
        if config.IDENTIFY_MODEL not in ids:
            print(f"warning: IDENTIFY_MODEL not in list", file=sys.stderr)
    except Exception as e:
        print(f"models: FAILED {e}", file=sys.stderr)
        sys.exit(1)
    if args.ping:
        kw = {"timeout": 30}
        if args.base_url:
            kw["api_base"] = base
        text = llm.complete([{"role": "user", "content": "Reply with exactly: ok"}], **kw)
        print("ping:", json.dumps(text))


if __name__ == "__main__":
    main()
