# Broadcast Fan-out

A coordinator broadcasts the **same** task to several workers in one call
(`bus.broadcast`). Each worker claims its own durable copy and replies. The
coordinator then collects every reply by long-polling each sent message id with
`bus.awaitReply`.

**Proves:** multi-recipient messaging (one call → one durable inbox per
recipient, all sharing a single `traceId`) and reply correlation after a
fan-out — the pattern that motivated adding `bus.awaitReply` to the SDK and a
`GET /messages/:id/await-reply` route to the API.

```bash
bun run examples/broadcast-fanout/index.ts
```

Assertions: one message per worker; all share one `traceId`; every worker
receives the broadcast; the coordinator collects a result from each.
