/**
 * Prometheus metrics. Exposed at GET /metrics. HTTP throughput/latency/errors
 * come from a Hono middleware; gauges (WS connections, audit-retry depth) are
 * updated by the relevant components/jobs.
 */
import { Counter, Histogram, Gauge, Registry } from "prom-client";

export const registry = new Registry();

export const metrics = {
  httpRequests: new Counter({
    name: "spanoai_http_requests_total",
    help: "HTTP requests by route and status",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  }),
  httpDurationMs: new Histogram({
    name: "spanoai_http_request_ms",
    help: "HTTP request duration (ms)",
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    labelNames: ["route"],
    registers: [registry],
  }),
  wsConnections: new Gauge({
    name: "spanoai_ws_connections",
    help: "Active WebSocket connections",
    registers: [registry],
  }),
  auditRetryDepth: new Gauge({
    name: "spanoai_audit_retry_depth",
    help: "Audit entries buffered in Redis awaiting Postgres",
    registers: [registry],
  }),
};
