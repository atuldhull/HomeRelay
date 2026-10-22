import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatClock } from "@homerelay/shared";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { createApp } from "../apps/api/src/app";
import { McpGateway } from "../apps/api/src/gateway";
import type { ApiConfig } from "../apps/api/src/config";

const SECRET = "api-test-secret-0123456789ab";
const TZ = "Asia/Kolkata";
let mcp: Awaited<ReturnType<typeof startMcpServer>>;
let gw: McpGateway; let api: http.Server; let base: string; let tmp: string; let reader: Database.Database;

const cfg = (over: Partial<ApiConfig> = {}): ApiConfig => ({
  port: 0, mcpUrl: "", webOrigins: ["http://localhost:5173"], tz: TZ, approvalSecret: SECRET, allowDemoReset: true,
  llm: { provider: "deterministic", apiKey: "", model: "" }, dbPath: "", ...over,
});
async function listen(app: http.RequestListener) {
  const s = http.createServer(app);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", "X-HomeRelay-Client": "web", ...(init?.headers ?? {}) } });
  return { status: r.status, body: (await r.json()) as any };
};
const post = (p: string, body: unknown, headers?: Record<string, string>) => j(`${base}${p}`, { method: "POST", body: JSON.stringify(body), headers });
const chat = (message: string, activeSituationId?: string | null) => post("/api/chat", { message, activeSituationId });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-api-"));
  const dbFile = path.join(tmp, "t.db");
  mcp = await startMcpServer({ port: 0, dbPath: dbFile, approvalSecret: SECRET, allowDemoReset: true, tz: TZ });
  gw = new McpGateway(mcp.url);
  const l = await listen(createApp(gw, cfg({ mcpUrl: mcp.url })));
  api = l.s; base = l.url;
  reader = new Database(dbFile, { readonly: true });
});
afterAll(async () => {
  reader.close(); await gw.close(); await new Promise((r) => api.close(r)); await mcp.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("API basics", () => {
  it("health reports mode and MCP status without secrets", async () => {
    const r = await j(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: "deterministic", mcp: "up" });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
  });
  it("validates request bodies and returns the standard error shape", async () => {
    const bad = await post("/api/chat", { message: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
    expect((await post("/api/tasks/x/status", { status: "bogus" })).status).toBe(400);
    expect((await j(`${base}/api/situations/does-not-exist`)).body.error.code).toBe("NOT_FOUND");
    expect((await j(`${base}/api/nope`)).status).toBe(404);
    const malformed = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "X-HomeRelay-Client": "web" }, body: "{oops" });
    expect(malformed.status).toBe(400);
  });
  it("empty dashboard first", async () => {
    const d = await j(`${base}/api/dashboard`);
    expect(d.body).toMatchObject({ openCount: 0, situations: [] });
  });
});

describe("hero scenario: delivery during a meeting (deterministic agent, real MCP)", () => {
  let sid = ""; let p1 = ""; let tasks: any[] = [];

  it("one-click demo creates a real persisted, labelled situation; repeats do not duplicate", async () => {
    const r = await post("/api/demo/delivery", {});
    expect(r.status).toBe(201);
    sid = r.body.situation.id;
    expect(r.body.trace[0]).toMatchObject({ tool: "simulate_delivery_event", ok: true });
    expect(reader.prepare("SELECT source, description FROM situations WHERE id=?").get(sid)).toMatchObject({ source: "demo" });
    const again = await post("/api/demo/delivery", {});
    expect(again.status).toBe(200); expect(again.body.already_exists).toBe(true);
    expect((await j(`${base}/api/dashboard`)).body.openCount).toBe(1);
  });

  it("understands the conflict, proposes (but does not execute) a plan, citing real MCP calls", async () => {
    const r = await chat("I'm working until 6 PM. The package should arrive around 5 and nobody else is home. Help me manage it.", sid);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("deterministic");
    expect(r.body.proposal.status).toBe("proposed");
    expect(r.body.proposal.plan.conflicts.join(" ")).toContain("6:00 PM");
    const tools = r.body.trace.map((t: any) => t.tool);
    expect(tools).toEqual(["get_situation", "set_constraints", "propose_plan"]); // retrieves existing context first
    expect(r.body.trace.every((t: any) => t.via === "deterministic" && t.ok)).toBe(true);
    p1 = r.body.proposal.id;
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 });
    expect(r.body.reply).toMatch(/only a proposal/i);
  });

  it("approving via the user endpoint saves the tasks; double approval does not duplicate", async () => {
    const a = await post(`/api/proposals/${p1}/approve`, {});
    expect(a.status).toBe(200);
    expect(a.body.created_tasks).toHaveLength(3);
    expect((await post(`/api/proposals/${p1}/approve`, {})).body.already_applied).toBe(true);
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 3 });
    const d = await j(`${base}/api/situations/${sid}`);
    tasks = d.body.tasks;
    expect(d.body.situation.status).toBe("in_progress");
  });

  it("meeting extended: retrieves existing situation, proposes reschedule, approval moves due times, no duplicates", async () => {
    const r = await chat("My meeting has been extended until 7 PM.", sid);
    expect(r.body.trace.map((t: any) => t.tool)).toEqual(["get_situation", "set_constraints", "propose_plan"]);
    expect(r.body.proposal.plan.actions.every((a: any) => a.type === "reschedule_task")).toBe(true);
    expect(r.body.reply).toMatch(/earlier time/i);
    await post(`/api/proposals/${r.body.proposal.id}/approve`, {});
    const d = await j(`${base}/api/situations/${sid}`);
    expect(d.body.tasks).toHaveLength(3);
    const follow = d.body.tasks.find((t: any) => t.kind === "followup");
    expect(formatClock(follow.due_at, TZ)).toBe("7:00 PM");
    expect(follow.id).toBe(tasks.find((t) => t.kind === "followup").id); // same task, not a new one
    const log = await j(`${base}/api/situations/${sid}/activity`);
    const types = log.body.events.map((e: any) => e.event_type);
    expect(types.filter((t: string) => t === "task_created")).toHaveLength(3);
    expect(types).toContain("task_rescheduled");
    expect(log.body.events.find((e: any) => e.event_type === "task_rescheduled").metadata).toHaveProperty("old_due_at");
  });

  it("repeating the same message proposes nothing new (duplicate protection)", async () => {
    const r = await chat("My meeting has been extended until 7 PM.", sid);
    expect(r.body.proposal).toBeNull();
    expect(r.body.reply).toMatch(/fit your availability|no changes/i);
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 3 });
  });

  it("state survives a fresh read (reload) and pending query reflects real data", async () => {
    const q = await chat("What is still pending?");
    expect(q.body.reply).toContain("3 open task(s)");
    expect(q.body.trace[0].tool).toBe("list_open_situations");
  });

  it("collection needs the user's statement: completes, cancels moot tasks, resolves, and says it is unverified", async () => {
    const r = await chat("I collected the package", sid);
    expect(r.body.stateChanged).toBe(true);
    expect(r.body.reply).toMatch(/based on your confirmation/i);
    expect(r.body.reply).toMatch(/not verified this with the courier/i);
    const d = await j(`${base}/api/situations/${sid}`);
    expect(d.body.situation.status).toBe("resolved");
    expect(d.body.tasks.find((t: any) => t.kind === "followup").status).toBe("completed");
    expect(d.body.tasks.filter((t: any) => t.status === "cancelled")).toHaveLength(2);
  });
});

describe("approval, rejection, task and reset endpoints", () => {
  it("reject records the decision and creates nothing; completion without confirmation is refused", async () => {
    const s = (await post("/api/demo/delivery", { startNew: true })).body.situation.id;
    const r = await chat("I'm free at 6 PM", s);
    const rej = await post(`/api/proposals/${r.body.proposal.id}/reject`, { reason: "not now" });
    expect(rej.body.proposal.status).toBe("rejected");
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(s)).toEqual({ c: 0 });
    // approve something real to get a task, then try to complete it unconfirmed
    const r2 = await chat("help me plan this", s);
    expect(r2.body.proposal).toBeTruthy();
    const ap = await post(`/api/proposals/${r2.body.proposal.id}/approve`, { selectedActionIds: ["a1"] });
    const taskId = ap.body.created_tasks[0].id;
    const refused = await post(`/api/tasks/${taskId}/status`, { status: "completed" });
    expect(refused.status).toBe(400); expect(refused.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(reader.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "pending" });
    const ok = await post(`/api/tasks/${taskId}/status`, { status: "completed", confirmedByUser: true });
    expect(ok.body.task.status).toBe("completed");
  });

  it("chat that lacks needed info asks a clarifying question instead of inventing an answer", async () => {
    const s = (await post("/api/demo/delivery", { startNew: true })).body.situation.id;
    const r = await chat("help me manage it", s);
    expect(r.body.clarification).toMatch(/free/i);
    expect(r.body.proposal).toBeNull();
  });

  it("a delivery described with no existing situation creates a user-sourced one", async () => {
    await post("/api/demo/reset", {}, { "X-HomeRelay-Confirm": "reset-demo" });
    const r = await chat("A package should arrive around 5 PM and I'm working until 6 PM");
    expect(r.body.trace.map((t: any) => t.tool)).toContain("create_situation");
    expect(reader.prepare("SELECT source FROM situations WHERE id=?").get(r.body.situationId)).toEqual({ source: "user" });
  });

  it("demo reset needs the confirmation header and spares user-created data", async () => {
    expect((await post("/api/demo/reset", {})).status).toBe(400);
    await post("/api/demo/delivery", {});
    const before = (reader.prepare("SELECT COUNT(*) c FROM situations WHERE source='user'").get() as any).c;
    const r = await post("/api/demo/reset", {}, { "X-HomeRelay-Confirm": "reset-demo" });
    expect(r.status).toBe(200);
    expect(reader.prepare("SELECT COUNT(*) c FROM situations WHERE source='demo'").get()).toEqual({ c: 0 });
    expect(reader.prepare("SELECT COUNT(*) c FROM situations WHERE source='user'").get()).toEqual({ c: before });
  });

  it("user-action tokens are never exposed in the trace", async () => {
    const t = await j(`${base}/api/trace?limit=200`);
    expect(JSON.stringify(t.body)).not.toContain(SECRET);
    expect(t.body.trace.some((e: any) => e.tool === "approve_plan" && e.args_summary.includes("[redacted]"))).toBe(true);
  });
});

describe("failure handling", () => {
  it("reports MCP-server unavailability as 503 and changes nothing", async () => {
    const dead = new McpGateway("http://127.0.0.1:1/mcp", 2000);
    const l = await listen(createApp(dead, cfg()));
    const before = (reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c;
    const r = await j(`${l.url}/api/dashboard`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MCP_UNAVAILABLE");
    const c = await j(`${l.url}/api/chat`, { method: "POST", body: JSON.stringify({ message: "simulate a delivery" }) });
    expect(c.status).toBe(503);
    expect((await j(`${l.url}/api/health`)).body.mcp).toBe("down");
    expect((reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c).toBe(before);
    await dead.close(); await new Promise((r2) => l.s.close(r2));
  });
  it("disabled demo reset is forbidden", async () => {
    const l = await listen(createApp(gw, cfg({ allowDemoReset: false })));
    expect((await j(`${l.url}/api/demo/reset`, { method: "POST", body: "{}", headers: { "X-HomeRelay-Confirm": "reset-demo" } })).status).toBe(403);
    await new Promise((r) => l.s.close(r));
  });
});
