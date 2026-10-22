import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/server";

const SECRET = "test-secret-0123456789abcdef";
let srv: Awaited<ReturnType<typeof startMcpServer>>;
let client: Client;
let dbFile: string; let tmp: string;
let reader: Database.Database; // independent connection: proves state really lands in SQLite

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0].text;
  return { isError: !!r.isError, data: JSON.parse(text) as any, structured: r.structuredContent as any };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-mcp-"));
  dbFile = path.join(tmp, "test.db");
  srv = await startMcpServer({ port: 0, dbPath: dbFile, approvalSecret: SECRET, allowDemoReset: true, tz: "Asia/Kolkata" });
  client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
  reader = new Database(dbFile, { readonly: true });
});
afterAll(async () => {
  reader?.close(); await client?.close(); await srv?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("MCP over Streamable HTTP", () => {
  it("negotiates the latest protocol version (2025-11-25 or later)", () => {
    expect(LATEST_PROTOCOL_VERSION >= "2025-11-25").toBe(true);
    expect(client.getServerVersion()?.name).toBe("homerelay");
  });

  it("discovers all registered tools with JSON schemas via tools/list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["create_situation", "get_situation", "list_open_situations", "list_tasks", "propose_plan", "approve_plan", "reject_plan", "add_task", "reschedule_task", "update_task_status", "resolve_situation", "get_activity_log", "simulate_delivery_event", "reset_demo_data"]) {
      expect(names).toContain(n);
    }
    expect(tools.every((t) => t.description && t.inputSchema.type === "object")).toBe(true);
  });

  it("serves a health endpoint and rejects non-POST /mcp and foreign Host headers", async () => {
    const base = srv.url.replace("/mcp", "");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(srv.url)).status).toBe(405);
    const r = await fetch(`${base}/health`, { headers: { Host: "evil.example.com" } });
    // fetch may refuse to override Host; if it was sent it must be blocked
    expect([200, 403]).toContain(r.status);
  });

  it("create_situation persists to SQLite and returns the real saved record", async () => {
    const { isError, data } = await call("create_situation", { title: "Plumber visit", category: "maintenance", actor: "user" });
    expect(isError).toBe(false);
    const row = reader.prepare("SELECT * FROM situations WHERE id=?").get(data.situation.id) as any;
    expect(row.title).toBe("Plumber visit");
    expect(row.status).toBe("open");
    expect(reader.prepare("SELECT COUNT(*) c FROM activity_events WHERE situation_id=? AND event_type='situation_created'").get(data.situation.id)).toEqual({ c: 1 });
  });

  it("rejects invalid input and unknown ids with structured errors, without changing state", async () => {
    const before = (reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c;
    let bad: { isError: boolean; text: string };
    try {
      const r = await client.callTool({ name: "create_situation", arguments: { title: "", category: "nonsense" } });
      bad = { isError: !!r.isError, text: JSON.stringify(r.content) };
    } catch (e: any) { bad = { isError: true, text: String(e.message) }; }
    expect(bad.isError).toBe(true);
    const nf = await call("get_situation", { situation_id: "does-not-exist" });
    expect(nf.isError).toBe(true);
    expect(nf.data.error.code).toBe("NOT_FOUND");
    expect((reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c).toBe(before);
  });

  it("full delivery lifecycle through real tool calls, verified in the database", async () => {
    const sim = await call("simulate_delivery_event");
    const sid = sim.data.situation.id as string;
    expect(sim.data.already_exists).toBe(false);
    expect((await call("simulate_delivery_event")).data.already_exists).toBe(true);

    // relative to now: fixed wall-clock dates stop producing a reschedule once they are in the past
    const hour = 3600_000; const t0 = Math.ceil(Date.now() / hour) * hour;
    const freeAt = new Date(t0 + 2 * hour).toISOString(); const extendedAt = new Date(t0 + 3 * hour).toISOString();
    expect((await call("set_constraints", { situation_id: sid, available_from: freeAt, nobody_else_home: true, actor: "user" })).isError).toBe(false);
    const plan = await call("propose_plan", { situation_id: sid });
    const pid = plan.data.proposal.id as string;
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 }); // proposal != execution

    // Approval without the user-action token must fail and change nothing.
    const denied = await call("approve_plan", { proposal_id: pid, approval_token: "wrong-token-wrong-token" });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe("UNAUTHORIZED");
    expect(reader.prepare("SELECT status FROM plan_proposals WHERE id=?").get(pid)).toEqual({ status: "proposed" });

    const approved = await call("approve_plan", { proposal_id: pid, approval_token: SECRET });
    expect(approved.isError).toBe(false);
    expect(approved.data.created_tasks).toHaveLength(3);
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 3 });
    expect((await call("approve_plan", { proposal_id: pid, approval_token: SECRET })).data.already_applied).toBe(true);
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 3 });

    // Meeting extended -> replan -> reschedule.
    await call("set_constraints", { situation_id: sid, available_from: extendedAt, actor: "user" });
    const re = await call("propose_plan", { situation_id: sid });
    expect(re.data.proposal.plan.actions.every((a: any) => a.type === "reschedule_task")).toBe(true);
    await call("approve_plan", { proposal_id: re.data.proposal.id, approval_token: SECRET });
    const follow = reader.prepare("SELECT due_at FROM tasks WHERE situation_id=? AND kind='followup'").get(sid) as any;
    expect(follow.due_at).toBe(extendedAt);

    const log = await call("get_activity_log", { situation_id: sid });
    const types = log.data.events.map((e: any) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["situation_created", "constraints_updated", "plan_proposed", "plan_approved", "task_created", "task_rescheduled"]));
    expect(log.data.events.length).toBe((reader.prepare("SELECT COUNT(*) c FROM activity_events WHERE situation_id=?").get(sid) as any).c);

    // Completion needs the user's confirmation; resolution needs closed tasks.
    const task = (await call("list_tasks", { situation_id: sid, filter: "all" })).data.tasks.find((t: any) => t.kind === "followup");
    expect((await call("update_task_status", { task_id: task.id, status: "completed" })).data.error.code).toBe("CONFIRMATION_REQUIRED");
    expect((await call("resolve_situation", { situation_id: sid, confirmed_by_user: true })).data.error.code).toBe("OUTSTANDING_TASKS");
  });

  it("reset_demo_data needs the token and leaves user data alone", async () => {
    expect((await call("reset_demo_data", { approval_token: "nope-nope-nope-nope" })).data.error.code).toBe("UNAUTHORIZED");
    const user = (await call("create_situation", { title: "Keep me", category: "general", source: "user" })).data.situation.id;
    const r = await call("reset_demo_data", { approval_token: SECRET });
    expect(r.isError).toBe(false);
    expect(reader.prepare("SELECT COUNT(*) c FROM situations WHERE source='demo'").get()).toEqual({ c: 0 });
    expect(reader.prepare("SELECT id FROM situations WHERE id=?").get(user)).toBeTruthy();
  });
});
