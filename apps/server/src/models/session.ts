/**
 * Session model. A session is the unit agents coordinate within — it owns a
 * TTL, a membership roster, and an abort flag for cancellation propagation.
 */
import { z } from "zod";
import { SAFE_ID } from "./context-entry";

export const SessionStatus = {
  ACTIVE: "active",
  ENDED: "ended",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export interface Session {
  sessionId: string;
  tenantId: string;
  createdBy: string;
  status: SessionStatus;
  createdAt: number;
  ttlSeconds: number;
  metadata: Record<string, unknown>;
  members: string[];
  aborted: boolean;
}

export const CreateSessionRequestSchema = z.object({
  sessionId: z
    .string()
    .regex(SAFE_ID)
    .default(() => `run-${crypto.randomUUID().slice(0, 12)}`),
  createdBy: z.string().min(1),
  ttlSeconds: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionRequestInput = z.input<typeof CreateSessionRequestSchema>;
