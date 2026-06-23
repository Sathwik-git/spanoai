/**
 * Schema-level input validation (pure, no infra). Identifiers that compose
 * Redis keys must be sanitised so they cannot inject the ':' / '|' delimiters.
 */
import { describe, test, expect } from "bun:test";
import { AgentMessageSchema } from "../src/models/agent-message";
import { ContextWriteRequestSchema } from "../src/models/context-entry";

describe("identifier sanitisation", () => {
  test("agent ids with ':' or '|' are rejected", () => {
    const base = { tenantId: "t", sessionId: "s", intent: "i", payload: { text: "x" } };
    expect(() => AgentMessageSchema.parse({ ...base, fromAgent: "a", toAgent: "evil|x" })).toThrow();
    expect(() => AgentMessageSchema.parse({ ...base, fromAgent: "a:b", toAgent: "b" })).toThrow();
    expect(() => AgentMessageSchema.parse({ ...base, fromAgent: "a b", toAgent: "b" })).toThrow();
  });

  test("clean agent ids are accepted", () => {
    const msg = AgentMessageSchema.parse({
      tenantId: "t", sessionId: "s", intent: "i", payload: { text: "x" },
      fromAgent: "agent-1", toAgent: "agent_2.worker",
    });
    expect(msg.toAgent).toBe("agent_2.worker");
  });

  test("context namespace/key with ':' are rejected", () => {
    const base = { sessionId: "s", value: { type: "text", text: "x" }, writtenBy: "w" };
    expect(() => ContextWriteRequestSchema.parse({ ...base, namespace: "n:x", key: "k" })).toThrow();
    expect(() => ContextWriteRequestSchema.parse({ ...base, namespace: "n", key: "k|y" })).toThrow();
  });
});
