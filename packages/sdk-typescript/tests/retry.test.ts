import { describe, test, expect } from "bun:test";
import { SpanoAIClient } from "../src/client";
import { SpanoAIError } from "../src/errors";

describe("SDK retry idempotency", () => {
  test("a retried mutating call reuses the same operationId", async () => {
    const bodies: Array<{ operationId?: string }> = [];
    let calls = 0;
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "INTERNAL_ERROR", message: "boom", code: 503 }), { status: 503 });
      }
      return new Response(JSON.stringify({ outcome: "written", version: 1, entry: null }), { status: 201 });
    }) as unknown as typeof fetch;

    const client = new SpanoAIClient({ baseUrl: "http://x", apiKey: "k", agent: "a", fetch: fakeFetch });
    const result = await client.context.append("s", "n", "k", ["item"]);

    expect(calls).toBe(2); // one failure, one retry
    expect(bodies[0]!.operationId).toBeDefined();
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId); // SAME op across the retry
    expect(result.outcome).toBe("written");
  });

  test("read of a missing key returns null (a miss is not an error)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "ENTRY_NOT_FOUND", message: "nope", code: 404 }), { status: 404 })) as unknown as typeof fetch;
    const client = new SpanoAIClient({ baseUrl: "http://x", apiKey: "k", agent: "a", fetch: fakeFetch });
    expect(await client.context.read("s", "n", "missing")).toBeNull();
  });

  test("non-retryable errors (e.g. 403) are not retried", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "INSUFFICIENT_SCOPE", message: "no", code: 403 }), { status: 403 });
    }) as unknown as typeof fetch;

    const client = new SpanoAIClient({ baseUrl: "http://x", apiKey: "k", agent: "a", fetch: fakeFetch });
    let err: unknown;
    try {
      await client.context.read("s", "n", "k");
    } catch (e) {
      err = e;
    }
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(SpanoAIError);
    expect((err as SpanoAIError).isForbidden).toBe(true);
  });
});
