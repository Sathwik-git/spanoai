# Parallel Research

Five researcher agents work **concurrently**, each appending its finding to one
shared list (`shared.findings`). A lead agent waits on a client-side barrier
until all five have reported, then reads the consolidated result.

**Proves:** atomic `context.append` under concurrency — no finding is lost
despite five simultaneous writers racing on the same key.

```bash
bun run examples/parallel-research/index.ts
```

Assertions: all 5 findings preserved (no lost updates); all 5 distinct areas present.
