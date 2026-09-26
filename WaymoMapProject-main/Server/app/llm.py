"""LiteLLM OpenAI-compatible client for gpt-oss-120b (ranking + narration scripts)."""
import base64
import json
import os
import re

from litellm import completion as litellm_completion

from . import config


class LLMError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body or ""
        super().__init__(f"LLM {status}: {self.body[:300]}")


def _parse_json(text: str):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def _message_text(msg):
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, list):
        content = "".join(
            (p.get("text", "") if isinstance(p, dict) else getattr(p, "text", "") or "")
            for p in content
        )
    text = (content or "").strip()
    if not text:
        extra = None if isinstance(msg, dict) else (
            getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None)
        )
        text = (extra or "").strip() if extra else ""
    return text


def complete(messages, *, json_object=False, timeout=60):
    """One chat completion via LiteLLM (OpenAI-shaped). Returns assistant text."""
    assert config.LLM_KEY, "set LLM_API_KEY (or OPENAI_API_KEY) in Server/.env"
    os.environ["OPENAI_API_KEY"] = config.LLM_KEY
    kwargs = dict(
        model=config.LLM_MODEL,
        messages=messages,
        temperature=0.3,
        timeout=timeout,
        api_key=config.LLM_KEY,
        drop_params=True,
    )
    if json_object:
        kwargs["response_format"] = {"type": "json_object"}
    if config.LLM_BASE:
        kwargs["api_base"] = config.LLM_BASE
    try:
        r = litellm_completion(**kwargs)
    except Exception as e:
        status = getattr(e, "status_code", None) or getattr(e, "status", None) or 500
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = 500
        raise LLMError(status, str(e)) from e
    text = _message_text(r.choices[0].message)
    if not text:
        raise LLMError(200, "empty assistant content")
    return text


def complete_json(messages, timeout=60):
    return _parse_json(complete(messages, json_object=True, timeout=timeout))


def user_text_and_image(text: str, jpeg: bytes) -> dict:
    b64 = base64.b64encode(jpeg).decode("ascii")
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ],
    }
