"""
Wire-protocol builders shared by the sync and async clients.

Keeping every path + body shape in ONE place is the parity guarantee: the sync
and async API classes both build their requests here, so they cannot drift from
each other (or from the TypeScript SDK).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

KNOWN_VALUE_TYPES = {"text", "json", "artifact", "artifacts"}


@dataclass
class Req:
    """A pending HTTP request: method, path, optional JSON body and query params."""

    method: str
    path: str
    json: Optional[Dict[str, Any]] = None
    params: Optional[Dict[str, Any]] = None


def to_value(value: Any) -> Dict[str, Any]:
    """Coerce a plain Python value into the engine's tagged ContextValue shape."""
    if isinstance(value, dict) and value.get("type") in KNOWN_VALUE_TYPES:
        return value
    if isinstance(value, str):
        return {"type": "text", "text": value}
    return {"type": "json", "data": value}


def op_id(provided: Optional[str] = None) -> str:
    """A stable operationId, reused across retries for idempotent replay."""
    return provided or str(uuid.uuid4())


def _compact(d: Dict[str, Any]) -> Dict[str, Any]:
    """Drop keys whose value is None (so we don't send nulls the engine rejects)."""
    return {k: v for k, v in d.items() if v is not None}


# ── Context ─────────────────────────────────────────────────────────────────

def ctx_write(
    session: str,
    namespace: str,
    key: str,
    value: Any,
    *,
    confidence: Optional[float] = None,
    ttl_seconds: Optional[int] = None,
    conflict_strategy: Optional[str] = None,
    expected_version: Optional[int] = None,
    tags: Optional[List[str]] = None,
    allow_restore: Optional[bool] = None,
    written_by: Optional[str] = None,
    operation_id: Optional[str] = None,
) -> Req:
    body = _compact({
        "value": to_value(value),
        "operationId": op_id(operation_id),
        "confidence": confidence,
        "ttlSeconds": ttl_seconds,
        "conflictStrategy": conflict_strategy,
        "expectedVersion": expected_version,
        "tags": tags,
        "allowRestore": allow_restore,
        "writtenBy": written_by,
    })
    return Req("POST", f"/context/{session}/{namespace}/{key}", body)


def ctx_read(session: str, namespace: str, key: str) -> Req:
    return Req("GET", f"/context/{session}/{namespace}/{key}")


def ctx_append(
    session: str,
    namespace: str,
    key: str,
    items: List[Any],
    *,
    max_items: Optional[int] = None,
    operation_id: Optional[str] = None,
) -> Req:
    body = _compact({"items": items, "operationId": op_id(operation_id), "maxItems": max_items})
    return Req("POST", f"/context/{session}/{namespace}/{key}/append", body)


def ctx_increment(
    session: str,
    namespace: str,
    key: str,
    by: float = 1,
    *,
    operation_id: Optional[str] = None,
) -> Req:
    body = {"by": by, "operationId": op_id(operation_id)}
    return Req("POST", f"/context/{session}/{namespace}/{key}/increment", body)


def ctx_list(session: str, namespace: Optional[str] = None) -> Req:
    return Req("GET", f"/context/{session}", params=_compact({"namespace": namespace}))


def ctx_history(session: str, namespace: str, key: str) -> Req:
    return Req("GET", f"/context/{session}/{namespace}/{key}/history")


def ctx_delete(session: str, namespace: str, key: str) -> Req:
    return Req("DELETE", f"/context/{session}/{namespace}/{key}")


def ctx_await(session: str, namespace: str, key: str, *, timeout_ms: Optional[int] = None) -> Req:
    return Req(
        "GET",
        f"/context/{session}/{namespace}/{key}/await",
        params=_compact({"timeoutMs": timeout_ms}),
    )


def ctx_search(session: str, query: str, top_k: int = 10) -> Req:
    return Req("POST", f"/context/{session}/search", {"query": query, "topK": top_k})


# ── Bus ─────────────────────────────────────────────────────────────────────

def bus_dispatch(
    session: str,
    to_agent: str,
    intent: str,
    payload: Dict[str, Any],
    *,
    priority: Optional[int] = None,
    timeout_ms: Optional[int] = None,
    max_retries: Optional[int] = None,
    operation_id: Optional[str] = None,
) -> Req:
    body = _compact({
        "sessionId": session,
        "toAgent": to_agent,
        "intent": intent,
        "payload": payload,
        "priority": priority,
        "timeoutMs": timeout_ms,
        "maxRetries": max_retries,
        "operationId": op_id(operation_id),
    })
    return Req("POST", "/messages", body)


def bus_broadcast(
    session: str,
    to_agents: List[str],
    intent: str,
    payload: Dict[str, Any],
    *,
    priority: Optional[int] = None,
    timeout_ms: Optional[int] = None,
    max_retries: Optional[int] = None,
) -> Req:
    body = _compact({
        "sessionId": session,
        "toAgents": to_agents,
        "intent": intent,
        "payload": payload,
        "priority": priority,
        "timeoutMs": timeout_ms,
        "maxRetries": max_retries,
    })
    return Req("POST", "/messages/broadcast", body)


def bus_claim(session: str, agent_id: str, count: int = 10) -> Req:
    return Req("POST", f"/messages/{agent_id}/claim", params={"sessionId": session, "count": count})


def bus_ack(session: str, message_id: str) -> Req:
    return Req("POST", f"/messages/{message_id}/ack", params={"sessionId": session})


def bus_reply(
    session: str,
    message_id: str,
    payload: Dict[str, Any],
    *,
    intent: Optional[str] = None,
    priority: Optional[int] = None,
) -> Req:
    body = _compact({"payload": payload, "intent": intent, "priority": priority})
    return Req("POST", f"/messages/{message_id}/reply", body, params={"sessionId": session})


def bus_request(
    session: str,
    to_agent: str,
    intent: str,
    payload: Dict[str, Any],
    *,
    timeout_ms: Optional[int] = None,
) -> Req:
    body = _compact({
        "sessionId": session,
        "toAgent": to_agent,
        "intent": intent,
        "payload": payload,
        "timeoutMs": timeout_ms,
    })
    return Req("POST", "/messages/request", body)


def bus_await_reply(session: str, message_id: str, *, timeout_ms: Optional[int] = None) -> Req:
    return Req(
        "GET",
        f"/messages/{message_id}/await-reply",
        params=_compact({"sessionId": session, "timeoutMs": timeout_ms}),
    )


def bus_list_dlq(session: str, count: int = 100) -> Req:
    return Req("GET", "/messages/dlq", params={"sessionId": session, "count": count})


def bus_replay_dlq(session: str, stream_id: str) -> Req:
    return Req("POST", f"/messages/dlq/{stream_id}/replay", params={"sessionId": session})


# ── Sessions ────────────────────────────────────────────────────────────────

def sess_create(
    session_id: Optional[str] = None,
    *,
    ttl_seconds: Optional[int] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Req:
    body = _compact({"sessionId": session_id, "ttlSeconds": ttl_seconds, "metadata": metadata})
    return Req("POST", "/sessions", body)


def sess_get(session_id: str) -> Req:
    return Req("GET", f"/sessions/{session_id}")


def sess_list() -> Req:
    return Req("GET", "/sessions")


def sess_join(session_id: str, agent_id: Optional[str] = None) -> Req:
    return Req("POST", f"/sessions/{session_id}/join", _compact({"agentId": agent_id}))


def sess_leave(session_id: str, agent_id: Optional[str] = None) -> Req:
    return Req("POST", f"/sessions/{session_id}/leave", _compact({"agentId": agent_id}))


def sess_abort(session_id: str) -> Req:
    return Req("POST", f"/sessions/{session_id}/abort")


def sess_end(session_id: str) -> Req:
    return Req("DELETE", f"/sessions/{session_id}")


# ── Artifacts ───────────────────────────────────────────────────────────────

def art_init_upload(
    session: str, name: str, mime_type: str, size_bytes: int, sha256: Optional[str] = None
) -> Req:
    body = _compact({
        "sessionId": session,
        "name": name,
        "mimeType": mime_type,
        "sizeBytes": size_bytes,
        "sha256": sha256,
    })
    return Req("POST", "/artifacts/init-upload", body)


def art_complete(artifact_id: str, sha256: str) -> Req:
    return Req("POST", f"/artifacts/{artifact_id}/complete", {"sha256": sha256})


def art_metadata(session: str, artifact_id: str) -> Req:
    return Req("GET", f"/artifacts/{artifact_id}", params={"sessionId": session})


def art_download_url(session: str, artifact_id: str) -> Req:
    return Req("POST", f"/artifacts/{artifact_id}/download-url", params={"sessionId": session})


def art_delete(session: str, artifact_id: str) -> Req:
    return Req("DELETE", f"/artifacts/{artifact_id}", params={"sessionId": session})


# ── Streaming ───────────────────────────────────────────────────────────────

def stream_ticket(session: str) -> Req:
    return Req("POST", "/stream-ticket", {"sessionId": session})
