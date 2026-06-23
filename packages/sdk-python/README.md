# spanoai (Python SDK)

Python client for **SpanoAI** — shared working memory (a context store) **plus a
durable message bus** for multi-agent AI systems. Sync and async, fully typed.

```bash
pip install spanoai
```

## Quickstart

```python
from spanoai import SpanoAI

spano = SpanoAI(api_key="sk_...", agent="researcher")
spano.sessions.create("run-1")

# shared memory
spano.context.write("run-1", "researcher", "findings", {"revenue": "$4.2M"})
entry = spano.context.read("run-1", "researcher", "findings")
print(entry["value"]["data"])               # {'revenue': '$4.2M'}

# message bus — ask another agent and block for the reply
res = spano.bus.request("run-1", "reviewer", "review", {"data": {"pr": 1}}, timeout_ms=5000)
print(res["reply"]["payload"]["data"])
```

## Async

```python
import asyncio
from spanoai import AsyncSpanoAI

async def main():
    async with AsyncSpanoAI(api_key="sk_...", agent="planner") as spano:
        await spano.context.write("run-1", "planner", "goal", "ship it")
        async for event in spano.stream("run-1"):
            print(event["event"])
            break

asyncio.run(main())
```

## Surface

The Python surface mirrors the TypeScript SDK 1:1 (snake_case):

- `context`: `write`, `read`, `append`, `increment`, `await_key`, `search`, `history`, `list`, `delete`
- `bus`: `dispatch`, `broadcast`, `claim`, `ack`, `reply`, `request`, `await_reply`, `list_dlq`, `replay_dlq`
- `sessions`: `create`, `get`, `list`, `join`, `leave`, `abort`, `end`
- `artifacts`: `upload`, `download`, `init_upload`, `complete`, `get_metadata`, `download_url`, `delete`
- `stream(session, on_event)` (sync) / `stream(session)` async iterator

`read()` returns `None` on a miss. Other non-2xx responses raise
`SpanoAIError(status, code, request_id)`. Mutating calls auto-generate an
`operationId` and reuse it across retries (5xx / 429 / network) so a retry
replays idempotently.

## Configuration

```python
SpanoAI(
    api_key="sk_...",
    base_url="http://localhost:8000",   # default
    agent="default",                     # X-SpanoAI-Agent identity
    max_retries=3,
    timeout=30.0,
)
```

## License

MIT
