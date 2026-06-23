# SpanoAI engine (HTTP + WebSocket API). The engine is self-contained — it has
# no cross-package imports — so we install only its own dependencies, keeping
# the image small.
#
# Build from the REPO ROOT (so the COPY paths resolve):
#   docker build -f apps/server/Dockerfile -t spanoai-server .
#
# Run migrations once against your database, then start the server:
#   docker run --rm --env-file .env spanoai-server bun run src/db/migrate.ts
#   docker run -d --env-file .env -p 8000:8000 --name spanoai spanoai-server
FROM oven/bun:1 AS deps
WORKDIR /app
COPY apps/server/package.json ./package.json
RUN bun install

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server/package.json ./package.json
COPY apps/server/src ./src

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

# Liveness: the engine exposes /health (200 when Redis + Postgres are reachable).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
