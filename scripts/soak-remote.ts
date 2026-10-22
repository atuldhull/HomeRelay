import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fromRoot } from "./env";

/**
 * Endurance test of a running REMOTE profile, from outside, over its real OAuth lifecycle.
 *   npm run test:soak:remote -- <base-url> --minutes 120
 * Links once through the owner sign-in, then for the whole duration: about one MCP tool call per second (reads,
 * situation/constraint writes, plan drafts), a token refresh every 10 minutes, and once a minute probes that must be
 * refused (no token, revoked token, a prohibited tool). Results go to .data/soak-remote/<run>/summary.json.
 * Credentials come from VERIFY_CLIENT_ID, VERIFY_CLIENT_SECRET, VERIFY_REDIRECT_URI, VERIFY_OWNER_PASSWORD.
 * Use a test deployment: the run writes situations and proposals into that server's database.
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const minutes = Number(process.argv[process.argv.indexOf("--minutes") + 1] || 60);
if (!base.startsWith("http")) { console.error("Usage: soak-remote.ts <base-url> --minutes N"); process.exit(2); }
const env = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const CLIENT_ID = env("VERIFY_CLIENT_ID"), REDIRECT = env("VERIFY_REDIRECT_URI");
const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${env("VERIFY_CLIENT_SECRET")}`).toString("base64")}`;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dir = fromRoot(path.join(".data", "soak-remote", runId)); fs.mkdirSync(dir, { recursive: true });
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const token = async (body: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic }, body: form(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

async function link() {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state: "s", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${base}/mcp`, scope: "homerelay.read homerelay.plan" });
  const page = await fetch(`${base}/oauth/authorize?${q}`); const html = await page.text();
  const csrf = /hr_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? ""; const rid = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const back = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `hr_csrf=${csrf}` }, body: form({ request_id: rid, csrf, password: env("VERIFY_OWNER_PASSWORD"), decision: "allow" }) });
  const code = new URL(back.headers.get("location") ?? "about:blank").searchParams.get("code") ?? "";
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${base}/mcp` });
  if (t.status !== 200) throw new Error(`linking failed (${t.status})`);
  return t.json as { access_token: string; refresh_token: string };
}
async function connect(access: string) {
  const c = new Client({ name: "homerelay-soak-remote", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
  return c;
}

const m = { calls: 0, call_errors: 0, refreshes: 0, refresh_errors: 0, probes: 0, probe_failures: 0, reconnects: 0, situations_created: 0, latencies: [] as number[], errors: [] as string[] };
const started = Date.now(), end = started + minutes * 60_000;
let tok = await link(); let c = await connect(tok.access_token);
let lastRefresh = Date.now(), lastProbe = 0, lastWrite = 0, sid = "";
const summary = (status: string) => {
  const l = [...m.latencies].sort((a, b) => a - b); const pct = (p: number) => l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null;
  const s = { run: runId, base, status, declared_minutes: minutes, started_at: new Date(started).toISOString(), last_update: new Date().toISOString(), elapsed_minutes: +((Date.now() - started) / 60000).toFixed(1),
    tool_calls: m.calls, tool_call_errors: m.call_errors, refreshes: m.refreshes, refresh_errors: m.refresh_errors, refusal_probes: m.probes, refusal_probe_failures: m.probe_failures,
    reconnects: m.reconnects, situations_created: m.situations_created, latency_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: l.at(-1) ?? null }, over_500ms: l.filter((x) => x > 500).length,
    first_errors: m.errors.slice(0, 20), passed: status === "completed" && m.call_errors === 0 && m.refresh_errors === 0 && m.probe_failures === 0 };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(s, null, 2));
  return s;
};
const stop = () => { summary("interrupted"); process.exit(1); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
console.log(`[soak-remote] run ${runId}: ${minutes} min against ${base}; summary in ${path.relative(fromRoot("."), dir)}`);

const bearer = (t: string | null) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...(t ? { authorization: `Bearer ${t}` } : {}) });
const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
let revokedSample = "";
while (Date.now() < end) {
  const t0 = performance.now();
  try {
    const now = Date.now();
    if (now - lastWrite > 30_000) {
      lastWrite = now;
      const r = await c.callTool({ name: "create_situation", arguments: { title: `Soak ${new Date().toISOString()}`, category: "delivery", expected_at: new Date(now + 86400_000).toISOString() } });
      sid = JSON.parse((r.content as { text: string }[])[0].text).situation.id; m.situations_created++;
      await c.callTool({ name: "set_constraints", arguments: { situation_id: sid, available_from: new Date(now + 90000_000).toISOString(), nobody_else_home: true } });
      const p = await c.callTool({ name: "propose_plan", arguments: { situation_id: sid } });
      if (p.isError) throw new Error("propose_plan returned an error");
      m.calls += 3;
    } else {
      const pick = [["get_workload_summary", {}], ["list_open_situations", {}], ["list_tasks", {}], ["search_household", { query: "soak" }], ["get_situation", { situation_id: sid }]][m.calls % 5] as [string, object];
      if (pick[0] === "get_situation" && !sid) continue;
      const r = await c.callTool({ name: pick[0], arguments: pick[1] as Record<string, unknown> });
      if (r.isError) throw new Error(`${pick[0]} returned an error`);
      m.calls++;
    }
    m.latencies.push(Math.round(performance.now() - t0));
  } catch (e) {
    m.call_errors++; if (m.errors.length < 50) m.errors.push(`${new Date().toISOString()} call: ${(e as Error).message}`);
    try { await c.close(); } catch { /* reconnecting */ } c = await connect(tok.access_token); m.reconnects++;
  }
  if (Date.now() - lastRefresh > 10 * 60_000) {
    lastRefresh = Date.now();
    const r = await token({ grant_type: "refresh_token", refresh_token: tok.refresh_token });
    if (r.status === 200) { revokedSample = tok.access_token; tok = r.json; m.refreshes++; await c.close(); c = await connect(tok.access_token); }
    else { m.refresh_errors++; m.errors.push(`${new Date().toISOString()} refresh: ${r.status}`); }
  }
  if (Date.now() - lastProbe > 60_000) {
    lastProbe = Date.now();
    const probes: [string, boolean][] = [["no token", (await fetch(`${base}/mcp`, { method: "POST", headers: bearer(null), body: list })).status === 401]];
    if (revokedSample) probes.push(["rotated-out token", (await fetch(`${base}/mcp`, { method: "POST", headers: bearer(revokedSample), body: list })).status === 401]);
    const banned = await c.callTool({ name: "approve_plan", arguments: {} }).catch(() => ({ isError: true }));
    probes.push(["approve_plan refused", !!banned.isError]);
    for (const [name, ok] of probes) { m.probes++; if (!ok) { m.probe_failures++; m.errors.push(`${new Date().toISOString()} probe failed: ${name}`); } }
    summary("running");
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (performance.now() - t0))));
}
await c.close();
const s = summary("completed");
console.log(JSON.stringify(s, null, 2));
process.exit(s.passed ? 0 : 1);
