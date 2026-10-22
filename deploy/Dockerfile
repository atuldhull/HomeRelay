# HomeRelay remote MCP profile (the OAuth-protected endpoint an Alexa+ add-on calls).
# Build from the repo root:  docker build -f deploy/Dockerfile -t homerelay-remote:local .
# No secrets are baked in: configuration arrives at run time through environment variables.

# ---- build: compile the TypeScript entry points into self-contained ESM files ----
FROM node:22.19.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mcp-server apps/mcp-server
COPY scripts/env.ts scripts/backup.ts scripts/restore.ts scripts/remote-setup.ts scripts/
# Runtime packages stay external (installed in the deps stage); HomeRelay's own code is bundled.
RUN npx esbuild apps/mcp-server/src/remote-index.ts scripts/backup.ts scripts/restore.ts scripts/remote-setup.ts \
      --bundle --platform=node --format=esm --target=node22 --outdir=dist \
      --external:better-sqlite3 --external:unpdf --external:express --external:@modelcontextprotocol/sdk --external:zod

# ---- deps: production dependencies of the MCP server only; the compiler toolchain stays in this stage ----
FROM node:22.19.0-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace @homerelay/mcp-server --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM node:22.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY assets/brand/addon ./assets/addon
RUN printf '{"type":"module","private":true}\n' > package.json && mkdir -p /data && chown node:node /data
USER node
ENV DATABASE_PATH=/data/homerelay.db DOCUMENTS_DIR=/data/documents REMOTE_PORT=3002 REMOTE_BIND=0.0.0.0 REMOTE_ASSETS_DIR=/app/assets/addon
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3002/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/apps/mcp-server/src/remote-index.js"]
