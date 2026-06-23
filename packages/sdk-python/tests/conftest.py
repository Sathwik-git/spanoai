"""
Shared pytest fixtures. Mints an ephemeral tenant + API key by shelling out to
the engine's admin-key dev script (the same path the TS examples use), so the
Python SDK is exercised exactly as a real integration would be: over HTTP, with
a real scoped key, against a live engine.

Prereq: docker compose up -d && the server on :8000.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator

import pytest

from spanoai import SpanoAI

# conftest.py is at packages/sdk-python/tests/ → repo root is four levels up.
REPO_ROOT = Path(__file__).resolve().parents[3]
BASE_URL = os.environ.get("SPANOAI_API_URL", "http://localhost:8000")


def _bun() -> str:
    return shutil.which("bun") or "bun"


def _admin(*args: str) -> str:
    proc = subprocess.run(
        [_bun(), "run", "apps/server/scripts/admin-key.ts", *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"admin-key {args} failed:\n{proc.stderr}\n{proc.stdout}")
    return proc.stdout


@pytest.fixture(scope="session")
def creds() -> Iterator[Dict[str, Any]]:
    out = _admin("mint", "pytest")
    match = re.search(r"\{.*\}", out, re.S)
    assert match, f"no JSON in admin-key output: {out!r}"
    data = json.loads(match.group(0))
    yield data
    _admin("teardown", data["tenantId"])


@pytest.fixture()
def base_url() -> str:
    return BASE_URL


@pytest.fixture()
def session() -> str:
    return f"py-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def spano(creds: Dict[str, Any]) -> Iterator[SpanoAI]:
    client = SpanoAI(api_key=creds["apiKey"], base_url=BASE_URL, agent="researcher")
    try:
        yield client
    finally:
        client.close()
