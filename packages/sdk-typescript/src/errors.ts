/** Error thrown by the SDK for any non-2xx API response. */
export class SpanoAIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "SpanoAIError";
  }

  /** Transient failures worth retrying (5xx, rate limit). */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimit(): boolean {
    return this.status === 429;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
}
