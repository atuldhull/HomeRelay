import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/server";

const SECRET = "ctx-test-secret-0123456789abc";
let srv: Awaited<ReturnType<typeof startMcpServer>>; let client: Client; let tmp: string; let reader: Database.Database;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse((r.content as any[])[0].text) as any, structured: r.structuredContent as any };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-ctx-"));
  const db = path.join(tmp, "t.db");
  srv = await startMcpServer({ port: 0, dbPath: db, approvalSecret: SECRET, allowDemoReset: true, tz: "Asia/Kolkata" });
  client = new Client({ name: "ctx-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
  reader = new Database(db, { readonly: true });
});
afterAll(async () => { reader.close(); await client.close(); await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("tools added in v2", () => {
  it("are discoverable with schemas and annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["update_situation", "get_workload_summary", "create_situation"]));
    expect(tools.find((t) => t.name === "get_workload_summary")!.annotations?.readOnlyHint).toBe(true);
    const create = tools.find((t) => t.name === "create_situation")!;
    expect(Object.keys((create.inputSchema as any).properties)).toEqual(expect.arrayContaining(["window_end", "available_from", "initial_task_title"]));
    expect(tools).toHaveLength(34); // v4: 36 minus get_tasks and get_situation_documents, which overlapped list_tasks / list_documents
  });

  it("create_situation takes constraints and an initial task, persisted atomically and echoed accurately", async () => {
    const r = await call("create_situation", { title: "Boiler service", category: "maintenance", expected_at: "2026-10-23T08:30:00.000Z", window_end: "2026-10-23T10:30:00.000Z", available_from: "2026-10-23T09:30:00.000Z", initial_task_title: "Find the warranty card", actor: "user" });
    expect(r.isError).toBe(false);
    const id = r.data.situation.id;
    const row = reader.prepare("SELECT constraints_json FROM situations WHERE id=?").get(id) as any;
    expect(JSON.parse(row.constraints_json)).toEqual({ window_end: "2026-10-23T10:30:00.000Z", available_from: "2026-10-23T09:30:00.000Z" });
    expect(reader.prepare("SELECT title FROM tasks WHERE situation_id=?").all(id)).toEqual([{ title: "Find the warranty card" }]);
    expect(r.data.situation.constraints.window_end).toBe("2026-10-23T10:30:00.000Z");
  });

  it("rejects inverted windows and malformed times with structured errors and writes nothing", async () => {
    const before = (reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c;
    const bad = await call("create_situation", { title: "x", category: "maintenance", expected_at: "2026-10-23T10:00:00.000Z", window_end: "2026-10-23T09:00:00.000Z" });
    expect(bad.isError).toBe(true); expect(bad.data.error.code).toBe("INVALID_INPUT");
    let schemaRejected = false;
    try { const r = await client.callTool({ name: "update_situation", arguments: { situation_id: "x", priority: "urgent" } }); schemaRejected = !!r.isError; } catch { schemaRejected = true; }
    expect(schemaRejected).toBe(true);
    expect((reader.prepare("SELECT COUNT(*) c FROM situations").get() as any).c).toBe(before);
  });

  it("update_situation changes the time, records old and new, and fails cleanly for unknown ids", async () => {
    const s = (await call("create_situation", { title: "Visit", category: "family_visit", expected_at: "2026-10-23T13:30:00.000Z" })).data.situation.id;
    const u = await call("update_situation", { situation_id: s, expected_at: "2026-10-23T15:30:00.000Z", actor: "user" });
    expect(u.data.situation.expected_at).toBe("2026-10-23T15:30:00.000Z");
    const log = (await call("get_activity_log", { situation_id: s })).data.events;
    expect(log.find((e: any) => e.event_type === "situation_updated").metadata.old.expected_at).toBe("2026-10-23T13:30:00.000Z");
    expect((await call("update_situation", { situation_id: "nope", title: "x" })).data.error.code).toBe("NOT_FOUND");
  });

  it("get_workload_summary returns structured, bounded data consistent with the database", async () => {
    const w = (await call("get_workload_summary")).data;
    expect(w.open_situations).toBe((reader.prepare("SELECT COUNT(*) c FROM situations WHERE status!='resolved'").get() as any).c);
    expect(w.recent_activity.length).toBeLessThanOrEqual(8);
    for (const k of ["overdue", "due_today", "blocked", "waiting_approval", "can_resolve"]) expect(Array.isArray(w[k])).toBe(true);
    expect(JSON.stringify(w)).not.toContain(SECRET);
  });
});

describe("MCP resources and prompt", () => {
  it("lists the workflow catalog resource and the situation template", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("homerelay://workflows");
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("homerelay://situation/{id}");
  });
  it("reads the catalog: all scenarios with required info, tasks and resolution rules", async () => {
    const r = await client.readResource({ uri: "homerelay://workflows" });
    const cat = JSON.parse((r.contents[0] as any).text).scenarios;
    expect(cat.map((c: any) => c.category).sort()).toEqual(["delivery", "family_visit", "general", "maintenance"]);
    expect(cat.find((c: any) => c.category === "delivery").required_information[0]).toMatch(/free to collect/);
  });
  it("reads a stored situation through the resource and errors for an unknown one", async () => {
    const id = (await call("create_situation", { title: "Res test", category: "general" })).data.situation.id;
    const r = await client.readResource({ uri: `homerelay://situation/${id}` });
    const body = JSON.parse((r.contents[0] as any).text);
    expect(body.situation.id).toBe(id); expect(body.workflow.scenario).toBe("General follow-up");
    await expect(client.readResource({ uri: "homerelay://situation/does-not-exist" })).rejects.toThrow(/not found/i);
  });
  it("serves a planning prompt that tells the agent not to bypass approval", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("plan_situation");
    const p = await client.getPrompt({ name: "plan_situation", arguments: { situation_id: "abc" } });
    const text = (p.messages[0].content as any).text as string;
    expect(text).toContain("abc"); expect(text).toMatch(/Only the user can approve/); expect(text).toMatch(/get_situation/);
  });
});
