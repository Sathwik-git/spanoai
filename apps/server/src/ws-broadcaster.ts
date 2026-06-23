/**
 * WebSocket broadcaster — multi-server aware.
 *
 * Every event gets a per-session monotonic `seq` (atomic INCR) and is appended
 * to a bounded Redis replay buffer (last N events, TTL'd), then published on a
 * tenant-scoped channel that every server subscribes to. A reconnecting client
 * sends its `lastSeq`; `getMissed` returns the events it missed, or tells it to
 * reload from the audit log if the gap is larger than the buffer.
 *
 * Live delivery is best-effort: the audit log remains the source of truth.
 */
import type { Redis } from "ioredis";
import { config } from "./config";
import type { BroadcastEvent, EventBroadcaster } from "./backends/interfaces";

export interface SeqEvent extends BroadcastEvent {
  seq: number;
  ts: number;
}

export interface MissedEvents {
  /** True when the gap exceeds the buffer — client should reload from audit. */
  reload: boolean;
  events: SeqEvent[];
}

type LocalHandler = (event: SeqEvent) => void;

export class WSBroadcaster implements EventBroadcaster {
  private readonly handlers = new Map<string, Set<LocalHandler>>();
  private readonly subscribedChannels = new Set<string>();

  constructor(
    private readonly redis: Redis,
    private readonly redisPub: Redis,
    private readonly redisSub: Redis,
  ) {
    // Fan incoming cross-server messages out to local subscribers.
    this.redisSub.on("message", (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set || set.size === 0) return;
      let event: SeqEvent;
      try {
        event = JSON.parse(message) as SeqEvent;
      } catch {
        return;
      }
      for (const handler of set) handler(event);
    });
  }

  private channel(tenantId: string, sessionId: string): string {
    return `spanoai:t:${tenantId}:broadcast:${sessionId}`;
  }
  private seqKey(tenantId: string, sessionId: string): string {
    return `spanoai:t:${tenantId}:ws:${sessionId}:seq`;
  }
  private bufKey(tenantId: string, sessionId: string): string {
    return `spanoai:t:${tenantId}:ws:${sessionId}:buf`;
  }

  /** Assign a seq, buffer the event, and publish it to all servers. */
  async broadcast(
    tenantId: string,
    sessionId: string,
    event: BroadcastEvent,
  ): Promise<SeqEvent> {
    const seq = await this.redis.incr(this.seqKey(tenantId, sessionId));
    const enriched: SeqEvent = { ...event, seq, ts: Date.now() };
    const payload = JSON.stringify(enriched);
    const bufKey = this.bufKey(tenantId, sessionId);

    await this.redis
      .multi()
      .rpush(bufKey, payload)
      .ltrim(bufKey, -config.SPANOAI_WS_BUFFER_SIZE, -1)
      .expire(bufKey, config.SPANOAI_WS_BUFFER_TTL_SECONDS)
      .exec();

    await this.redisPub.publish(this.channel(tenantId, sessionId), payload);
    return enriched;
  }

  /** Events with seq > lastSeq, or a reload signal if the gap is too large. */
  async getMissed(
    tenantId: string,
    sessionId: string,
    lastSeq: number,
  ): Promise<MissedEvents> {
    const items = await this.redis.lrange(
      this.bufKey(tenantId, sessionId),
      0,
      -1,
    );
    const events = items.map((i) => JSON.parse(i) as SeqEvent);

    if (events.length === 0) return { reload: false, events: [] };

    const oldest = events[0]!.seq;
    // The next event the client needs is lastSeq + 1; if that already fell out
    // of the buffer, it must reload from the durable audit log.
    if (lastSeq + 1 < oldest) return { reload: true, events: [] };

    return { reload: false, events: events.filter((e) => e.seq > lastSeq) };
  }

  /**
   * Register a local listener for a {tenant, session} room and ensure this
   * server is subscribed to the cross-server channel. Returns an unsubscribe fn.
   */
  async subscribe(
    tenantId: string,
    sessionId: string,
    handler: LocalHandler,
  ): Promise<() => Promise<void>> {
    const channel = this.channel(tenantId, sessionId);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    if (!this.subscribedChannels.has(channel)) {
      await this.redisSub.subscribe(channel);
      this.subscribedChannels.add(channel);
    }

    return async () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        this.subscribedChannels.delete(channel);
        await this.redisSub.unsubscribe(channel);
      }
    };
  }
}
