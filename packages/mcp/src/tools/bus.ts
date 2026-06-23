/**
 * Message-bus MCP tools: durable agent-to-agent messaging (the verbs memory
 * stores can't offer — send / claim / reply / request). Map onto `client.bus.*`.
 */
import { z } from "zod";
import type { AgentMessage } from "@spanoai/sdk";
import type { ToolContext } from "../config";
import {
  type SpanoTool,
  ok,
  guard,
  resolveSession,
  resolveAgent,
  toPayload,
  sessionArg,
  agentArg,
} from "./shared";

function describeMessage(m: AgentMessage): string {
  const body = m.payload.text ?? (m.payload.data !== undefined ? JSON.stringify(m.payload.data) : "");
  const preview = body.length > 200 ? `${body.slice(0, 197)}…` : body;
  return `[${m.id}] ${m.fromAgent} → ${m.toAgent} · ${m.intent}: ${preview}`;
}

export function busTools(): SpanoTool[] {
  return [
    {
      name: "spano_send",
      title: "Send a message",
      description:
        "Send a durable, fire-and-forget message to another agent's inbox in this session. The recipient claims it later with spano_claim. Provide text and/or structured data, and an intent (a short verb like 'review_request' or 'handoff').",
      inputSchema: {
        toAgent: z.string().describe("Recipient agent id."),
        intent: z.string().describe("Short verb describing the message, e.g. 'handoff'."),
        text: z.string().optional().describe("Human-readable message body."),
        data: z.any().optional().describe("Structured JSON payload."),
        priority: z.number().int().optional().describe("Higher is delivered first."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Send a message", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const priority = args.priority as number | undefined;
          const msg = await client.bus.dispatch(
            session,
            args.toAgent as string,
            args.intent as string,
            toPayload(args),
            priority !== undefined ? { priority } : {},
          );
          return ok(`Sent ${describeMessage(msg)}`, { messageId: msg.id, traceId: msg.traceId });
        }),
    },
    {
      name: "spano_broadcast",
      title: "Broadcast a message",
      description:
        "Send the same message to several agents at once (fan-out). Returns one message id per recipient; all share a traceId so replies can be correlated.",
      inputSchema: {
        toAgents: z.array(z.string()).min(1).describe("Recipient agent ids."),
        intent: z.string(),
        text: z.string().optional(),
        data: z.any().optional(),
        priority: z.number().int().optional(),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Broadcast a message", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const priority = args.priority as number | undefined;
          const msgs = await client.bus.broadcast(
            session,
            args.toAgents as string[],
            args.intent as string,
            toPayload(args),
            priority !== undefined ? { priority } : {},
          );
          return ok(`Broadcast to ${msgs.length} agent(s).`, {
            messageIds: msgs.map((m) => m.id),
            traceId: msgs[0]?.traceId,
          });
        }),
    },
    {
      name: "spano_claim",
      title: "Claim messages",
      description:
        "Claim up to `count` pending messages from this agent's inbox (default 10). Each claimed message must be acknowledged with spano_reply (which acks) or otherwise handled, or it is redelivered after the visibility timeout.",
      inputSchema: {
        count: z.number().int().positive().optional().describe("Max messages to claim (default 10)."),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Claim messages", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const agent = resolveAgent(args, ctx);
          const client = ctx.clientFor(agent);
          const count = (args.count as number | undefined) ?? 10;
          const msgs = await client.bus.claim(session, agent, count);
          if (msgs.length === 0) return ok("Inbox empty.", { messages: [] });
          const lines = msgs.map((m) => `• ${describeMessage(m)}`).join("\n");
          return ok(`Claimed ${msgs.length} message(s):\n${lines}`, { messages: msgs });
        }),
    },
    {
      name: "spano_reply",
      title: "Reply to a message",
      description:
        "Reply to a message you claimed (this also acknowledges it). The reply is routed back to the original sender and can unblock a spano_request / spano_await_reply they are waiting on.",
      inputSchema: {
        messageId: z.string().describe("Id of the message being replied to."),
        text: z.string().optional(),
        data: z.any().optional(),
        intent: z.string().optional(),
        priority: z.number().int().optional(),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Reply to a message", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const opts: { intent?: string; priority?: number } = {};
          if (typeof args.intent === "string") opts.intent = args.intent;
          if (args.priority !== undefined) opts.priority = args.priority as number;
          const reply = await client.bus.reply(session, args.messageId as string, toPayload(args), opts);
          return ok(`Replied to ${args.messageId} → ${reply.id}.`, { messageId: reply.id });
        }),
    },
    {
      name: "spano_request",
      title: "Request and await a reply",
      description:
        "Send a message to another agent and block until they reply (or the timeout elapses). Synchronous request/response over the bus — use when you need the answer before continuing. Default timeout 30000ms.",
      inputSchema: {
        toAgent: z.string(),
        intent: z.string(),
        text: z.string().optional(),
        data: z.any().optional(),
        timeoutMs: z.number().int().positive().optional(),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Request and await a reply", readOnlyHint: false, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const timeoutMs = args.timeoutMs as number | undefined;
          const { message, reply } = await client.bus.request(
            session,
            args.toAgent as string,
            args.intent as string,
            toPayload(args),
            timeoutMs !== undefined ? { timeoutMs } : {},
          );
          if (!reply) {
            return ok(`Request ${message.id} sent but no reply before timeout.`, {
              messageId: message.id,
              reply: null,
            });
          }
          return ok(`Reply: ${describeMessage(reply)}`, { messageId: message.id, reply });
        }),
    },
    {
      name: "spano_await_reply",
      title: "Await a reply",
      description:
        "Long-poll for the reply to a message you already sent (e.g. after spano_send or spano_broadcast). Returns the reply, or null if none arrives before the timeout (default 30000ms).",
      inputSchema: {
        messageId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
        session: sessionArg,
        agent: agentArg,
      },
      annotations: { title: "Await a reply", readOnlyHint: true, openWorldHint: true },
      handler: (args, ctx: ToolContext) =>
        guard(async () => {
          const session = resolveSession(args, ctx);
          const client = ctx.clientFor(resolveAgent(args, ctx));
          const timeoutMs = args.timeoutMs as number | undefined;
          const reply = await client.bus.awaitReply(
            session,
            args.messageId as string,
            timeoutMs !== undefined ? { timeoutMs } : {},
          );
          if (!reply) return ok("No reply yet.", { reply: null });
          return ok(`Reply: ${describeMessage(reply)}`, { reply });
        }),
    },
  ];
}
