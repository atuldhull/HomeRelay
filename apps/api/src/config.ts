import { DEFAULT_TZ } from "@homerelay/shared";
import { assertTimeZone, fromRoot, loadEnv } from "../../../scripts/env";

export interface ApiConfig {
  port: number;
  mcpUrl: string;
  webOrigins: string[];
  tz: string;
  approvalSecret: string;
  allowDemoReset: boolean;
  llm: { provider: "deterministic" | "anthropic"; apiKey: string; model: string; documentAccess?: boolean };
  dbPath: string;
}

export function loadConfig(): ApiConfig {
  loadEnv();
  const secret = process.env.APPROVAL_SECRET ?? "";
  if (secret.length < 16) throw new Error("APPROVAL_SECRET must be set (>= 16 chars). Copy .env.example to .env.");
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const wantLlm = (process.env.LLM_PROVIDER ?? "deterministic") === "anthropic";
  const webPort = process.env.WEB_PORT ?? "5173";
  return {
    port: Number(process.env.API_PORT ?? 3000),
    mcpUrl: process.env.MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 3001}/mcp`,
    webOrigins: [process.env.WEB_ORIGIN ?? `http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`],
    tz: assertTimeZone(process.env.APP_TIMEZONE ?? DEFAULT_TZ),
    approvalSecret: secret,
    allowDemoReset: process.env.ALLOW_DEMO_RESET !== "false",
    // LLM mode needs BOTH the provider switch and a key; otherwise we stay deterministic.
    llm: { provider: wantLlm && apiKey ? "anthropic" : "deterministic", apiKey, model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", documentAccess: process.env.LLM_DOCUMENT_ACCESS === "true" },
    dbPath: fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db"),
  };
}
