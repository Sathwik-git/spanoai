/**
 * Agent identity + authorization.
 *
 * An AgentPrincipal is resolved from an API key by the auth layer and carries
 * the scopes and (optionally) the namespace allowlist that gate what an agent
 * may do. Facades accept an OPTIONAL principal: when absent the call is treated
 * as trusted/internal (no checks); when present, scope + namespace + tenant are
 * enforced. This is the per-agent ACL boundary.
 */
import { EngineError } from "../errors";

export const Scope = {
  CONTEXT_READ: "context:read",
  CONTEXT_WRITE: "context:write",
  MESSAGE_SEND: "message:send",
  MESSAGE_CLAIM: "message:claim",
  ARTIFACT_READ: "artifact:read",
  ARTIFACT_WRITE: "artifact:write",
  AUDIT_READ: "audit:read",
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

export interface AgentPrincipal {
  tenantId: string;
  agentId: string;
  scopes: Scope[];
  /** If set, the agent may only touch these namespaces; undefined = all. */
  namespaces?: string[];
}

/** Assert the principal belongs to the tenant it is operating on. */
export function requireTenant(
  principal: AgentPrincipal | undefined,
  tenantId: string,
): void {
  if (!principal) return;
  if (principal.tenantId !== tenantId) {
    throw new EngineError("CROSS_TENANT_DENIED", "Principal tenant mismatch.", 403);
  }
}

export function requireScope(
  principal: AgentPrincipal | undefined,
  scope: Scope,
): void {
  if (!principal) return;
  if (!principal.scopes.includes(scope)) {
    throw new EngineError("INSUFFICIENT_SCOPE", `Missing required scope: ${scope}`, 403);
  }
}

export function namespaceAllowed(
  principal: AgentPrincipal | undefined,
  namespace: string,
): boolean {
  if (!principal || !principal.namespaces) return true;
  return principal.namespaces.includes(namespace);
}

export function requireNamespace(
  principal: AgentPrincipal | undefined,
  namespace: string,
): void {
  if (namespaceAllowed(principal, namespace)) return;
  throw new EngineError(
    "NAMESPACE_FORBIDDEN",
    `No access to namespace: ${namespace}`,
    403,
  );
}

/** The namespace portion of a `namespace.key` full key. */
export function namespaceOf(fullKey: string): string {
  const dot = fullKey.indexOf(".");
  return dot === -1 ? fullKey : fullKey.slice(0, dot);
}
