"""
SpanoAI Python SDK — sync (:class:`SpanoAI`) and async (:class:`AsyncSpanoAI`).

    from spanoai import SpanoAI
    spano = SpanoAI(api_key="sk_...", agent="researcher")
    spano.context.write("run-1", "researcher", "findings", {"revenue": "$4.2M"})
    entry = spano.context.read("run-1", "researcher", "findings")

Retries transient failures (5xx / 429 / network) with backoff, reusing the same
operationId so a retry replays idempotently. Mirrors the TypeScript SDK 1:1.
"""
from __future__ import annotations

import time
from typing import Any, AsyncIterator, Callable, Dict, Optional

import httpx

from . import _proto as p
from .artifacts import ArtifactsApi, AsyncArtifactsApi
from .bus import AsyncBusApi, BusApi
from .context import AsyncContextApi, ContextApi
from .errors import SpanoAIError
from .sessions import AsyncSessionsApi, SessionsApi
from .stream import StreamHandle, iter_stream_async, open_stream_sync

DEFAULT_BASE_URL = "http://localhost:8000"


def _clean_params(params: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not params:
        return None
    return {k: v for k, v in params.items() if v is not None}


def _error_from(resp: httpx.Response) -> SpanoAIError:
    try:
        body = resp.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}
    message = body.get("message") or body.get("error") or resp.reason_phrase or "request failed"
    return SpanoAIError(message, resp.status_code, body.get("error"), body.get("requestId"))


def _backoff_seconds(attempt: int) -> float:
    return min(2 ** attempt * 0.1, 2.0)


class SpanoAI:
    """Synchronous SpanoAI client."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        agent: str = "default",
        *,
        max_retries: int = 3,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._agent = agent
        self._max_retries = max_retries
        self._http = httpx.Client(
            timeout=timeout,
            headers={"X-SpanoAI-Key": api_key, "X-SpanoAI-Agent": agent},
        )
        self.context = ContextApi(self)
        self.bus = BusApi(self)
        self.sessions = SessionsApi(self)
        self.artifacts = ArtifactsApi(self)

    # ── transport ──────────────────────────────────────────────────────
    def _send(self, req: p.Req) -> Any:
        url = self._base_url + req.path
        attempt = 0
        while True:
            try:
                resp = self._http.request(req.method, url, json=req.json, params=_clean_params(req.params))
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt >= self._max_retries:
                    raise
                time.sleep(_backoff_seconds(attempt))
                attempt += 1
                continue
            if resp.status_code >= 400:
                err = _error_from(resp)
                if err.is_retryable and attempt < self._max_retries:
                    time.sleep(_backoff_seconds(attempt))
                    attempt += 1
                    continue
                raise err
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()

    def _put_bytes(self, url: str, data: bytes, content_type: str) -> None:
        with httpx.Client(timeout=60.0) as raw:
            resp = raw.put(url, content=data, headers={"Content-Type": content_type})
        if resp.status_code >= 400:
            raise SpanoAIError(f"Upload failed: {resp.status_code}", resp.status_code)

    def _get_bytes(self, url: str) -> bytes:
        with httpx.Client(timeout=60.0) as raw:
            resp = raw.get(url)
        if resp.status_code >= 400:
            raise SpanoAIError(f"Download failed: {resp.status_code}", resp.status_code)
        return resp.content

    # ── streaming ──────────────────────────────────────────────────────
    def stream(
        self,
        session: str,
        on_event: Callable[[Dict[str, Any]], None],
        *,
        on_error: Optional[Callable[[Exception], None]] = None,
        last_seq: Optional[int] = None,
    ) -> StreamHandle:
        """Open a live event stream; returns a handle with ``.close()``."""
        return open_stream_sync(self, session, on_event, on_error=on_error, last_seq=last_seq)

    # ── lifecycle ──────────────────────────────────────────────────────
    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "SpanoAI":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncSpanoAI:
    """Asynchronous SpanoAI client."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        agent: str = "default",
        *,
        max_retries: int = 3,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._agent = agent
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            timeout=timeout,
            headers={"X-SpanoAI-Key": api_key, "X-SpanoAI-Agent": agent},
        )
        self.context = AsyncContextApi(self)
        self.bus = AsyncBusApi(self)
        self.sessions = AsyncSessionsApi(self)
        self.artifacts = AsyncArtifactsApi(self)

    async def _send(self, req: p.Req) -> Any:
        url = self._base_url + req.path
        attempt = 0
        while True:
            try:
                resp = await self._http.request(req.method, url, json=req.json, params=_clean_params(req.params))
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt >= self._max_retries:
                    raise
                await _async_sleep(_backoff_seconds(attempt))
                attempt += 1
                continue
            if resp.status_code >= 400:
                err = _error_from(resp)
                if err.is_retryable and attempt < self._max_retries:
                    await _async_sleep(_backoff_seconds(attempt))
                    attempt += 1
                    continue
                raise err
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()

    async def _put_bytes(self, url: str, data: bytes, content_type: str) -> None:
        async with httpx.AsyncClient(timeout=60.0) as raw:
            resp = await raw.put(url, content=data, headers={"Content-Type": content_type})
        if resp.status_code >= 400:
            raise SpanoAIError(f"Upload failed: {resp.status_code}", resp.status_code)

    async def _get_bytes(self, url: str) -> bytes:
        async with httpx.AsyncClient(timeout=60.0) as raw:
            resp = await raw.get(url)
        if resp.status_code >= 400:
            raise SpanoAIError(f"Download failed: {resp.status_code}", resp.status_code)
        return resp.content

    def stream(self, session: str, *, last_seq: Optional[int] = None) -> AsyncIterator[Dict[str, Any]]:
        """Async iterator of live session events (reconnects with backoff)."""
        return iter_stream_async(self, session, last_seq=last_seq)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncSpanoAI":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()


async def _async_sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
