import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { createApp } from "../apps/api/src/app";
import { McpGateway } from "../apps/api/src/gateway";

/**
 * Local latency measurements on a throwaway database (no network, loopback only).
 * Run: npm run bench. Numbers depend on this machine; they are for spotting regressions, not marketing.
 */
const SECRET = "bench-secret-0123456789abcdef";
const tz = "Asia/Kolkata";
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms · p95 ${pct(xs, 95).toFixed(1)} ms · max ${Math.max(...xs).toFixed(1)} ms (n=${xs.length})`;
/** Every timed HTTP call must succeed: a benchmark that times error responses measures nothing. */
async function ok(r: Response) { if (!r.ok) throw new Error(`bench request failed: HTTP ${r.status} ${await r.text()}`); return r.json(); }
async function time(n: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < 5; i++) await fn(); // warm-up
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-bench-"));
const mcp = await startMcpServer({ port: 0, dbPath: path.join(tmp, "b.db"), approvalSecret: SECRET, allowDemoReset: true, tz });
const gw = new McpGateway(mcp.url);
const cfg = { port: 0, mcpUrl: mcp.url, webOrigins: ["http://localhost:5173"], tz, approvalSecret: SECRET, allowDemoReset: true, llm: { provider: "deterministic" as const, apiKey: "", model: "" }, dbPath: "" };
// the production chat limit (60/min) would turn most timed chat calls into 429s; the bench raises it for itself only
const api = http.createServer(createApp(gw, cfg, { chatRateLimit: 10_000 }));
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const H = { "content-type": "application/json", "x-homerelay-client": "web" };

// Seed a realistic working set: 30 situations, ~90 tasks.
for (let i = 0; i < 10; i++) {
  const d = String(10 + i).padStart(2, "0");
  for (const [cat, title] of [["maintenance", `Technician ${i}`], ["family_visit", `Visit ${i}`], ["general", `Errand ${i}`]] as const) {
    await gw.call("create_situation", { title, category: cat, expected_at: `2030-01-${d}T08:30:00.000Z`, ...(cat === "maintenance" ? { window_end: `2030-01-${d}T10:30:00.000Z`, available_from: `2030-01-${d}T09:30:00.000Z` } : {}), source: "user", initial_task_title: `Task for ${title}` });
  }
}
const list = await gw.call<any>("list_open_situations", { limit: 100 });
for (const s of list.situations.slice(0, 20)) { const p = await gw.call<any>("propose_plan", { situation_id: s.id }); if (p.proposal) await gw.call("approve_plan", { proposal_id: p.proposal.id, approval_token: SECRET }); }
const w = await gw.call<any>("get_workload_summary");

const results: Record<string, number[]> = {};
results["MCP round trip: get_workload_summary"] = await time(200, () => gw.call("get_workload_summary"));
results["MCP round trip: get_situation"] = await time(200, () => gw.call("get_situation", { situation_id: list.situations[0].id }));
results["MCP round trip: create_situation (write)"] = await time(100, () => gw.call("create_situation", { title: "bench", category: "general", source: "user" }));
results["HTTP GET /api/dashboard (3 MCP calls)"] = await time(100, () => fetch(`${base}/api/dashboard`).then(ok));
results["HTTP POST /api/chat (rules agent: what is pending)"] = await time(50, () => fetch(`${base}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message: "What is still pending?" }) }).then(ok));
results["HTTP POST /api/chat (rules agent: plan with 3 tool calls)"] = await time(30, async () => {
  const c = await gw.call<any>("create_situation", { title: "plan bench", category: "delivery", expected_at: "2030-02-01T11:30:00.000Z", source: "user" });
  await fetch(`${base}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message: "I'm free from 6 PM", activeSituationId: c.situation.id }) }).then(ok);
});

console.log(`HomeRelay bench (${os.cpus()[0].model.trim()}, Node ${process.version}); dataset: ${list.situations.length}+ situations, ${w.open_tasks} open tasks`);
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(62)} ${fmt(v)}`);

await new Promise((r) => api.close(r)); await gw.close(); await mcp.close(); fs.rmSync(tmp, { recursive: true, force: true });
