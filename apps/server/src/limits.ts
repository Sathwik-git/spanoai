/**
 * Inline payload limits and path-safety helpers.
 *
 * The inline cap is the "claim check" threshold: a context value or message
 * payload bigger than this must be uploaded as an artifact (object storage)
 * rather than living in Redis. This protects the real-time path — large Redis
 * values inflate latency, replication, and fork-based persistence, and on the
 * context path they are duplicated into history.
 */
import { config } from "./config";
import { EngineError } from "./errors";

/** UTF-8 byte length of a value's JSON serialisation. */
export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

/**
 * Throw PAYLOAD_TOO_LARGE if `value` serialises to more than the inline cap.
 * Artifact-reference values are tiny and pass naturally.
 */
export function assertInlineSize(
  value: unknown,
  label: string,
  max: number = config.SPANOAI_MAX_INLINE_BYTES,
): void {
  const size = byteLength(value);
  if (size > max) {
    throw new EngineError(
      "PAYLOAD_TOO_LARGE",
      `${label} is ${size} bytes, which exceeds the ${max}-byte inline limit. ` +
        `Upload it as an artifact and share a reference instead.`,
      413,
    );
  }
}

/**
 * Reduce a user-supplied file name to a safe object-key segment: basename only,
 * conservative charset, no leading dots (blocks path traversal like
 * "../../etc/passwd"). The original name is preserved separately for display.
 */
export function safeFileName(name: string | undefined, fallback = "file"): string {
  if (!name) return fallback;
  const base = name.replace(/^.*[\\/]/, ""); // strip any directory part
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const trimmed = cleaned.slice(0, 200);
  return trimmed.length > 0 ? trimmed : fallback;
}
