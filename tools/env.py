"""Read the repo-root .env, the same file vite loads.

Deliberately not python-dotenv: the format we need is `NAME=value` and nothing
else, and one less dependency to install before the pipeline runs. A real
environment variable always wins, so CI can inject keys without a file.
"""
from __future__ import annotations

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, ".env")


def load(path: str = ENV) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("'\"")
    return out


def get(name: str, required: bool = True) -> str:
    v = os.environ.get(name) or load().get(name, "")
    if not v and required:
        raise SystemExit(
            f"{name} 가 없다. .env.example 을 .env 로 복사하고 값을 채워라 "
            f"(찾은 위치: {ENV})")
    return v
