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
import { csvCell, situationReport, tasksToCsv } from "../apps/api/src/export";
import type { ApiConfig } from "../apps/api/src/config";

const SECRET = "apiv2-test-secret-0123456789ab";
const TZ = "Asia/Kolkata";
let mcp: Awaited<ReturnType<typeof startMcpServer>>; let gw: McpGateway; let api: http.Server; let base: string; let tmp: string; let reader: Database.Database;

const cfg: ApiConfig = { port: 0, mcpUrl: "", webOrigins: ["http://localhost:5173"], tz: TZ, approvalSecret: SECRET, allowDemoReset: true, llm: { provider: "deterministic", apiKey: "", model: "" }, dbPath: "" };
const H = { "content-type": "application/json", "X-HomeRelay-Client": "web" };
const j = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, { ...init, headers: { ...H, ...(init?.headers ?? {}) } }); const ct = r.headers.get("content-type") ?? ""; return { status: r.status, headers: r.headers, body: ct.includes("json") ? await r.json() : await r.text() } as { status: number; headers: Headers; body: any }; };
const post = (p: string, body: unknown) => j(p, { method: "POST", body: JSON.stringify(body) });
const chat = (message: string, activeSituationId?: string | null) => post("/api/chat", { message, activeSituationId });
const tools = (r: any) => r.body.trace.map((t: any) => t.tool);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-v2-"));
  const dbFile = path.join(tmp, "t.db");
  mcp = await startMcpServer({ port: 0, dbPath: dbFile, approvalSecret: SECRET, allowDemoReset: true, tz: TZ });
  gw = new McpGateway(mcp.url);
  api = http.createServer(createApp(gw, { ...cfg, mcpUrl: mcp.url }));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  reader = new Database(dbFile, { readonly: true });
});
afterAll(async () => { reader.close(); await gw.close(); await new Promise((r) => api.close(r)); await mcp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("maintenance appointment via chat (rules agent, real MCP)", () => {
  let sid = ""; let p1 = "";
  it("creates the situation from natural language, finds the overlap, and proposes without executing", async () => {
    const r = await chat("The plumber is coming tomorrow between 2 PM and 4 PM, but I might not get home until 3 PM.");
    expect(tools(r)).toEqual(["create_situation", "set_constraints", "propose_plan"]);
    sid = r.body.situationId;
    const row = reader.prepare("SELECT category, source FROM situations WHERE id=?").get(sid) as any;
    expect(row).toEqual({ category: "maintenance", source: "user" });
    expect(r.body.proposal.plan.conflicts[0]).toMatch(/not home until 3:00 PM/);
    expect(r.body.proposal.plan.actions.map((a: any) => a.template_key)).toEqual(["be_home", "access_instructions", "confirm_done"]);
    expect(r.body.reply).toMatch(/only a proposal/i);
    expect(r.body.reply.toLowerCase()).not.toMatch(/i (contacted|called|messaged)/);
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 });
    p1 = r.body.proposal.id;
  });
  it("asks instead of guessing when the window is missing", async () => {
    const r = await chat("A technician is coming tomorrow afternoon");
    expect(r.body.clarification).toMatch(/window/i);
    expect(tools(r)).not.toContain("create_situation");
  });
  it("approval creates dependent tasks; the dependency is enforced by the server", async () => {
    const a = await post(`/api/proposals/${p1}/approve`, {});
    expect(a.body.created_tasks).toHaveLength(3);
    const done = a.body.created_tasks.find((t: any) => t.template_key === "confirm_done");
    const refused = await post(`/api/tasks/${done.id}/status`, { status: "completed", confirmedByUser: true });
    expect(refused.status).toBe(409); expect(refused.body.error.code).toBe("DEPENDENCY_INCOMPLETE");
  });
  it("a moved window updates the situation and reschedules the same tasks (no duplicates)", async () => {
    const r = await chat("The plumber is now coming between 4 PM and 6 PM", sid);
    // new start (4 PM) equals the old window end, so the window is widened first to stay valid at every step
    expect(tools(r)).toEqual(["get_situation", "set_constraints", "update_situation", "propose_plan"]);
    expect(r.body.proposal.plan.actions.every((a: any) => a.type === "reschedule_task")).toBe(true);
    await post(`/api/proposals/${r.body.proposal.id}/approve`, {});
    const d = await j(`/api/situations/${sid}`);
    expect(d.body.tasks).toHaveLength(3);
    expect(formatClock(d.body.situation.expected_at, TZ)).toBe("4:00 PM");
    expect(formatClock(d.body.situation.constraints.window_end, TZ)).toBe("6:00 PM");
    expect(formatClock(d.body.tasks.find((t: any) => t.template_key === "be_home").due_at, TZ)).toBe("3:30 PM");
  });
  it("confirmed completion resolves it and says it is unverified", async () => {
    const r = await chat("The repair is done", sid);
    expect(r.body.reply).toMatch(/based on your confirmation/i);
    expect(r.body.reply).toMatch(/not verified this with the technician/i);
    expect((await j(`/api/situations/${sid}`)).body.situation.status).toBe("resolved");
  });
});

describe("family visit via chat", () => {
  it("states the assumption when only a part of the day is given, then plans relative to arrival", async () => {
    const r = await chat("My parents arrive tomorrow evening. Help me prepare.");
    expect(tools(r)).toEqual(["create_situation", "propose_plan"]);
    expect(r.body.reply).toMatch(/took "evening" as 6:00 PM/);
    expect(r.body.proposal.plan.actions.map((a: any) => a.template_key)).toEqual(["groceries", "prepare_room", "tidy_common", "confirm_arrival"]);
    const sit = reader.prepare("SELECT description FROM situations WHERE id=?").get(r.body.situationId) as any;
    expect(sit.description).toMatch(/assumed/);
  });
  it("asks for the time when none is given", async () => {
    const r = await chat("My relatives are visiting soon, help me prepare");
    expect(r.body.clarification).toMatch(/what time/i);
  });
});

describe("workload summary and dashboard", () => {
  it("answers what needs attention from real data", async () => {
    const r = await chat("What needs attention today?");
    expect(tools(r)).toEqual(["get_workload_summary"]);
    expect(r.body.reply).toMatch(/waiting for your approval|ready to resolve|Nothing is overdue/i);
    expect(r.body.stateChanged).toBe(false);
  });
  it("dashboard carries the persisted summary", async () => {
    const d = await j("/api/dashboard");
    expect(d.body.summary.open_situations).toBe(d.body.openCount);
    expect(d.body.summary.waiting_approval.length).toBeGreaterThan(0);
    expect(Array.isArray(d.body.summary.recent_activity)).toBe(true);
  });
});

describe("manual situation intake", () => {
  it("converts local times in the app zone to UTC and creates constraints plus an initial task", async () => {
    const r = await post("/api/situations", { title: "Boiler service", category: "maintenance", startLocal: "2026-10-30T14:00", windowEndLocal: "2026-10-30T16:00", availableFromLocal: "2026-10-30T15:00", initialTaskTitle: "Find warranty card", initialTaskDueLocal: "2026-10-29T18:00" });
    expect(r.status).toBe(201);
    const row = reader.prepare("SELECT expected_at, constraints_json, source FROM situations WHERE id=?").get(r.body.situation.id) as any;
    expect(row.expected_at).toBe("2026-10-30T08:30:00.000Z"); // 14:00 IST
    expect(JSON.parse(row.constraints_json)).toEqual({ window_end: "2026-10-30T10:30:00.000Z", available_from: "2026-10-30T09:30:00.000Z" });
    expect(row.source).toBe("user");
    expect(reader.prepare("SELECT title, due_at FROM tasks WHERE situation_id=?").all(r.body.situation.id)).toEqual([{ title: "Find warranty card", due_at: "2026-10-29T12:30:00.000Z" }]);
  });
  it("rejects invalid input without writing", async () => {
    const before = (reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c;
    expect((await post("/api/situations", { title: "", category: "general" })).status).toBe(400);
    expect((await post("/api/situations", { title: "x", category: "spaceship" })).status).toBe(400);
    expect((await post("/api/situations", { title: "x", category: "general", startLocal: "tomorrow 5pm" })).status).toBe(400);
    expect((await post("/api/situations", { title: "x", category: "general", startLocal: "2026-02-31T10:00" })).body.error.message).toMatch(/not a valid date/);
    const inverted = await post("/api/situations", { title: "x", category: "maintenance", startLocal: "2026-10-30T16:00", windowEndLocal: "2026-10-30T14:00" });
    expect(inverted.status).toBe(400); expect(inverted.body.error.code).toBe("INVALID_INPUT");
    expect((reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c).toBe(before);
  });
});

describe("exports", () => {
  it("neutralises spreadsheet formulas and quotes CSV fields", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1 call")).toBe("'+1 call"); expect(csvCell("-2")).toBe("'-2"); expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("a,b")).toBe("\"a,b\""); expect(csvCell(null)).toBe(""); expect(csvCell("normal")).toBe("normal");
  });
  it("escapes markdown in user text and states what the report is based on", () => {
    const md = situationReport({ situation: { title: "[click](http://x) *bold*", description: "", category: "general", status: "open", priority: "normal", expected_at: null, source: "user", constraints: {}, id: "i", created_at: "", updated_at: "", resolved_at: null }, tasks: [], proposals: [], preferences: [], workflow: { scenario: "General follow-up", summary: "", resolution: "", can_resolve: false, next_action: "x" } }, [], TZ, new Date("2026-10-22T09:00:00Z"));
    expect(md).toContain("\\[click\\]"); expect(md).toContain("\\*bold\\*"); expect(md).toMatch(/did not verify/);
  });
  it("serves task CSV, JSON and a Markdown report as attachments built from stored data", async () => {
    const created = await post("/api/situations", { title: "=cmd|' /C calc'!A0", category: "general", initialTaskTitle: "@danger" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const csv = await j("/api/export/tasks.csv");
    expect(csv.status).toBe(200); expect(csv.headers.get("content-type")).toMatch(/text\/csv/); expect(csv.headers.get("content-disposition")).toMatch(/attachment/);
    expect(csv.body).toMatch(/^situation,task,status/);
    expect(csv.body).toContain("'=cmd"); expect(csv.body).toContain("'@danger");
    expect(csv.body).not.toMatch(/(^|,)=cmd/m);
    const sid = created.body.situation.id;
    const json = await j(`/api/situations/${sid}/export.json`);
    expect(json.status, JSON.stringify(json.body).slice(0, 300)).toBe(200);
    expect(json.body.situation.id).toBe(sid); expect(json.body.activity.length).toBeGreaterThan(0); expect(JSON.stringify(json.body)).not.toContain(SECRET);
    const md = await j(`/api/situations/${sid}/report.md`);
    expect(md.headers.get("content-type")).toMatch(/markdown/); expect(md.body).toContain("## Tasks"); expect(md.body).toContain("## Activity");
    expect((await j("/api/situations/does-not-exist/export.json")).status).toBe(404);
  });
  it("task CSV is bounded", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ situation: "s", task: { id: `t${i}`, situation_id: "s", title: `T${i}`, description: "", kind: "general", status: "pending", due_at: null, depends_on_task_id: null, template_key: null, created_at: "", updated_at: "", completed_at: null } as any }));
    expect(tasksToCsv(rows, TZ).split("\r\n").length).toBe(1000 + 2); // header + 1000 rows + trailing empty
  });
});
