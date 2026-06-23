"""Live WebSocket streaming test (ticket auth + gap-recovery handshake)."""
from __future__ import annotations

import queue
import time
import uuid

from spanoai import SpanoAI


def test_stream_receives_connected_then_live_event(spano: SpanoAI) -> None:
    session = f"py-stream-{uuid.uuid4().hex[:8]}"
    spano.sessions.create(session)
    events: "queue.Queue[dict]" = queue.Queue()
    handle = spano.stream(session, lambda e: events.put(e))
    try:
        # 1) the ticket-authenticated connection opens
        connected = False
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                ev = events.get(timeout=1)
            except queue.Empty:
                continue
            if ev.get("event") == "CONNECTED":
                connected = True
                break
        assert connected, "did not receive CONNECTED over the stream"

        # 2) a write made now is delivered live over the same socket
        spano.context.write(session, "live", "k", {"v": 1})
        got_live = False
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                events.get(timeout=1)
            except queue.Empty:
                continue
            got_live = True
            break
        assert got_live, "did not receive a live event after the write"
    finally:
        handle.close()
