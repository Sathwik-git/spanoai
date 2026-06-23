import { describe, test, expect } from "bun:test";
import { assertInlineSize, byteLength, safeFileName } from "../src/limits";
import { EngineError } from "../src/errors";

describe("assertInlineSize", () => {
  test("accepts small payloads", () => {
    expect(() => assertInlineSize({ a: 1, b: "hello" }, "value")).not.toThrow();
  });

  test("rejects payloads over the cap with PAYLOAD_TOO_LARGE (413)", () => {
    const big = { blob: "x".repeat(300 * 1024) }; // ~300 KB > 256 KB default
    let err: unknown;
    try {
      assertInlineSize(big, "value");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("PAYLOAD_TOO_LARGE");
    expect((err as EngineError).status).toBe(413);
  });

  test("respects a custom max", () => {
    expect(() => assertInlineSize({ a: "hello world" }, "value", 4)).toThrow();
  });

  test("byteLength measures UTF-8 JSON size", () => {
    expect(byteLength("hi")).toBe(4); // the quotes count: "hi"
  });
});

describe("safeFileName", () => {
  test("strips path traversal down to a basename", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Windows\\system32\\evil.dll")).toBe("evil.dll");
  });

  test("replaces unsafe characters and falls back when empty", () => {
    expect(safeFileName("weird name!@#.txt")).toBe("weird_name___.txt");
    expect(safeFileName(undefined)).toBe("file");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("...")).toBe("file");
  });
});
