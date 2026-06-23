/**
 * Structured engine error.
 *
 * Carries a machine-readable `code` and an HTTP `status` so the (future) route
 * layer can map failures to the unified API error format without sniffing
 * messages.
 */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
