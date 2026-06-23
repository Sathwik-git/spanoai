"""
Parity guard: the sync and async API surfaces must not drift. If you add a
method to one class and forget the other, this fails (see the plan's
"Python SDK parity drift" risk).
"""
from __future__ import annotations

from spanoai.artifacts import ArtifactsApi, AsyncArtifactsApi
from spanoai.bus import AsyncBusApi, BusApi
from spanoai.context import AsyncContextApi, ContextApi
from spanoai.sessions import AsyncSessionsApi, SessionsApi


def _public_methods(cls: type) -> set[str]:
    return {n for n in dir(cls) if not n.startswith("_") and callable(getattr(cls, n))}


def test_sync_async_surface_parity() -> None:
    pairs = [
        (ContextApi, AsyncContextApi),
        (BusApi, AsyncBusApi),
        (SessionsApi, AsyncSessionsApi),
        (ArtifactsApi, AsyncArtifactsApi),
    ]
    for sync_cls, async_cls in pairs:
        assert _public_methods(sync_cls) == _public_methods(async_cls), (
            f"sync/async drift between {sync_cls.__name__} and {async_cls.__name__}"
        )


def test_expected_context_methods() -> None:
    expected = {"write", "read", "append", "increment", "list", "history", "delete", "await_key", "search"}
    assert expected <= _public_methods(ContextApi)


def test_expected_bus_methods() -> None:
    expected = {"dispatch", "broadcast", "claim", "ack", "reply", "request", "await_reply", "list_dlq", "replay_dlq"}
    assert expected <= _public_methods(BusApi)
