/**
 * Endurance (soak) test. Starts its OWN MCP server and API on dedicated ports with a dedicated database and document
 * folder under .data/soak/<run-id>/, drives a realistic household workload through the public HTTP API for the
 * declared duration, and records metrics. It never touches the normal development database or documents, and it
 * only ever stops the two processes it started itself.
 *
 *   npm run test:soak -- --hours 24          full run
 *   npm run test:soak -- --minutes 3         short run
 *   npm run test:soak:stop                   ask the newest run to stop (it writes "interrupted")
 *
 * Files: .data/soak/<run-id>/metrics.jsonl (one line per interval), summary.json (status, totals, criteria),
 *        server.log (both servers' output). The run's database and documents are deleted at the end unless --keep-data.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fromRoot, loadEnv } from "./env";

loadEnv();
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const durationMs = arg("minutes") ? Number(arg("minutes")) * 60_000 : Number(arg("hours") ?? 1) * 3_600_000;
if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Use --hours N or --minutes N");
const API_PORT = Number(arg("api-port") ?? 3200); const MCP_PORT = Number(arg("mcp-port") ?? 3201);
const PAUSE_MS = Number(arg("pause-ms") ?? 12_000); // between cycles: a realistic local workload, not a load test
const INTERVAL_MS = Number(arg("interval-ms") ?? (durationMs <= 15 * 60_000 ? 30_000 : 300_000));
const keepData = process.argv.includes("--keep-data");

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dir = fromRoot(path.join(".data", "soak", runId));
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, "soak.db"); const docsDir = path.join(dir, "documents");
const stopFile = path.join(dir, "STOP");
fs.writeFileSync(fromRoot(path.join(".data", "soak", "LATEST")), runId);
const log = fs.createWriteStream(path.join(dir, "server.log"), { flags: "a" });
const API = `http://127.0.0.1:${API_PORT}`;

// ---------- the two isolated servers ----------
const env = {
  ...process.env, DATABASE_PATH: dbPath, DOCUMENTS_DIR: docsDir, API_PORT: String(API_PORT), MCP_PORT: String(MCP_PORT),
  MCP_URL: `http://127.0.0.1:${MCP_PORT}/mcp`, LLM_PROVIDER: "none", ANTHROPIC_API_KEY: "", DOCUMENT_MAX_MB: "1", ALLOW_DEMO_RESET: "false",
};
type Svc = { name: string; entry: string; child: ChildProcess | null; exits: number; restarts: number; expectedStop: boolean };
const services: Svc[] = [
  { name: "mcp", entry: "apps/mcp-server/src/index.ts", child: null, exits: 0, restarts: 0, expectedStop: false },
  { name: "api", entry: "apps/api/src/index.ts", child: null, exits: 0, restarts: 0, expectedStop: false },
];
function start(s: Svc) {
  // one node process per service (tsx as an import hook), so the pid we hold is the process we stop
  const child = spawn(process.execPath, ["--import", "tsx", s.entry], { cwd: fromRoot("."), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (b) => log.write(`[${s.name}] ${b}`));
  child.stderr?.on("data", (b) => log.write(`[${s.name}!] ${b}`));
  child.on("exit", (code, sig) => {
    log.write(`[${s.name}] exited code=${code} signal=${sig}\n`);
    if (s.expectedStop) return;
    s.exits++; m.unexpectedExits.push({ service: s.name, at: new Date().toISOString(), code, signal: sig });
    if (s.restarts < 5) { s.restarts++; setTimeout(() => start(s), 2000); }
  });
  s.child = child;
}

// ---------- metrics ----------
const m = {
  requests: 0, ok: 0, errors: 0, verificationFailures: 0, cycles: 0, cyclesCompleted: 0,
  errorCategories: {} as Record<string, number>, verificationNotes: [] as string[],
  unexpectedExits: [] as { service: string; at: string; code: number | null; signal: string | null }[],
  latency: {} as Record<string, number[]>, windowLatency: [] as number[],
};
const memSamples: { at: string; mcp_mb: number | null; api_mb: number | null; harness_mb: number }[] = [];
const bump = (k: string) => { m.errorCategories[k] = (m.errorCategories[k] ?? 0) + 1; };
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const recordLatency = (op: string, ms: number) => {
  const arr = m.latency[op] ?? (m.latency[op] = []);
  arr.push(ms); if (arr.length > 2000) arr.splice(0, arr.length - 2000); // bounded: a rolling sample per operation
  m.windowLatency.push(ms);
};
class Verify extends Error {}
const check = (cond: unknown, note: string) => { if (!cond) throw new Verify(note); };

/** expect: an error code that is the correct answer here (e.g. a refused completion); it counts as success. */
async function call<T = any>(op: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}, expect?: string): Promise<{ status: number; json: T }> {
  const t0 = performance.now(); m.requests++;
  try {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(API + url, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { "x-homerelay-client": "web", ...(body === undefined ? {} : { "content-type": isBuf ? "application/octet-stream" : "application/json" }), ...headers },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
    recordLatency(op, performance.now() - t0);
    if (r.status >= 400 && expect && json?.error?.code === expect) { m.ok++; return { status: r.status, json }; }
    if (r.status >= 400) {
      m.errors++;
      const code = json?.error?.code ?? `HTTP_${r.status}`;
      bump(`${op}:${code}`);
      if (/BUSY|LOCKED/i.test(String(json?.error?.message ?? ""))) bump("sqlite_busy");
      if (code === "MCP_UNAVAILABLE") bump("mcp_unavailable");
      throw new Error(`${op} failed: ${r.status} ${code}`);
    }
    m.ok++;
    return { status: r.status, json };
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith(`${op} failed`))) { m.errors++; bump(`${op}:${(e as Error).name === "TimeoutError" ? "timeout" : "network"}`); recordLatency(op, performance.now() - t0); }
    throw e;
  }
}

const localPlus = (hours: number) => {
  const d = new Date(Date.now() + hours * 3600_000);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
};

// ---------- one workload cycle: create, connect, query, update, resolve, clean up (only its own records) ----------
async function cycle(n: number) {
  m.cycles++;
  const tag = `soak${n}x${Math.random().toString(36).slice(2, 7)}`;
  let docId: string | null = null; let standaloneId: string | null = null;
  try {
    await call("dashboard", "GET", "/api/dashboard");
    const s = (await call("create_situation", "POST", "/api/situations", { title: `Soak repair ${tag}`, category: "maintenance", startLocal: localPlus(26), windowEndLocal: localPlus(28), availableFromLocal: localPlus(27) })).json.situation;
    const prep = (await call("create_task", "POST", "/api/tasks", { title: `Clear access ${tag}`, situationId: s.id, dueLocal: localPlus(25), category: "maintenance" })).json.task;
    const meet = (await call("create_task", "POST", "/api/tasks", { title: `Meet technician ${tag}`, situationId: s.id, dueLocal: localPlus(27), dependsOnTaskId: prep.id })).json.task;
    standaloneId = (await call("create_task", "POST", "/api/tasks", { title: `Buy filter ${tag}`, priority: "high", category: "shopping", tags: ["soak"] })).json.task.id;
    const listed = (await call("list_tasks", "GET", `/api/tasks?filter=open&situationId=${s.id}`)).json.tasks;
    check(listed.length === 2 && listed.find((t: any) => t.id === meet.id)?.waiting_on, "situation tasks or dependency missing");

    const bytes = Buffer.from(`Receipt for repair ${tag}\nTechnician visit and parts.\n`);
    docId = (await call("upload_document", "POST", "/api/documents?category=receipt", bytes, { "x-filename": encodeURIComponent(`receipt-${tag}.txt`), "x-declared-type": "text/plain" })).json.document.id;
    const hits = (await call("search_documents", "GET", `/api/documents?q=${tag}`)).json.results;
    check(hits.length === 1 && hits[0].document.id === docId, "uploaded document not found by search");
    await call("link_document", "POST", `/api/documents/${docId}/link`, { situationId: s.id });
    await call("link_task_document", "POST", `/api/tasks/${meet.id}/documents/link`, { documentId: docId });
    const conn = (await call("connections", "GET", `/api/connections/situation/${s.id}`)).json;
    check(conn.related.filter((r: any) => r.type === "task").length === 2 && conn.related.some((r: any) => r.id === docId), "connections incomplete");
    const map = (await call("map", "GET", "/api/map")).json;
    const keys = new Set(map.nodes.map((x: any) => x.key));
    check(map.edges.every((e: any) => keys.has(e.source) && keys.has(e.target)), "map edge points at a missing node");
    check(map.edges.some((e: any) => e.source === `document:${docId}` && e.target === `situation:${s.id}`), "map is missing the new document link");
    const found = (await call("search", "GET", `/api/search?q=${tag}`)).json.results;
    check(found.some((r: any) => r.id === s.id) && found.some((r: any) => r.id === docId), "global search incomplete");
    await call("activity", "GET", `/api/situations/${s.id}/activity`);

    await call("update_task", "POST", `/api/tasks/${prep.id}/update`, { dueLocal: localPlus(24), priority: "high" });
    const refused = await call("complete_blocked_task", "POST", `/api/tasks/${meet.id}/status`, { status: "completed", confirmedByUser: true }, {}, "DEPENDENCY_INCOMPLETE");
    check(refused.status === 409, "a task with an unfinished prerequisite was completed");
    await call("complete_task", "POST", `/api/tasks/${prep.id}/status`, { status: "completed", confirmedByUser: true });
    await call("complete_task", "POST", `/api/tasks/${meet.id}/status`, { status: "completed", confirmedByUser: true });
    if (n % 5 === 0) await call("chat", "POST", "/api/chat", { message: "What needs attention today?" });
    await call("resolve", "POST", `/api/situations/${s.id}/resolve`, { confirmed: true, closeOutstanding: true });
    const after = (await call("get_situation", "GET", `/api/situations/${s.id}`)).json;
    check(after.situation.status === "resolved" && after.tasks.every((t: any) => t.status === "completed"), "resolved state not persisted");
    m.cyclesCompleted++;
  } catch (e) {
    if (e instanceof Verify) { m.verificationFailures++; if (m.verificationNotes.length < 50) m.verificationNotes.push(`cycle ${n}: ${e.message}`); }
  } finally {
    // clean up this cycle's document and standalone task so the run stays bounded (situations stay, resolved)
    if (docId) await call("delete_document", "POST", `/api/documents/${docId}/delete`, {}, { "x-homerelay-confirm": "delete-document" }).catch(() => undefined);
    if (standaloneId) await call("delete_task", "POST", `/api/tasks/${standaloneId}/delete`, {}, { "x-homerelay-confirm": "delete-task" }).catch(() => undefined);
  }
}

// ---------- memory sampling (Windows: tasklist for the two pids we own; elsewhere: ps) ----------
function rssMb(pid: number | undefined): Promise<number | null> {
  if (!pid) return Promise.resolve(null);
  return new Promise((resolve) => {
    const cb = (err: Error | null, out: string) => {
      if (err) return resolve(null);
      if (process.platform === "win32") { const m2 = /"([\d.,]+) K"\s*$/m.exec(out.trim()); return resolve(m2 ? Math.round(Number(m2[1].replace(/[.,]/g, "")) / 1024) : null); }
      const kb = Number(out.trim()); resolve(Number.isFinite(kb) ? Math.round(kb / 1024) : null);
    };
    if (process.platform === "win32") execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, cb);
    else execFile("ps", ["-o", "rss=", "-p", String(pid)], cb);
  });
}
function dirBytes(p: string): number {
  if (!fs.existsSync(p)) return 0;
  return fs.readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirBytes(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size), 0);
}

const startedAt = Date.now();
let status: "running" | "completed" | "interrupted" | "failed" = "running";
let stopReason: string | null = null;
function summary() {
  const all = Object.values(m.latency).flat();
  const first = memSamples.slice(0, Math.max(1, Math.floor(memSamples.length / 6)));
  const last = memSamples.slice(-Math.max(1, Math.floor(memSamples.length / 6)));
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const growth = (k: "mcp_mb" | "api_mb") => { const a = avg(first.map((x) => x[k])); const b = avg(last.map((x) => x[k])); return a && b ? Math.round((b / a) * 100) / 100 : null; };
  const errorRate = m.requests ? m.errors / m.requests : 0;
  const criteria = {
    ran_full_duration: Date.now() - startedAt >= durationMs,
    no_unexpected_exits: m.unexpectedExits.length === 0,
    error_rate_below_0_1_percent: errorRate < 0.001,
    zero_verification_failures: m.verificationFailures === 0,
    memory_growth_below_2x: [growth("mcp_mb"), growth("api_mb")].every((g) => g === null || g < 2),
  };
  return {
    run_id: runId, status, stop_reason: stopReason, started_at: new Date(startedAt).toISOString(), updated_at: new Date().toISOString(),
    declared_duration_hours: Math.round((durationMs / 3_600_000) * 1000) / 1000, elapsed_hours: Math.round(((Date.now() - startedAt) / 3_600_000) * 1000) / 1000,
    passed: status === "completed" && Object.values(criteria).every(Boolean), criteria,
    totals: { requests: m.requests, ok: m.ok, errors: m.errors, error_rate: Math.round(errorRate * 1e6) / 1e6, cycles: m.cycles, cycles_completed: m.cyclesCompleted, verification_failures: m.verificationFailures },
    latency_ms: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), by_operation: Object.fromEntries(Object.entries(m.latency).map(([k, v]) => [k, { n: v.length, p50: Math.round(pct(v, 50) ?? 0), p95: Math.round(pct(v, 95) ?? 0) }])) },
    error_categories: Object.fromEntries(Object.entries(m.errorCategories).filter(([, v]) => v > 0)),
    verification_notes: m.verificationNotes, unexpected_exits: m.unexpectedExits,
    restarts: Object.fromEntries(services.map((s) => [s.name, s.restarts])),
    memory_mb: { first: memSamples[0] ?? null, last: memSamples.at(-1) ?? null, growth_ratio: { mcp: growth("mcp_mb"), api: growth("api_mb") } },
    storage_bytes: { database: ["", "-wal", "-shm"].reduce((n, x) => n + (fs.existsSync(dbPath + x) ? fs.statSync(dbPath + x).size : 0), 0), documents: dirBytes(docsDir) },
    isolation: { database: path.relative(fromRoot("."), dbPath), documents: path.relative(fromRoot("."), docsDir), api_port: API_PORT, mcp_port: MCP_PORT },
  };
}
const writeSummary = () => fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary(), null, 2));

async function sample() {
  const [mcp, api] = await Promise.all([rssMb(services[0].child?.pid), rssMb(services[1].child?.pid)]);
  const s = { at: new Date().toISOString(), mcp_mb: mcp, api_mb: api, harness_mb: Math.round(process.memoryUsage().rss / 1048576) };
  memSamples.push(s); if (memSamples.length > 2000) memSamples.splice(1, 1);
  const w = m.windowLatency.splice(0);
  fs.appendFileSync(path.join(dir, "metrics.jsonl"), JSON.stringify({ ...s, elapsed_min: Math.round((Date.now() - startedAt) / 60000), requests: m.requests, errors: m.errors, verification_failures: m.verificationFailures, cycles_completed: m.cyclesCompleted, window_n: w.length, window_p50: pct(w, 50), window_p95: pct(w, 95), exits: m.unexpectedExits.length }) + "\n");
  writeSummary();
}

async function main() {
  console.log(`[soak] run ${runId}: ${durationMs / 60000} min, API :${API_PORT}, MCP :${MCP_PORT}, data in ${path.relative(fromRoot("."), dir)}`);
  console.log(`[soak] stop early with: npm run test:soak:stop   (or create ${path.relative(fromRoot("."), stopFile)})`);
  for (const s of services) start(s);
  // wait for the isolated API to report the tool server up
  for (let i = 0; ; i++) {
    try { const h = (await (await fetch(`${API}/api/health`)).json()) as { mcp?: string }; if (h.mcp === "up") break; } catch { /* starting */ }
    if (i > 120) { status = "failed"; stopReason = "servers did not start"; return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const deadline = startedAt + durationMs;
  let stopRequested = false;
  const onSignal = (sig: string) => { stopRequested = true; stopReason = `signal ${sig}`; };
  process.on("SIGINT", () => onSignal("SIGINT")); process.on("SIGTERM", () => onSignal("SIGTERM"));
  const timer = setInterval(() => { void sample(); }, INTERVAL_MS);
  await sample();
  let n = 0;
  while (Date.now() < deadline && !stopRequested) {
    if (fs.existsSync(stopFile)) { stopRequested = true; stopReason = "stop file"; break; }
    await cycle(++n);
    const wait = Math.min(PAUSE_MS * (0.5 + Math.random()), Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, wait));
  }
  clearInterval(timer);
  status = stopRequested ? "interrupted" : "completed";
  await sample();
}

main().catch((e) => { status = "failed"; stopReason = String((e as Error)?.message ?? e); }).finally(async () => {
  for (const s of services) { s.expectedStop = true; s.child?.kill(); }
  await new Promise((r) => setTimeout(r, 1500));
  writeSummary();
  if (!keepData) { for (const x of ["", "-wal", "-shm"]) fs.rmSync(dbPath + x, { force: true }); fs.rmSync(docsDir, { recursive: true, force: true }); }
  const s = summary();
  console.log(`[soak] ${s.status}${s.stop_reason ? ` (${s.stop_reason})` : ""} after ${s.elapsed_hours} h of ${s.declared_duration_hours} h: ${s.totals.requests} requests, ${s.totals.errors} errors, ${s.totals.verification_failures} verification failures, ${s.totals.cycles_completed}/${s.totals.cycles} cycles. passed=${s.passed}`);
  console.log(`[soak] summary: ${path.relative(fromRoot("."), path.join(dir, "summary.json"))}`);
  log.end();
  process.exit(s.passed || s.status === "interrupted" ? 0 : 1);
});
