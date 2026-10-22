import http from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { McpGateway } from "./gateway";

const cfg = loadConfig();
const gw = new McpGateway(cfg.mcpUrl);
const uploadLimit = process.env.DOCUMENT_MAX_MB ? Math.round(Number(process.env.DOCUMENT_MAX_MB) * 1024 * 1024) : undefined;
const server = http.createServer(createApp(gw, cfg, { uploadLimit }));

server.once("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") console.error(`[api] port ${cfg.port} is in use. Set API_PORT in .env to a free port.`);
  else console.error("[api] failed to start:", e);
  process.exit(1);
});
server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`[api] HomeRelay API on http://127.0.0.1:${cfg.port}  (agent mode: ${cfg.llm.provider}, MCP: ${cfg.mcpUrl})`);
});
