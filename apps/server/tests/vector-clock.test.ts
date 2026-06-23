import { describe, test, expect } from "bun:test";
import { VectorClock } from "../src/audit-log/vector-clock";

describe("VectorClock", () => {
  test("tick increments a component and is immutable", () => {
    const a = {};
    const b = VectorClock.tick(a, "agent1");
    expect(b).toEqual({ agent1: 1 });
    expect(a).toEqual({});
    expect(VectorClock.tick(b, "agent1").agent1).toBe(2);
  });

  test("merge takes the component-wise maximum", () => {
    expect(VectorClock.merge({ a: 1, b: 3 }, { a: 2, c: 5 })).toEqual({
      a: 2,
      b: 3,
      c: 5,
    });
  });

  test("happenedBefore detects strict causal precedence", () => {
    expect(VectorClock.happenedBefore({ a: 1 }, { a: 2 })).toBe(true);
    expect(VectorClock.happenedBefore({ a: 1, b: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(VectorClock.happenedBefore({ a: 1 }, { a: 1 })).toBe(false);
    expect(VectorClock.happenedBefore({ a: 2 }, { a: 1 })).toBe(false);
  });

  test("compare classifies before / after / equal / concurrent", () => {
    expect(VectorClock.compare({ a: 1 }, { a: 2 })).toBe("before");
    expect(VectorClock.compare({ a: 2 }, { a: 1 })).toBe("after");
    expect(VectorClock.compare({ a: 1, b: 1 }, { a: 1, b: 1 })).toBe("equal");
    expect(VectorClock.compare({ a: 1, b: 0 }, { a: 0, b: 1 })).toBe(
      "concurrent",
    );
  });
});
