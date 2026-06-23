"""Sessions API: create/join/leave the collaboration scope agents share."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import _proto as p


class SessionsApi:
    """Synchronous session operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    def create(self, session_id: Optional[str] = None, *, ttl_seconds: Optional[int] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._c._send(p.sess_create(session_id, ttl_seconds=ttl_seconds, metadata=metadata))

    def get(self, session_id: str) -> Dict[str, Any]:
        return self._c._send(p.sess_get(session_id))

    def list(self) -> List[Dict[str, Any]]:
        return self._c._send(p.sess_list())

    def join(self, session_id: str, agent_id: Optional[str] = None) -> Dict[str, Any]:
        return self._c._send(p.sess_join(session_id, agent_id))

    def leave(self, session_id: str, agent_id: Optional[str] = None) -> Dict[str, Any]:
        return self._c._send(p.sess_leave(session_id, agent_id))

    def abort(self, session_id: str) -> Dict[str, Any]:
        return self._c._send(p.sess_abort(session_id))

    def end(self, session_id: str) -> Dict[str, Any]:
        return self._c._send(p.sess_end(session_id))


class AsyncSessionsApi:
    """Asynchronous session operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    async def create(self, session_id: Optional[str] = None, *, ttl_seconds: Optional[int] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self._c._send(p.sess_create(session_id, ttl_seconds=ttl_seconds, metadata=metadata))

    async def get(self, session_id: str) -> Dict[str, Any]:
        return await self._c._send(p.sess_get(session_id))

    async def list(self) -> List[Dict[str, Any]]:
        return await self._c._send(p.sess_list())

    async def join(self, session_id: str, agent_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._c._send(p.sess_join(session_id, agent_id))

    async def leave(self, session_id: str, agent_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._c._send(p.sess_leave(session_id, agent_id))

    async def abort(self, session_id: str) -> Dict[str, Any]:
        return await self._c._send(p.sess_abort(session_id))

    async def end(self, session_id: str) -> Dict[str, Any]:
        return await self._c._send(p.sess_end(session_id))
