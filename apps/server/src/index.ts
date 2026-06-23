/**
 * Engine entry point: boots the engine, serves the HTTP + WebSocket API,
 * runs background jobs, and wires graceful shutdown.
 */
import { config } from "./config";
import { createEngine } from "./engine";
import { createApp, websocket } from "./api/app";
import { startBackgroundJobs } from "./jobs";
import { closeConnections } from "./redis";
import { closeSql } from "./db/client";
import { HashEmbedder } from "./search/embedder";

// Wire the dependency-free embedder so semantic search works out of the box.
// Set SPANOAI_EMBEDDER=none to disable, or inject a real model via createEngine.
const embedder = config.SPANOAI_EMBEDDER === "hash" ? new HashEmbedder() : undefined;
export const engine = createEngine(embedder ? { embedder } : {});
const app = createApp(engine);

const stopJobs = startBackgroundJobs({
  scheduler: engine.scheduler,
  busBackend: engine.busBackend,
  sessions: engine.sessions,
  artifacts: engine.artifacts,
  audit: engine.audit,
});

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  websocket,
});

console.log(`SpanoAI API listening on http://localhost:${server.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down`);
  stopJobs();
  server.stop(false);
  await closeConnections();
  await closeSql();
  console.log("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
