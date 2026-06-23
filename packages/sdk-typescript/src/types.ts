/** Public response/option types (mirrors the server's wire shapes). */

export type ContextValue<T = unknown> =
  | { type: "text"; text: string }
  | { type: "json"; data: T }
  | { type: "artifact"; artifact: ArtifactRef }
  | { type: "artifacts"; artifacts: ArtifactRef[] };

export interface ArtifactRef {
  id: string;
  kind: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  name?: string;
}

export interface ContextEntry<T = unknown> {
  tenantId: string;
  sessionId: string;
  namespace: string;
  key: string;
  fullKey: string;
  value: ContextValue<T>;
  writtenBy: string;
  writtenAt: number;
  version: number;
  confidence: number;
  tags: string[];
  ttlSeconds: number;
  isDeleted: boolean;
  operationId: string;
}

export interface WriteResult {
  outcome: "written" | "deleted" | "kept_existing" | "rejected" | "conflict";
  entry: ContextEntry | null;
  version: number | null;
  reason?: string;
  idempotentReplay?: boolean;
}

export interface WriteOptions {
  confidence?: number;
  ttlSeconds?: number;
  conflictStrategy?: "lww" | "conf" | "merge" | "reject";
  expectedVersion?: number;
  tags?: string[];
  operationId?: string;
  allowRestore?: boolean;
  writtenBy?: string;
}

export interface AgentMessage<T = unknown> {
  id: string;
  tenantId: string;
  sessionId: string;
  traceId: string;
  fromAgent: string;
  toAgent: string;
  intent: string;
  priority: number;
  payload: { text?: string; data?: T; artifacts: ArtifactRef[] };
  replyTo?: string;
  createdAt: number;
  timeoutMs: number;
  operationId: string;
  retryCount: number;
  maxRetries: number;
  status: string;
}

export interface Session {
  sessionId: string;
  tenantId: string;
  createdBy: string;
  status: string;
  createdAt: number;
  ttlSeconds: number;
  metadata: Record<string, unknown>;
  members: string[];
  aborted: boolean;
}

export interface Artifact {
  id: string;
  tenantId: string;
  sessionId: string;
  createdByAgent: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  status: string;
}

export interface InitUploadResult {
  artifactId: string;
  uploadUrl: string;
  method: "PUT";
  storageKey: string;
  expiresAt: number;
}

export interface DownloadGrant {
  url: string;
  expiresAt: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StreamEvent {
  event: string;
  seq?: number;
  ts?: number;
  [k: string]: unknown;
}
