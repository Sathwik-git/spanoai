"""Error type raised by the SDK for any non-2xx API response."""
from __future__ import annotations

from typing import Optional


class SpanoAIError(Exception):
    """Raised for any non-2xx API response (mirrors the TS ``SpanoAIError``)."""

    def __init__(
        self,
        message: str,
        status: int,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id

    @property
    def is_retryable(self) -> bool:
        """Transient failures worth retrying (5xx, rate limit)."""
        return self.status >= 500 or self.status == 429

    @property
    def is_not_found(self) -> bool:
        return self.status == 404

    @property
    def is_conflict(self) -> bool:
        return self.status == 409

    @property
    def is_rate_limit(self) -> bool:
        return self.status == 429

    @property
    def is_forbidden(self) -> bool:
        return self.status == 403
