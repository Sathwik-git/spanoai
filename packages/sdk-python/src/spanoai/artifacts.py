"""Artifacts API: store/retrieve file bytes via presigned object storage."""
from __future__ import annotations

import hashlib
from typing import Any, Dict, Optional

from . import _proto as p


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ArtifactsApi:
    """Synchronous artifact operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    def init_upload(self, session: str, name: str, mime_type: str, size_bytes: int, sha256: Optional[str] = None) -> Dict[str, Any]:
        return self._c._send(p.art_init_upload(session, name, mime_type, size_bytes, sha256))

    def complete(self, artifact_id: str, sha256: str) -> Dict[str, Any]:
        return self._c._send(p.art_complete(artifact_id, sha256))

    def get_metadata(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return self._c._send(p.art_metadata(session, artifact_id))

    def download_url(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return self._c._send(p.art_download_url(session, artifact_id))

    def delete(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return self._c._send(p.art_delete(session, artifact_id))

    def upload(self, session: str, name: str, mime_type: str, data: bytes) -> Dict[str, Any]:
        """One-call upload: init → PUT bytes to storage → complete (verified)."""
        sha256 = _sha256_hex(data)
        init = self.init_upload(session, name, mime_type, len(data), sha256)
        self._c._put_bytes(init["uploadUrl"], data, mime_type)
        return self.complete(init["artifactId"], sha256)

    def download(self, session: str, artifact_id: str) -> bytes:
        """One-call download: resolve a signed URL → fetch the bytes."""
        grant = self.download_url(session, artifact_id)
        return self._c._get_bytes(grant["url"])


class AsyncArtifactsApi:
    """Asynchronous artifact operations."""

    def __init__(self, client: Any) -> None:
        self._c = client

    async def init_upload(self, session: str, name: str, mime_type: str, size_bytes: int, sha256: Optional[str] = None) -> Dict[str, Any]:
        return await self._c._send(p.art_init_upload(session, name, mime_type, size_bytes, sha256))

    async def complete(self, artifact_id: str, sha256: str) -> Dict[str, Any]:
        return await self._c._send(p.art_complete(artifact_id, sha256))

    async def get_metadata(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return await self._c._send(p.art_metadata(session, artifact_id))

    async def download_url(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return await self._c._send(p.art_download_url(session, artifact_id))

    async def delete(self, session: str, artifact_id: str) -> Dict[str, Any]:
        return await self._c._send(p.art_delete(session, artifact_id))

    async def upload(self, session: str, name: str, mime_type: str, data: bytes) -> Dict[str, Any]:
        sha256 = _sha256_hex(data)
        init = await self.init_upload(session, name, mime_type, len(data), sha256)
        await self._c._put_bytes(init["uploadUrl"], data, mime_type)
        return await self.complete(init["artifactId"], sha256)

    async def download(self, session: str, artifact_id: str) -> bytes:
        grant = await self.download_url(session, artifact_id)
        return await self._c._get_bytes(grant["url"])
