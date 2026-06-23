# @spanoai/sdk

TypeScript SDK for **SpanoAI** — shared working memory (a context store) **plus a
durable message bus** for multi-agent AI systems. A thin, typed wrapper over the
HTTP + WebSocket API with retries, reconnect, and idempotent operations built in.

```bash
npm i @spanoai/sdk
```

## Quickstart

```ts
import { SpanoAIClient } from "@spanoai/sdk";

const spano = new SpanoAIClient({
  baseUrl: "http://localhost:8000",
  apiKey: process.env.SPANOAI_KEY!,
  agent: "researcher", // identity sent on every request
});

await spano.sessions.create({ sessionId: "run-1" });

// shared memory
await spano.context.write("run-1", "researcher", "findings", { revenue: "$4.2M" });
const entry = await spano.context.read("run-1", "researcher", "findings");

// message bus — ask another agent and block for the reply
const { reply } = await spano.bus.request("run-1", "reviewer", "review", { data: { pr: 1 } }, { timeoutMs: 5000 });
```

## Surface

- `context`: `write`, `read`, `append`, `increment`, `awaitKey`, `search`, `history`, `list`, `delete`
- `bus`: `dispatch`, `broadcast`, `claim`, `ack`, `reply`, `request`, `awaitReply`, `listDlq`, `replayDlq`
- `sessions`: `create`, `get`, `list`, `join`, `leave`, `abort`, `end`
- `artifacts`: `upload`, `download`, `initUpload`, `complete`, `getMetadata`, `downloadUrl`, `delete`
- `stream(sessionId, { onEvent })` — live session events over WebSocket (ticket auth, auto-reconnect, gap recovery)

`read()` resolves to `null` on a miss; other non-2xx responses throw
`SpanoAIError`. Mutating calls generate an `operationId` and reuse it across
retries (5xx / 429) so a retry replays idempotently.

## Build

This package ships ESM + CJS + type declarations:

```bash
bun run build   # tsup → dist/{index.js,index.cjs,index.d.ts}
```

## License

MIT
