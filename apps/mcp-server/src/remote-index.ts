import path from "node:path";
import { DEFAULT_TZ } from "@homerelay/shared";
import { assertTimeZone, fromRoot, loadEnv } from "../../../scripts/env";
import { createRemoteApp } from "./remote";
import type { OAuthClient } from "./oauth";

/** Entry point for the opt-in remote profile. Off unless REMOTE_PROFILE_ENABLED=true; binds to loopback only. */
loadEnv();
const fail = (msg: string) => { console.error(`[remote] ${msg}`); process.exit(1); };
if (process.env.REMOTE_PROFILE_ENABLED !== "true") fail("The remote profile is off. Set REMOTE_PROFILE_ENABLED=true (see docs/ALEXA_PLUS_INTEGRATION.md).");
const baseUrl = (process.env.REMOTE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) fail("REMOTE_BASE_URL must be set to the public https:// origin your reverse proxy serves.");
const ownerPasswordHash = process.env.REMOTE_OWNER_PASSWORD_HASH ?? "";
if (!ownerPasswordHash.startsWith("scrypt$")) fail("REMOTE_OWNER_PASSWORD_HASH is missing. Run `npm run remote:owner`.");
let clients: OAuthClient[] = [];
try { clients = JSON.parse(process.env.REMOTE_OAUTH_CLIENTS ?? "[]"); } catch { fail("REMOTE_OAUTH_CLIENTS is not valid JSON."); }
if (!Array.isArray(clients) || !clients.length) fail("REMOTE_OAUTH_CLIENTS has no client. Run `npm run remote:client -- <redirect-uri>`.");

const dbPath = fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db");
const port = Number(process.env.REMOTE_PORT ?? 3002);
const host = process.env.REMOTE_BIND ?? "127.0.0.1";
try {
  const { app, db, close } = createRemoteApp({
    baseUrl, clients, ownerPasswordHash, dbPath,
    tz: assertTimeZone(process.env.APP_TIMEZONE ?? DEFAULT_TZ),
    documentsDir: process.env.DOCUMENTS_DIR ? fromRoot(process.env.DOCUMENTS_DIR) : path.join(path.dirname(dbPath), "documents"),
    trustProxy: process.env.REMOTE_TRUST_PROXY === "true",
    logRequests: process.env.REMOTE_LOG_REQUESTS !== "false",
    assetsDir: process.env.REMOTE_ASSETS_DIR ?? fromRoot("assets/brand/addon"),
    legal: { operator: process.env.LEGAL_OPERATOR_NAME, contact: process.env.LEGAL_CONTACT_EMAIL, jurisdiction: process.env.LEGAL_JURISDICTION, effectiveDate: process.env.LEGAL_EFFECTIVE_DATE },
  });
  const server = app.listen(port, host, () => {
    console.log(`[remote] HomeRelay remote MCP profile on http://${host}:${port} (public: ${baseUrl}/mcp)`);
    console.log(`[remote] ${clients.length} OAuth client(s) registered; database: ${dbPath}`);
  }).on("error", (e: any) => fail(e?.code === "EADDRINUSE" ? `port ${port} is in use. Set REMOTE_PORT.` : String(e)));
  // Graceful stop (docker stop sends SIGTERM): finish in-flight requests, then close the database so the WAL is checkpointed.
  const shutdown = (sig: string) => {
    console.log(`[remote] ${sig} received, shutting down`);
    close();
    server.close(() => { db.close(); console.log("[remote] stopped cleanly"); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => { db.close(); process.exit(0); }, 8000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
} catch (e) { fail((e as Error).message); }
