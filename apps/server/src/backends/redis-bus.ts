/**
 * Redis-backed Message Bus.
 *
 * Durable delivery uses Redis Streams + consumer groups (at-least-once).
 * Pub/Sub is ONLY a wake-up hint for connected consumers — never the source of
 * truth. Each agent inbox is split across five priority streams (p5..p1);
 * `claim()` drains them highest-first.
 *
 * Delivery guarantees:
 *   - XADD writes the message durably before enqueue returns.
 *   - XREADGROUP moves a message into the consumer's pending list (PEL); it is
 *     only removed by XACK after the consumer succeeds or replies.
 *   - A crashed consumer leaves the message pending; `reclaimStuck()` (run by a
 *     background sweeper) uses XAUTOCLAIM to re-enqueue it, incrementing
 *     retryCount, and dead-letters it once maxRetries is exceeded.
 */
import type { Redis } from "ioredis";
import { config } from "../config";
import type {
  BusBackend,
  MessageMeta,
  DlqEntry,
  ReclaimReport,
} from "./interfaces";
import { type AgentMessage, type Priority } from "../models/agent-message";

const PRIORITIES: Priority[] = [5, 4, 3, 2, 1];
const RECOVERY_CONSUMER = "sweeper";

type StreamEntry = [id: string, fields: string[]];
type StreamReadResult = Array<[stream: string, entries: StreamEntry[]]>;
type AutoClaimResult = [cursor: string, entries: StreamEntry[], deleted: string[]];

function fieldsToRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i] as string] = fields[i + 1] as string;
  }
  return out;
}

export class RedisBus implements BusBackend {
  constructor(
    private readonly r: Redis,
    private readonly pub: Redis,
  ) {}

  private inboxKey(tid: string, sid: string, agent: string, p: Priority): string {
    return `spanoai:t:${tid}:bus:${sid}:${agent}:p${p}:stream`;
  }
  private notifyKey(tid: string, sid: string, agent: string): string {
    return `spanoai:t:${tid}:bus:${sid}:${agent}:notify`;
  }
  private dlqKey(tid: string, sid: string): string {
    return `spanoai:t:${tid}:bus:${sid}:dlq`;
  }
  private replyKey(tid: string, sid: string, originalId: string): string {
    return `spanoai:t:${tid}:bus:${sid}:reply:${originalId}`;
  }
  private metaKey(tid: string, sid: string, msgId: string): string {
    return `spanoai:t:${tid}:bus:${sid}:msg:${msgId}`;
  }
  private group(agent: string): string {
    return `agent:${agent}`;
  }

  private async ensureGroup(streamKey: string, group: string): Promise<void> {
    try {
      await this.r.xgroup("CREATE", streamKey, group, "0", "MKSTREAM");
    } catch (err) {
      // The group already exists — the only error we expect to swallow.
      if (!String((err as Error)?.message).includes("BUSYGROUP")) throw err;
    }
  }

  private async writeMeta(meta: MessageMeta): Promise<void> {
    const { message } = meta;
    await this.r.set(
      this.metaKey(message.tenantId, message.sessionId, message.id),
      JSON.stringify(meta),
      "EX",
      config.SPANOAI_OPS_TTL_SECONDS,
    );
  }

  private inboxRegistryKey(): string {
    return `spanoai:bus:inboxes`;
  }

  async listInboxes(): Promise<
    Array<{ tenantId: string; sessionId: string; agentId: string }>
  > {
    const members = await this.r.smembers(this.inboxRegistryKey());
    return members.map((m) => {
      const [tenantId, sessionId, agentId] = m.split("|");
      return { tenantId: tenantId ?? "", sessionId: sessionId ?? "", agentId: agentId ?? "" };
    });
  }

  async pruneInbox(tenantId: string, sessionId: string, agentId: string): Promise<void> {
    await this.r.srem(this.inboxRegistryKey(), `${tenantId}|${sessionId}|${agentId}`);
  }

  async enqueue(msg: AgentMessage): Promise<{ streamId: string }> {
    const streamKey = this.inboxKey(
      msg.tenantId,
      msg.sessionId,
      msg.toAgent,
      msg.priority,
    );
    // Register the inbox so the background sweeper can find it without SCAN.
    await this.r.sadd(
      this.inboxRegistryKey(),
      `${msg.tenantId}|${msg.sessionId}|${msg.toAgent}`,
    );

    const streamId = await this.r.xadd(
      streamKey,
      "MAXLEN",
      "~",
      config.SPANOAI_STREAM_MAXLEN,
      "*",
      "id",
      msg.id,
      "operationId",
      msg.operationId,
      "priority",
      String(msg.priority),
      "data",
      JSON.stringify(msg),
    );

    await this.writeMeta({
      message: msg,
      streamId: streamId as string,
      priority: msg.priority,
      group: this.group(msg.toAgent),
      status: "queued",
    });

    // Best-effort wake-up; consumers must still claim durably.
    await this.pub.publish(
      this.notifyKey(msg.tenantId, msg.sessionId, msg.toAgent),
      JSON.stringify({ type: "message_available", priority: msg.priority }),
    );

    return { streamId: streamId as string };
  }

  async claim(
    tenantId: string,
    sessionId: string,
    agentId: string,
    consumerId: string,
    count: number,
  ): Promise<AgentMessage[]> {
    const group = this.group(agentId);
    const claimed: AgentMessage[] = [];

    for (const priority of PRIORITIES) {
      if (claimed.length >= count) break;
      const streamKey = this.inboxKey(tenantId, sessionId, agentId, priority);
      await this.ensureGroup(streamKey, group);

      const remaining = count - claimed.length;
      const res = (await this.r.xreadgroup(
        "GROUP",
        group,
        consumerId,
        "COUNT",
        remaining,
        "STREAMS",
        streamKey,
        ">",
      )) as unknown as StreamReadResult | null;
      if (!res) continue;

      for (const [, entries] of res) {
        for (const [streamId, fields] of entries) {
          const record = fieldsToRecord(fields);
          if (!record.data) continue;
          const message = JSON.parse(record.data) as AgentMessage;

          await this.writeMeta({
            message,
            streamId,
            priority,
            group,
            status: "claimed",
          });
          claimed.push(message);
        }
      }
    }

    return claimed;
  }

  async getMeta(
    tenantId: string,
    sessionId: string,
    messageId: string,
  ): Promise<MessageMeta | null> {
    const raw = await this.r.get(this.metaKey(tenantId, sessionId, messageId));
    return raw ? (JSON.parse(raw) as MessageMeta) : null;
  }

  async recordReply(reply: AgentMessage, originalId: string): Promise<void> {
    await this.r.set(
      this.replyKey(reply.tenantId, reply.sessionId, originalId),
      JSON.stringify(reply),
      "EX",
      config.SPANOAI_OPS_TTL_SECONDS,
    );
  }

  async takeReply(
    tenantId: string,
    sessionId: string,
    originalId: string,
  ): Promise<AgentMessage | null> {
    const raw = await this.r.get(this.replyKey(tenantId, sessionId, originalId));
    return raw ? (JSON.parse(raw) as AgentMessage) : null;
  }

  async ack(
    tenantId: string,
    sessionId: string,
    messageId: string,
  ): Promise<boolean> {
    const meta = await this.getMeta(tenantId, sessionId, messageId);
    if (!meta) return false;

    const streamKey = this.inboxKey(
      tenantId,
      sessionId,
      meta.message.toAgent,
      meta.priority,
    );
    await this.r.xack(streamKey, meta.group, meta.streamId);
    await this.writeMeta({ ...meta, status: "acked" });
    return true;
  }

  async moveToDlq(
    tenantId: string,
    sessionId: string,
    msg: AgentMessage,
    reason: string,
  ): Promise<void> {
    const dlqKey = this.dlqKey(tenantId, sessionId);
    const meta = await this.getMeta(tenantId, sessionId, msg.id);
    const failedAt = Date.now();

    const pipe = this.r.multi().xadd(
      dlqKey,
      "*",
      "data",
      JSON.stringify(msg),
      "reason",
      reason,
      "failedAt",
      String(failedAt),
      "origId",
      msg.id,
    );
    // Acknowledge the poisoned message off its inbox stream in the same txn.
    if (meta) {
      const streamKey = this.inboxKey(
        tenantId,
        sessionId,
        meta.message.toAgent,
        meta.priority,
      );
      pipe.xack(streamKey, meta.group, meta.streamId);
    }
    await pipe.exec();

    if (meta) await this.writeMeta({ ...meta, status: "dead_letter" });
  }

  async listDlq(
    tenantId: string,
    sessionId: string,
    count: number,
  ): Promise<DlqEntry[]> {
    const dlqKey = this.dlqKey(tenantId, sessionId);
    const res = (await this.r.xrevrange(
      dlqKey,
      "+",
      "-",
      "COUNT",
      count,
    )) as unknown as StreamEntry[];

    return res.map(([streamId, fields]) => {
      const record = fieldsToRecord(fields);
      return {
        streamId,
        message: JSON.parse(record.data ?? "{}") as AgentMessage,
        reason: record.reason ?? "unknown",
        failedAt: Number(record.failedAt ?? 0),
      };
    });
  }

  async removeFromDlq(
    tenantId: string,
    sessionId: string,
    streamId: string,
  ): Promise<boolean> {
    const removed = await this.r.xdel(this.dlqKey(tenantId, sessionId), streamId);
    return removed > 0;
  }

  async reclaimStuck(
    tenantId: string,
    sessionId: string,
    agentId: string,
    minIdleMs: number,
  ): Promise<ReclaimReport> {
    const group = this.group(agentId);
    const report: ReclaimReport = { reclaimed: 0, retried: [], deadLettered: [] };

    for (const priority of PRIORITIES) {
      const streamKey = this.inboxKey(tenantId, sessionId, agentId, priority);
      await this.ensureGroup(streamKey, group);

      let cursor = "0-0";
      do {
        const [next, entries] = (await this.r.xautoclaim(
          streamKey,
          group,
          RECOVERY_CONSUMER,
          minIdleMs,
          cursor,
          "COUNT",
          100,
        )) as unknown as AutoClaimResult;
        cursor = next;

        for (const [streamId, fields] of entries) {
          const record = fieldsToRecord(fields);
          if (!record.data) continue;
          const msg = JSON.parse(record.data) as AgentMessage;
          report.reclaimed += 1;

          const nextAttempt = { ...msg, retryCount: msg.retryCount + 1 };

          if (nextAttempt.retryCount > nextAttempt.maxRetries) {
            // Exhausted retries: DLQ the message and ack the stuck entry.
            await this.r
              .multi()
              .xadd(
                this.dlqKey(tenantId, sessionId),
                "*",
                "data",
                JSON.stringify({ ...nextAttempt, status: "dead_letter" }),
                "reason",
                "max_retries_exceeded",
                "failedAt",
                String(Date.now()),
                "origId",
                msg.id,
              )
              .xack(streamKey, group, streamId)
              .exec();
            const meta = await this.getMeta(tenantId, sessionId, msg.id);
            if (meta) await this.writeMeta({ ...meta, status: "dead_letter" });
            report.deadLettered.push({
              message: nextAttempt,
              reason: "max_retries_exceeded",
            });
          } else {
            // Re-enqueue a fresh delivery, then ack the old (stuck) entry.
            const newId = await this.r.xadd(
              streamKey,
              "MAXLEN",
              "~",
              config.SPANOAI_STREAM_MAXLEN,
              "*",
              "id",
              nextAttempt.id,
              "operationId",
              nextAttempt.operationId,
              "priority",
              String(nextAttempt.priority),
              "data",
              JSON.stringify(nextAttempt),
            );
            await this.r.xack(streamKey, group, streamId);
            await this.writeMeta({
              message: nextAttempt,
              streamId: newId as string,
              priority,
              group,
              status: "queued",
            });
            report.retried.push(nextAttempt);
          }
        }
      } while (cursor !== "0-0");
    }

    return report;
  }
}
