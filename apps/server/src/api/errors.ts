/**
 * Unified API error shape. Every failure returns
 *   { error, message, code, docs, requestId }
 * EngineError carries its own code + HTTP status; Zod validation → 400;
 * anything unexpected → 500 (logged with the requestId).
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { EngineError } from "../errors";

const DOCS = "https://docs.spanoai.dev";

export interface ApiErrorBody {
  error: string;
  message: string;
  code: number;
  docs: string;
  requestId: string;
}

export function errorHandler(err: Error, c: Context): Response {
  const requestId = crypto.randomUUID();

  if (err instanceof EngineError) {
    const status = err.status as ContentfulStatusCode;
    return c.json<ApiErrorBody>(
      { error: err.code, message: err.message, code: err.status, docs: DOCS, requestId },
      status,
    );
  }

  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return c.json<ApiErrorBody>(
      { error: "VALIDATION_ERROR", message, code: 400, docs: DOCS, requestId },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return c.json<ApiErrorBody>(
      { error: "HTTP_ERROR", message: err.message, code: err.status, docs: DOCS, requestId },
      err.status,
    );
  }

  // Infra unreachable (Redis command timeout / closed connection) → 503, not 500.
  const msg = String(err?.message ?? "");
  if (/Command timed out|Connection is closed|ECONNREFUSED|ETIMEDOUT|Stream isn't writeable/i.test(msg)) {
    return c.json<ApiErrorBody>(
      { error: "SERVICE_UNAVAILABLE", message: "A backing service is unavailable.", code: 503, docs: DOCS, requestId },
      503,
    );
  }

  console.error("[api:500]", requestId, err);
  return c.json<ApiErrorBody>(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred", code: 500, docs: DOCS, requestId },
    500,
  );
}
