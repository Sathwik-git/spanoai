/**
 * MessageBus — the public Message Bus facade.
 *
 * Wraps the durable BusBackend with audit + best-effort broadcast. Delivery is
 * at-least-once; consumers must dedupe using `operationId` / `message.id`.
 *
 * `runId` defaults to `sessionId` (one run per session in the MVP).
 */
import type {
  BusBackend,
  EventBroadcaster,
  DlqEntry,
  ReclaimReport,
  SessionToucher,
} from "../backends/interfaces";
import type { AuditLog } from "../audit-log";
import { EngineError } from "../errors";
import { assertInlineSize } from "../limits";
import {
  Scope,
  requireTenant,
  requireScope,
  type AgentPrincipal,
} from "../auth/principal";
import {
  AgentMessageSchema,
  isExpired,
  type AgentMessage,
  type AgentMessageInput,
  type AgentMessagePayloadInput,
  type Priority,
} from "../models/agent-message";
import { EventType } from "../models/audit-entry";

export interface ReplyInput {
  fromAgent: string;
  payload: AgentMessagePayloadInput;
  intent?: string;
  priority?: Priority;
}

export interface SweepTarget {
  tenantId: string;
  sessionId: string;
  agentId: string;
  runId?: string;
}

export class MessageBus {
  constructor(
    private readonly backend: BusBackend,
    private readonly audit: AuditLog,
    private readonly broadcaster: EventBroadcaster,
    private readonly sessions?: SessionToucher,
  ) {}

  /** Enqueue a durable message to its target agent's inbox. */
  async dispatch(
    tenantId: string,
    input: Omit<AgentMessageInput, "tenantId">,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<AgentMessage> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.MESSAGE_SEND);
    const msg = AgentMessageSchema.parse({ ...input, tenantId });
    // Claim-check guard: oversized payloads must be shared as artifacts.
    assertInlineSize(msg.payload, "message payload");
    await this.backend.enqueue(msg);
    if (this.sessions) {
      await this.sessions.touch(tenantId, msg.sessionId, msg.fromAgent).catch(() => {});
    }

    await this.audit.append({
      tenantId,
      runId: runId ?? msg.sessionId,
      agentId: msg.fromAgent,
      eventType: EventType.MSG_DISPATCHED,
      payload: {
        messageId: msg.id,
        toAgent: msg.toAgent,
        intent: msg.intent,
        priority: msg.priority,
        operationId: msg.operationId,
      },
    });

    this.emit(tenantId, msg.sessionId, {
      event: EventType.MSG_DISPATCHED,
      messageId: msg.id,
      fromAgent: msg.fromAgent,
      toAgent: msg.toAgent,
      intent: msg.intent,
      priority: msg.priority,
    });

    return msg;
  }

  /**
   * Fan-out: dispatch the same message to multiple agents at once. Each
   * recipient gets its own durable message (own id) under a shared traceId so
   * the fan-out is correlatable. Returns one AgentMessage per recipient.
   */
  async broadcast(
    tenantId: string,
    input: Omit<AgentMessageInput, "tenantId" | "toAgent"> & { toAgents: string[] },
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<AgentMessage[]> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.MESSAGE_SEND);
    const { toAgents, ...rest } = input;
    if (!Array.isArray(toAgents) || toAgents.length === 0) {
      throw new EngineError("MISSING_PARAM", "broadcast requires a non-empty toAgents array.", 400);
    }
    const unique = Array.from(new Set(toAgents));
    const traceId = rest.traceId ?? crypto.randomUUID();
    const out: AgentMessage[] = [];
    for (const toAgent of unique) {
      out.push(await this.dispatch(tenantId, { ...rest, toAgent, traceId }, runId, principal));
    }
    return out;
  }

  /** Claim up to `count` messages for an agent (highest priority first). */
  async claim(
    tenantId: string,
    sessionId: string,
    agentId: string,
    consumerId: string,
    count = 10,
    runId?: string,
    principal?: AgentPrincipal,
  ): Promise<AgentMessage[]> {
    requireTenant(principal, tenantId);
    requireScope(principal, Scope.MESSAGE_CLAIM);
    const messages = await this.backend.claim(
      tenantId,
      sessionId,
      agentId,
      consumerId,
      count,
    );

    for (const m of messages) {
      await this.audit.append({
        tenantId,
        runId: runId ?? sessionId,
        agentId,
        eventType: EventType.MSG_DELIVERED,
        payload: { messageId: m.id, fromAgent: m.fromAgent, intent: m.intent },
      });
    }
    if (messages.length > 0) {
      this.emit(tenantId, sessionId, {
        event: EventType.MSG_DELIVERED,
        agentId,
        count: messages.length,
      });
    }

    return messages;
  }

  /** Acknowledge successful processing of a claimed message. */
  ack(
    tenantId: string,
    sessionId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.backend.ack(tenantId, sessionId, messageId);
  }

  /** Reply to a message and acknowledge the original in one step. */
  async reply(
    tenantId: string,
    sessionId: string,
    originalMessageId: string,
    input: ReplyInput,
    runId?: string,
  ): Promise<AgentMessage> {
    const meta = await this.backend.getMeta(tenantId, sessionId, originalMessageId);
    if (!meta) {
      throw new EngineError(
        "MESSAGE_NOT_FOUND",
        `Message ${originalMessageId} not found`,
        404,
      );
    }
    const original = meta.message;
    if (original.tenantId !== tenantId || original.sessionId !== sessionId) {
      throw new EngineError(
        "MESSAGE_NOT_FOUND",
        "Message does not belong to this tenant/session",
        404,
      );
    }
    if (isExpired(original)) {
      throw new EngineError(
        "MESSAGE_EXPIRED",
        `Message ${originalMessageId} has expired`,
        409,
      );
    }

    const reply = AgentMessageSchema.parse({
      tenantId,
      sessionId,
      fromAgent: input.fromAgent,
      toAgent: original.fromAgent,
      intent: input.intent ?? `reply:${original.intent}`,
      priority: input.priority ?? original.priority,
      payload: input.payload,
      replyTo: original.id,
      traceId: original.traceId,
    });

    await this.backend.enqueue(reply);
    await this.backend.ack(tenantId, sessionId, original.id);
    // Record the reply keyed by the original id so request()/awaitReply() can
    // correlate it without the asker having to drain its inbox.
    await this.backend.recordReply(reply, original.id);

    await this.audit.append({
      tenantId,
      runId: runId ?? sessionId,
      agentId: input.fromAgent,
      eventType: EventType.MSG_REPLIED,
      payload: { replyTo: original.id, messageId: reply.id, toAgent: reply.toAgent },
    });
    this.emit(tenantId, sessionId, {
      event: EventType.MSG_REPLIED,
      replyTo: original.id,
      messageId: reply.id,
    });

    return reply;
  }

  /**
   * Send a message and block until its reply arrives (or timeout → null).
   * Correlated by the dispatched message id; the responder uses `reply()`.
   */
  async request(
    tenantId: string,
    input: Omit<AgentMessageInput, "tenantId">,
    opts?: { timeoutMs?: number; pollMs?: number; runId?: string; principal?: AgentPrincipal },
  ): Promise<{ message: AgentMessage; reply: AgentMessage | null }> {
    const message = await this.dispatch(tenantId, input, opts?.runId, opts?.principal);
    const reply = await this.awaitReply(tenantId, message.sessionId, message.id, opts);
    return { message, reply };
  }

  /** Block until a reply to `originalMessageId` is recorded, or timeout → null. */
  async awaitReply(
    tenantId: string,
    sessionId: string,
    originalMessageId: string,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<AgentMessage | null> {
    const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
    const pollMs = opts?.pollMs ?? 150;
    for (;;) {
      const reply = await this.backend.takeReply(tenantId, sessionId, originalMessageId);
      if (reply) return reply;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
    }
  }

  listDlq(
    tenantId: string,
    sessionId: string,
    count = 100,
  ): Promise<DlqEntry[]> {
    return this.backend.listDlq(tenantId, sessionId, count);
  }

  /** Re-dispatch a dead-lettered message with a fresh operationId + id. */
  async replayDlq(
    tenantId: string,
    sessionId: string,
    streamId: string,
    runId?: string,
  ): Promise<AgentMessage | null> {
    const entries = await this.backend.listDlq(tenantId, sessionId, 1000);
    const found = entries.find((e) => e.streamId === streamId);
    if (!found) return null;

    const fresh = AgentMessageSchema.parse({
      ...found.message,
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      retryCount: 0,
      status: "queued",
      createdAt: Date.now(),
    });

    await this.backend.enqueue(fresh);
    await this.backend.removeFromDlq(tenantId, sessionId, streamId);

    await this.audit.append({
      tenantId,
      runId: runId ?? sessionId,
      agentId: fresh.fromAgent,
      eventType: EventType.MSG_RETRY,
      payload: { messageId: fresh.id, replayedFromDlq: streamId },
    });
    this.emit(tenantId, sessionId, {
      event: EventType.MSG_RETRY,
      messageId: fresh.id,
      replayedFromDlq: streamId,
    });

    return fresh;
  }

  /**
   * Reclaim claimed-but-unacked messages idle longer than `minIdleMs`,
   * re-enqueueing or dead-lettering each, and auditing the outcome per message.
   */
  async sweep(target: SweepTarget, minIdleMs: number): Promise<ReclaimReport> {
    const report = await this.backend.reclaimStuck(
      target.tenantId,
      target.sessionId,
      target.agentId,
      minIdleMs,
    );
    const runId = target.runId ?? target.sessionId;

    for (const m of report.retried) {
      await this.audit.append({
        tenantId: target.tenantId,
        runId,
        agentId: m.toAgent,
        eventType: EventType.MSG_RETRY,
        payload: { messageId: m.id, retryCount: m.retryCount },
      });
    }
    for (const { message, reason } of report.deadLettered) {
      await this.audit.append({
        tenantId: target.tenantId,
        runId,
        agentId: message.toAgent,
        eventType: EventType.MSG_DEAD_LETTER,
        payload: { messageId: message.id, reason },
      });
      this.emit(target.tenantId, target.sessionId, {
        event: EventType.MSG_DEAD_LETTER,
        messageId: message.id,
        reason,
      });
    }

    return report;
  }

  private emit(
    tenantId: string,
    sessionId: string,
    event: { event: string; [k: string]: unknown },
  ): void {
    void Promise.resolve(
      this.broadcaster.broadcast(tenantId, sessionId, event),
    ).catch(() => {
      /* live delivery is best-effort */
    });
  }
}

export { StreamScheduler } from "./stream-scheduler";
