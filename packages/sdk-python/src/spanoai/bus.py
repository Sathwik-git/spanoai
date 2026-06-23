"""Message-bus API: durable agent-to-agent messaging."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import _proto as p


class BusApi:
    """Synchronous message-bus operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    def dispatch(self, session: str, to_agent: str, intent: str, payload: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        return self._c._send(p.bus_dispatch(session, to_agent, intent, payload, **opts))

    def broadcast(self, session: str, to_agents: List[str], intent: str, payload: Dict[str, Any], **opts: Any) -> List[Dict[str, Any]]:
        return self._c._send(p.bus_broadcast(session, to_agents, intent, payload, **opts))

    def claim(self, session: str, agent_id: str, count: int = 10) -> List[Dict[str, Any]]:
        return self._c._send(p.bus_claim(session, agent_id, count))

    def ack(self, session: str, message_id: str) -> Dict[str, Any]:
        return self._c._send(p.bus_ack(session, message_id))

    def reply(self, session: str, message_id: str, payload: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        return self._c._send(p.bus_reply(session, message_id, payload, **opts))

    def request(self, session: str, to_agent: str, intent: str, payload: Dict[str, Any], *, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._c._send(p.bus_request(session, to_agent, intent, payload, timeout_ms=timeout_ms))

    def await_reply(self, session: str, message_id: str, *, timeout_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
        return self._c._send(p.bus_await_reply(session, message_id, timeout_ms=timeout_ms))

    def list_dlq(self, session: str, count: int = 100) -> List[Dict[str, Any]]:
        return self._c._send(p.bus_list_dlq(session, count))

    def replay_dlq(self, session: str, stream_id: str) -> Dict[str, Any]:
        return self._c._send(p.bus_replay_dlq(session, stream_id))


class AsyncBusApi:
    """Asynchronous message-bus operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    async def dispatch(self, session: str, to_agent: str, intent: str, payload: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        return await self._c._send(p.bus_dispatch(session, to_agent, intent, payload, **opts))

    async def broadcast(self, session: str, to_agents: List[str], intent: str, payload: Dict[str, Any], **opts: Any) -> List[Dict[str, Any]]:
        return await self._c._send(p.bus_broadcast(session, to_agents, intent, payload, **opts))

    async def claim(self, session: str, agent_id: str, count: int = 10) -> List[Dict[str, Any]]:
        return await self._c._send(p.bus_claim(session, agent_id, count))

    async def ack(self, session: str, message_id: str) -> Dict[str, Any]:
        return await self._c._send(p.bus_ack(session, message_id))

    async def reply(self, session: str, message_id: str, payload: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        return await self._c._send(p.bus_reply(session, message_id, payload, **opts))

    async def request(self, session: str, to_agent: str, intent: str, payload: Dict[str, Any], *, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        return await self._c._send(p.bus_request(session, to_agent, intent, payload, timeout_ms=timeout_ms))

    async def await_reply(self, session: str, message_id: str, *, timeout_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
        return await self._c._send(p.bus_await_reply(session, message_id, timeout_ms=timeout_ms))

    async def list_dlq(self, session: str, count: int = 100) -> List[Dict[str, Any]]:
        return await self._c._send(p.bus_list_dlq(session, count))

    async def replay_dlq(self, session: str, stream_id: str) -> Dict[str, Any]:
        return await self._c._send(p.bus_replay_dlq(session, stream_id))
