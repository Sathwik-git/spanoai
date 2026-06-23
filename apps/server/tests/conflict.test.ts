import { describe, test, expect } from "bun:test";
import { resolveConflict } from "../src/context-store/conflict";
import {
  ConflictStrategy,
  type ContextEntry,
  type ContextValue,
} from "../src/models/context-entry";

function existing(
  overrides: Partial<ContextEntry> = {},
): ContextEntry {
  return {
    tenantId: "t",
    sessionId: "s",
    namespace: "n",
    key: "k",
    fullKey: "n.k",
    value: { type: "json", data: { a: 1 } },
    writtenBy: "agent",
    writtenAt: 0,
    version: 1,
    confidence: 0.5,
    tags: [],
    ttlSeconds: 0,
    isDeleted: false,
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    operationId: "op",
    ...overrides,
  };
}

const jsonValue = (data: unknown): ContextValue => ({ type: "json", data });

describe("resolveConflict", () => {
  test("no existing entry: incoming always wins", () => {
    const d = resolveConflict(
      null,
      { value: jsonValue({ x: 1 }), confidence: 0.1, conflictStrategy: "lww", isDelete: false },
      false,
    );
    expect(d.winner).toBe("incoming");
  });

  test("reject: existing live entry wins", () => {
    const d = resolveConflict(
      existing(),
      { value: jsonValue({ x: 1 }), confidence: 1, conflictStrategy: "reject", isDelete: false },
      false,
    );
    expect(d).toEqual({ winner: "existing", reason: "exists" });
  });

  test("conf: higher confidence wins, lower keeps existing", () => {
    const higher = resolveConflict(
      existing({ confidence: 0.5 }),
      { value: jsonValue({}), confidence: 0.9, conflictStrategy: "conf", isDelete: false },
      false,
    );
    expect(higher.winner).toBe("incoming");

    const lower = resolveConflict(
      existing({ confidence: 0.9 }),
      { value: jsonValue({}), confidence: 0.5, conflictStrategy: "conf", isDelete: false },
      false,
    );
    expect(lower.winner).toBe("existing");
  });

  test("conf: equal confidence keeps existing unless CAS targeted it", () => {
    const kept = resolveConflict(
      existing({ confidence: 0.5 }),
      { value: jsonValue({}), confidence: 0.5, conflictStrategy: "conf", isDelete: false },
      false,
    );
    expect(kept.winner).toBe("existing");

    const cas = resolveConflict(
      existing({ confidence: 0.5 }),
      { value: jsonValue({}), confidence: 0.5, conflictStrategy: "conf", isDelete: false },
      true,
    );
    expect(cas.winner).toBe("incoming");
  });

  test("merge: shallow-merges objects, arrays replace", () => {
    const d = resolveConflict(
      existing({ value: jsonValue({ a: 1, list: [1, 2] }) }),
      { value: jsonValue({ b: 2, list: [9] }), confidence: 1, conflictStrategy: "merge", isDelete: false },
      false,
    );
    expect(d).toEqual({
      winner: "incoming",
      value: { type: "json", data: { a: 1, b: 2, list: [9] } },
    });
  });

  test("merge: non-object values fall back to last-write-wins", () => {
    const d = resolveConflict(
      existing({ value: { type: "text", text: "old" } }),
      { value: { type: "text", text: "new" }, confidence: 1, conflictStrategy: "merge", isDelete: false },
      false,
    );
    expect(d.winner).toBe("incoming");
    if (d.winner === "incoming") expect(d.value).toEqual({ type: "text", text: "new" });
  });

  test("delete always wins over an existing entry", () => {
    const d = resolveConflict(
      existing(),
      { value: jsonValue({}), confidence: 0, conflictStrategy: "reject", isDelete: true },
      false,
    );
    expect(d.winner).toBe("incoming");
  });
});
