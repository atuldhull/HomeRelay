import { DEFAULT_TZ } from "@homerelay/shared";
import { assertTimeZone, fromRoot, loadEnv } from "../../../scripts/env";
import { startMcpServer } from "./server";

loadEnv();
const secret = process.env.APPROVAL_SECRET;
if (!secret || secret.length < 16) {
  console.error("APPROVAL_SECRET must be set (>= 16 chars). Copy .env.example to .env.");
  process.exit(1);
}

const port = Number(process.env.MCP_PORT ?? 3001);
const dbPath = fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db");
try {
  const s = await startMcpServer({
    port, dbPath, approvalSecret: secret,
    allowDemoReset: process.env.ALLOW_DEMO_RESET !== "false",
    tz: assertTimeZone(process.env.APP_TIMEZONE ?? DEFAULT_TZ),
    documentsDir: process.env.DOCUMENTS_DIR ? fromRoot(process.env.DOCUMENTS_DIR) : undefined,
    maxDocumentBytes: process.env.DOCUMENT_MAX_MB ? Math.round(Number(process.env.DOCUMENT_MAX_MB) * 1024 * 1024) : undefined,
  });
  console.log(`[mcp] HomeRelay MCP server (Streamable HTTP, spec 2025-11-25) listening on ${s.url}`);
  console.log(`[mcp] database: ${dbPath}`);
} catch (e: any) {
  if (e?.code === "EADDRINUSE") console.error(`[mcp] port ${port} is in use. Set MCP_PORT in .env to a free port.`);
  else console.error("[mcp] failed to start:", e);
  process.exit(1);
}
