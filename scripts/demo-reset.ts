import { McpGateway } from "../apps/api/src/gateway";
import { loadEnv } from "./env";

/** Removes ONLY simulated (demo) data through the real MCP server. User-created data is never touched. */
loadEnv();
const secret = process.env.APPROVAL_SECRET ?? "";
const url = process.env.MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 3001}/mcp`;
if (secret.length < 16) { console.error("APPROVAL_SECRET is not set (see .env.example)."); process.exit(1); }

const gw = new McpGateway(url, 5000);
try {
  const r = await gw.call<{ situations_removed: number }>("reset_demo_data", { approval_token: secret });
  console.log(`Demo data reset: ${r.situations_removed} simulated situation(s) removed. User data untouched.`);
} catch (e: any) {
  console.error(`Reset failed: ${e?.message ?? e}\nIs the MCP server running? (npm run dev:mcp)`);
  process.exitCode = 1;
} finally {
  await gw.close();
}
