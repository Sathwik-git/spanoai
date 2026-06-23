"""Context-store API: shared working memory keyed by ``namespace.key``."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import _proto as p
from .errors import SpanoAIError


class ContextApi:
    """Synchronous context-store operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    def write(self, session: str, namespace: str, key: str, value: Any, **opts: Any) -> Dict[str, Any]:
        return self._c._send(p.ctx_write(session, namespace, key, value, **opts))

    def read(self, session: str, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        """Read a key. Returns ``None`` if it does not exist (a miss is not an error)."""
        try:
            return self._c._send(p.ctx_read(session, namespace, key))
        except SpanoAIError as err:
            if err.is_not_found:
                return None
            raise

    def append(self, session: str, namespace: str, key: str, items: List[Any], **opts: Any) -> Dict[str, Any]:
        return self._c._send(p.ctx_append(session, namespace, key, items, **opts))

    def increment(self, session: str, namespace: str, key: str, by: float = 1, **opts: Any) -> Dict[str, Any]:
        return self._c._send(p.ctx_increment(session, namespace, key, by, **opts))

    def list(self, session: str, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._c._send(p.ctx_list(session, namespace))

    def history(self, session: str, namespace: str, key: str) -> List[Dict[str, Any]]:
        return self._c._send(p.ctx_history(session, namespace, key))

    def delete(self, session: str, namespace: str, key: str) -> Dict[str, Any]:
        return self._c._send(p.ctx_delete(session, namespace, key))

    def await_key(self, session: str, namespace: str, key: str, *, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._c._send(p.ctx_await(session, namespace, key, timeout_ms=timeout_ms))

    def search(self, session: str, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        return self._c._send(p.ctx_search(session, query, top_k))


class AsyncContextApi:
    """Asynchronous context-store operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    async def write(self, session: str, namespace: str, key: str, value: Any, **opts: Any) -> Dict[str, Any]:
        return await self._c._send(p.ctx_write(session, namespace, key, value, **opts))

    async def read(self, session: str, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        try:
            return await self._c._send(p.ctx_read(session, namespace, key))
        except SpanoAIError as err:
            if err.is_not_found:
                return None
            raise

    async def append(self, session: str, namespace: str, key: str, items: List[Any], **opts: Any) -> Dict[str, Any]:
        return await self._c._send(p.ctx_append(session, namespace, key, items, **opts))

    async def increment(self, session: str, namespace: str, key: str, by: float = 1, **opts: Any) -> Dict[str, Any]:
        return await self._c._send(p.ctx_increment(session, namespace, key, by, **opts))

    async def list(self, session: str, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        return await self._c._send(p.ctx_list(session, namespace))

    async def history(self, session: str, namespace: str, key: str) -> List[Dict[str, Any]]:
        return await self._c._send(p.ctx_history(session, namespace, key))

    async def delete(self, session: str, namespace: str, key: str) -> Dict[str, Any]:
        return await self._c._send(p.ctx_delete(session, namespace, key))

    async def await_key(self, session: str, namespace: str, key: str, *, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        return await self._c._send(p.ctx_await(session, namespace, key, timeout_ms=timeout_ms))

    async def search(self, session: str, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        return await self._c._send(p.ctx_search(session, query, top_k))
