# Artifact Share

A producer uploads a file (direct-to-object-storage via a presigned URL, then
verified by size + SHA-256 so the engine never proxies bytes). It hands the
artifact reference to a consumer over a message. The consumer downloads the
bytes with a short-lived URL and checks they match exactly.

**Proves:** the full artifact lifecycle between agents (upload → reference →
download), claim-check handoff over the message bus, and session-scoped
isolation (the artifact is invisible from another session).

```bash
bun run examples/artifact-share/index.ts
```

Assertions: artifact becomes `available` after verification; consumer receives
the reference; metadata + size match; downloaded bytes are byte-identical to the
original; the artifact is not readable from a different session.
