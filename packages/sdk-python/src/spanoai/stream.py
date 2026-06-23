"""
Live session event streaming over WebSocket (ticket-authenticated).

A single-use ticket is minted over HTTP so the API key never appears in a WS
URL. Both flavours reconnect with backoff and track ``lastSeq`` for gap
recovery, mirroring the TypeScript SDK's ``stream()``.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, AsyncIterator, Callable, Dict, Optional

from . import _proto as p


def _ws_url(base_url: str, session: str, ticket: str, last_seq: Optional[int]) -> str:
    ws_base = "ws" + base_url[4:] if base_url.startswith("http") else base_url
    url = f"{ws_base}/stream/{session}?ticket={ticket}"
    if last_seq is not None:
        url += f"&lastSeq={last_seq}"
    return url


def _track_seq(data: Any, current: Optional[int]) -> Optional[int]:
    if isinstance(data, dict) and isinstance(data.get("seq"), int):
        return data["seq"]
    return current


class StreamHandle:
    """Handle for a running sync stream. Call :meth:`close` to stop it."""

    def __init__(self) -> None:
        self._closed = False
        self._ws: Any = None
        self.thread: Optional[threading.Thread] = None

    def close(self) -> None:
        self._closed = True
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:
            pass

    def join(self, timeout: Optional[float] = None) -> None:
        if self.thread is not None:
            self.thread.join(timeout)


def open_stream_sync(
    client: Any,
    session: str,
    on_event: Callable[[Dict[str, Any]], None],
    *,
    on_error: Optional[Callable[[Exception], None]] = None,
    last_seq: Optional[int] = None,
) -> StreamHandle:
    from websockets.sync.client import connect  # lazy import: only needed for streaming

    handle = StreamHandle()
    state: Dict[str, Optional[int]] = {"last_seq": last_seq}

    def run() -> None:
        backoff = 0.25
        while not handle._closed:
            try:
                ticket = client._send(p.stream_ticket(session))["ticket"]
            except Exception as err:  # ticket mint failed — back off and retry
                if on_error and not handle._closed:
                    on_error(err)
                if handle._closed:
                    break
                time.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
                continue
            try:
                with connect(_ws_url(client._base_url, session, ticket, state["last_seq"])) as ws:
                    handle._ws = ws
                    backoff = 0.25
                    for raw in ws:
                        if handle._closed:
                            break
                        try:
                            data = json.loads(raw)
                        except Exception:
                            continue
                        state["last_seq"] = _track_seq(data, state["last_seq"])
                        on_event(data)
            except Exception as err:
                if on_error and not handle._closed:
                    on_error(err)
            if handle._closed:
                break
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)

    thread = threading.Thread(target=run, daemon=True)
    handle.thread = thread
    thread.start()
    return handle


async def iter_stream_async(
    client: Any,
    session: str,
    *,
    last_seq: Optional[int] = None,
) -> AsyncIterator[Dict[str, Any]]:
    from websockets.asyncio.client import connect  # lazy import

    current = last_seq
    backoff = 0.25
    while True:
        ticket = (await client._send(p.stream_ticket(session)))["ticket"]
        try:
            async with connect(_ws_url(client._base_url, session, ticket, current)) as ws:
                backoff = 0.25
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                    except Exception:
                        continue
                    current = _track_seq(data, current)
                    yield data
        except Exception:
            pass
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 5.0)
