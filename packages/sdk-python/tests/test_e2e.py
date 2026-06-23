"""End-to-end sync tests against a live engine (mirrors server/tests/sdk-e2e.test.ts)."""
from __future__ import annotations

import threading
import time
import uuid

from spanoai import SpanoAI


def test_context_write_read(spano: SpanoAI, session: str) -> None:
    res = spano.context.write(session, "researcher", "findings", {"revenue": "$4.2M"})
    assert res["outcome"] == "written"
    entry = spano.context.read(session, "researcher", "findings")
    assert entry is not None
    assert entry["value"] == {"type": "json", "data": {"revenue": "$4.2M"}}
    assert entry["writtenBy"] == "researcher"  # X-SpanoAI-Agent flowed through


def test_read_miss_returns_none(spano: SpanoAI, session: str) -> None:
    assert spano.context.read(session, "nope", "missing") is None


def test_string_value_is_text(spano: SpanoAI, session: str) -> None:
    spano.context.write(session, "n", "greeting", "hello")
    entry = spano.context.read(session, "n", "greeting")
    assert entry["value"] == {"type": "text", "text": "hello"}


def test_append(spano: SpanoAI, session: str) -> None:
    spano.context.append(session, "log", "items", ["a", "b"])
    spano.context.append(session, "log", "items", ["c"])
    entry = spano.context.read(session, "log", "items")
    assert entry["value"]["data"] == ["a", "b", "c"]


def test_increment(spano: SpanoAI, session: str) -> None:
    r1 = spano.context.increment(session, "stats", "n", 2)
    assert r1["entry"]["value"]["data"] == 2
    r2 = spano.context.increment(session, "stats", "n", 3)
    assert r2["entry"]["value"]["data"] == 5


def test_expected_version_conflict(spano: SpanoAI, session: str) -> None:
    spano.context.write(session, "lock", "k", "v1")
    res = spano.context.write(session, "lock", "k", "v2", expected_version=99)
    assert res["outcome"] in ("conflict", "rejected")


def test_await_key_handoff(spano: SpanoAI, session: str) -> None:
    def writer() -> None:
        time.sleep(0.2)
        spano.context.write(session, "coder", "patch", {"diff": "+fix"})

    threading.Thread(target=writer, daemon=True).start()
    entry = spano.context.await_key(session, "coder", "patch", timeout_ms=5000)
    assert entry["key"] == "patch"
    assert entry["value"]["data"] == {"diff": "+fix"}


def test_search(spano: SpanoAI, session: str) -> None:
    spano.context.write(session, "research", "finding", "quarterly revenue grew to four million dollars")
    hits = []
    for _ in range(10):
        hits = spano.context.search(session, "revenue", top_k=5)
        if any(h["key"] == "finding" for h in hits):
            break
        time.sleep(0.2)
    assert any(h["key"] == "finding" for h in hits)


def test_bus_request_reply(spano: SpanoAI, session: str) -> None:
    def responder() -> None:
        time.sleep(0.2)
        inbox = spano.bus.claim(session, "reviewer")
        if inbox:
            spano.bus.reply(session, inbox[0]["id"], {"data": {"approved": True}})

    threading.Thread(target=responder, daemon=True).start()
    res = spano.bus.request(session, "reviewer", "review", {"data": {"pr": 1}}, timeout_ms=5000)
    assert res["reply"]["payload"]["data"]["approved"] is True


def test_broadcast_claim_ack(spano: SpanoAI, session: str) -> None:
    msgs = spano.bus.broadcast(session, ["w1", "w2", "w3"], "fanout", {"data": {"job": "x"}})
    assert len(msgs) == 3
    assert len({m["traceId"] for m in msgs}) == 1  # correlated fan-out
    inbox = spano.bus.claim(session, "w1")
    assert len(inbox) == 1
    assert spano.bus.ack(session, inbox[0]["id"])["acked"] is True


def test_sessions(spano: SpanoAI) -> None:
    sid = f"py-sess-{uuid.uuid4().hex[:8]}"
    created = spano.sessions.create(sid)
    assert created["sessionId"] == sid
    assert spano.sessions.get(sid)["sessionId"] == sid
    spano.sessions.join(sid, "agent-2")
    assert "agent-2" in spano.sessions.get(sid)["members"]
    assert spano.sessions.leave(sid, "agent-2")["left"] is True


def test_artifact_upload_download(spano: SpanoAI, session: str) -> None:
    data = b"hello spano artifacts \x00\x01\x02 binary-safe"
    art = spano.artifacts.upload(session, "blob.bin", "application/octet-stream", data)
    assert art["sizeBytes"] == len(data)
    assert art["sha256"] is not None
    got = spano.artifacts.download(session, art["id"])
    assert got == data


def test_bad_key_raises_spanoai_error(base_url: str, session: str) -> None:
    from spanoai import SpanoAIError

    bad = SpanoAI(api_key="sk_invalid", base_url=base_url, agent="x")
    try:
        raised = False
        try:
            bad.context.write(session, "n", "k", "v")
        except SpanoAIError as err:
            raised = True
            assert err.status in (401, 403)
        assert raised
    finally:
        bad.close()
