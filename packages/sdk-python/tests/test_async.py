"""Async client end-to-end tests."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict

from spanoai import AsyncSpanoAI


async def test_async_context_and_bus(creds: Dict[str, Any], base_url: str) -> None:
    session = f"py-async-{uuid.uuid4().hex[:8]}"
    async with AsyncSpanoAI(api_key=creds["apiKey"], base_url=base_url, agent="async-agent") as spano:
        res = await spano.context.write(session, "a", "k", {"v": 1})
        assert res["outcome"] == "written"

        entry = await spano.context.read(session, "a", "k")
        assert entry["value"]["data"] == {"v": 1}
        assert entry["writtenBy"] == "async-agent"

        assert await spano.context.read(session, "a", "missing") is None

        await spano.bus.dispatch(session, "worker", "do_task", {"text": "hi"})
        inbox = await spano.bus.claim(session, "worker")
        assert len(inbox) == 1
        assert inbox[0]["intent"] == "do_task"


async def test_async_concurrent_writes(creds: Dict[str, Any], base_url: str) -> None:
    session = f"py-async-conc-{uuid.uuid4().hex[:8]}"
    async with AsyncSpanoAI(api_key=creds["apiKey"], base_url=base_url, agent="async-agent") as spano:
        await asyncio.gather(*(
            spano.context.append(session, "log", "items", [i]) for i in range(10)
        ))
        entry = await spano.context.read(session, "log", "items")
        assert sorted(entry["value"]["data"]) == list(range(10))
