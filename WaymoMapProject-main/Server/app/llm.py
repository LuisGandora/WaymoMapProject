"""LiteLLM OpenAI-compatible client (ranking, scripts, Glimmer vision)."""
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


def _prepare_model(model: str, base: str) -> str:
    """LiteLLM proxy: use the gateway model id, not provider-native meta/ routing."""
    if base and model.startswith("meta/"):
        return model.split("/", 1)[1]
    return model


def complete(messages, *, model=None, api_key=None, api_base=None, json_object=False, timeout=60):
    """One chat completion via LiteLLM. Same pattern for gpt-oss-120b and Glimmer."""
    model = model or config.LLM_MODEL
    api_key = api_key or config.LLM_KEY
    assert api_key, "set LLM_API_KEY in Server/.env"
    os.environ["OPENAI_API_KEY"] = api_key
    base = api_base if api_base is not None else config.LLM_BASE
    if not base:
        raise LLMError(
            400,
            "LLM_BASE_URL is not set — point it at your LiteLLM proxy …/v1 (see Server/.env.example)",
        )
    model = _prepare_model(model, base)
    kwargs = dict(
        model=model,
        messages=messages,
        temperature=0.3,
        timeout=timeout,
        api_key=api_key,
        drop_params=True,
    )
    if json_object:
        kwargs["response_format"] = {"type": "json_object"}
    if base:
        kwargs["api_base"] = base
        kwargs["custom_llm_provider"] = "openai"
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


def complete_json(messages, timeout=60, **kwargs):
    return _parse_json(complete(messages, json_object=True, timeout=timeout, **kwargs))


def user_text_and_image(text: str, jpeg: bytes) -> dict:
    b64 = base64.b64encode(jpeg).decode("ascii")
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ],
    }
