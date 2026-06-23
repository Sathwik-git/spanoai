# Coding Team

A coder writes its patch into shared context. A reviewer **blocks** on that key
with `context.awaitKey` (no busy-polling) until it appears, reads the diff, and
then the coder asks the reviewer for a verdict via correlated `request`/`reply`.

**Proves:** `awaitKey` as a single-producer handoff (the waiter unblocks the
instant the key is written), and request/reply correlation between two agents.

```bash
bun run examples/coding-team/index.ts
```

Assertions: reviewer unblocks on publish; reviewer sees the diff; coder gets the
verdict; verdict is `approved`.
