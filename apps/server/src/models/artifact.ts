/**
 * Artifact model.
 *
 * An artifact is a file whose BYTES live in object storage; this record holds
 * only the reference, checksum, and lifecycle status. Lifecycle:
 *   pending --(verified)--> available
 *           --(failed verify)--> rejected
 *           --(scanner)--> quarantined
 *           --(delete)--> deleted
 */
import { z } from "zod";
import { ArtifactKindSchema, SAFE_ID } from "./context-entry";

export const ArtifactStatus = {
  PENDING: "pending",
  AVAILABLE: "available",
  QUARANTINED: "quarantined",
  REJECTED: "rejected",
  DELETED: "deleted",
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

/** The stored artifact record (internal; not parsed from the DB at runtime). */
export interface Artifact {
  id: string;
  tenantId: string;
  sessionId: string;
  createdByAgent: string;
  /** Display name. Never used to build storage paths. */
  name: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  kind: z.infer<typeof ArtifactKindSchema>;
  status: ArtifactStatus;
  createdAt: number;
  availableAt: number | null;
  expiresAt: number | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export const InitUploadRequestSchema = z.object({
  sessionId: z.string().regex(SAFE_ID),
  createdByAgent: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  /** Expected size in bytes; verified against the actual upload on complete. */
  sizeBytes: z.number().int().nonnegative(),
  /** Optional at init; required and verified at complete. */
  sha256: z.string().regex(SHA256_HEX).optional(),
  kind: ArtifactKindSchema.default("file"),
});
export type InitUploadRequest = z.infer<typeof InitUploadRequestSchema>;
export type InitUploadRequestInput = z.input<typeof InitUploadRequestSchema>;

export interface InitUploadResult {
  artifactId: string;
  uploadUrl: string;
  method: "PUT";
  storageKey: string;
  /** Epoch ms when the upload URL expires. */
  expiresAt: number;
}

export const CompleteUploadRequestSchema = z.object({
  /** The uploader's computed checksum; verified server-side. */
  sha256: z.string().regex(SHA256_HEX),
  byAgent: z.string().min(1),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;
export type CompleteUploadRequestInput = z.input<typeof CompleteUploadRequestSchema>;

export interface DownloadGrant {
  url: string;
  /** Epoch ms when the download URL expires. */
  expiresAt: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
