import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { createApp } from "../apps/api/src/app";
import { McpGateway } from "../apps/api/src/gateway";
import type { ApiConfig } from "../apps/api/src/config";

const SECRET = "household-test-secret-0123456789";
const TZ = "Asia/Kolkata";
let mcp: Awaited<ReturnType<typeof startMcpServer>>; let gw: McpGateway; let api: http.Server; let base: string; let tmp: string;
const cfg: ApiConfig = { port: 0, mcpUrl: "", webOrigins: ["http://localhost:5173"], tz: TZ, approvalSecret: SECRET, allowDemoReset: true, llm: { provider: "deterministic", apiKey: "", model: "" }, dbPath: "" };
const j = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, { ...init, headers: { "X-HomeRelay-Client": "web", "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { status: r.status, body: await r.json() as any };
};
const post = (p: string, b: unknown, h: Record<string, string> = {}) => j(p, { method: "POST", body: JSON.stringify(b), headers: h });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-household-"));
  mcp = await startMcpServer({ port: 0, dbPath: path.join(tmp, "t.db"), approvalSecret: SECRET, allowDemoReset: true, tz: TZ });
  gw = new McpGateway(mcp.url);
  api = http.createServer(createApp(gw, { ...cfg, mcpUrl: mcp.url }));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => { await gw.close(); await new Promise((r) => api.close(r)); await mcp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("household task API", () => {
  let sid = ""; let buy = ""; let fit = ""; let docId = "";
  it("creates standalone and situation tasks from local times, and validates input", async () => {
    sid = (await post("/api/situations", { title: "Water filter swap", category: "maintenance" })).body.situation.id;
    const a = await post("/api/tasks", { title: "Buy a compatible filter", dueLocal: "2026-10-30T18:00", priority: "high", category: "shopping", tags: ["kitchen"] });
    expect(a.status).toBe(201);
    expect(a.body.task.due_at).toBe("2026-10-30T12:30:00.000Z"); // 18:00 IST
    expect(a.body.task.situation_id).toBeNull();
    buy = a.body.task.id;
    const b = await post("/api/tasks", { title: "Replace the filter", situationId: sid, dependsOnTaskId: buy, recurrence: "monthly", dueLocal: "2026-10-31T10:00" });
    expect(b.status).toBe(201); fit = b.body.task.id;
    expect((await post("/api/tasks", { title: "" })).status).toBe(400);
    expect((await post("/api/tasks", { title: "x", dueLocal: "2026-02-30T10:00" })).status).toBe(400);
    expect((await post("/api/tasks", { title: "x", category: "spaceship" })).status).toBe(400);
    expect((await post("/api/tasks", { title: "x", situationId: "nope" })).status).toBe(404);
    expect((await post("/api/tasks", { title: "Buy a compatible filter" })).body.error.code).toBe("DUPLICATE");
  });

  it("filters, shows detail with the blocked reason, and refuses a cycle with 409", async () => {
    expect((await j("/api/tasks?filter=standalone")).body.tasks.map((t: any) => t.id)).toEqual([buy]);
    expect((await j("/api/tasks?filter=blocked")).body.tasks.map((t: any) => t.id)).toEqual([fit]);
    expect((await j("/api/tasks?q=filter&category=shopping")).body.tasks.map((t: any) => t.id)).toEqual([buy]);
    expect((await j("/api/tasks?filter=nonsense")).status).toBe(400);
    const d = (await j(`/api/tasks/${fit}`)).body;
    expect(d.blocked_reason).toMatch(/Waiting for "Buy a compatible filter"/);
    expect(d.situation.id).toBe(sid);
    const cyc = await post(`/api/tasks/${buy}/update`, { dependsOnTaskId: fit });
    expect(cyc.status).toBe(409); expect(cyc.body.error.code).toBe("DEPENDENCY_CYCLE");
    expect((await post(`/api/tasks/${fit}/status`, { status: "completed", confirmedByUser: true })).status).toBe(409);
    expect((await j("/api/tasks/missing")).status).toBe(404);
  });

  it("links documents to tasks both ways and reports NOT_LINKED as 409", async () => {
    const up = await fetch(`${base}/api/documents?category=manual`, { method: "POST", body: Buffer.from("Filter cartridge manual, model F-22"), headers: { "X-HomeRelay-Client": "web", "content-type": "application/octet-stream", "X-Filename": "filter-manual.txt" } });
    docId = ((await up.json()) as any).document.id;
    expect((await post(`/api/tasks/${fit}/documents/link`, { documentId: docId })).body.already_linked).toBe(false);
    expect((await j(`/api/tasks?documentId=${docId}`)).body.tasks.map((t: any) => t.id)).toEqual([fit]);
    expect((await j(`/api/documents/${docId}`)).body.document.linked_tasks.map((t: any) => t.id)).toEqual([fit]);
    expect((await post(`/api/tasks/${fit}/documents/unlink`, { documentId: docId })).status).toBe(200);
    expect((await post(`/api/tasks/${fit}/documents/unlink`, { documentId: docId })).status).toBe(409);
    await post(`/api/tasks/${fit}/documents/link`, { documentId: docId });
  });

  it("serves the map, connections and search from the same records", async () => {
    const map = (await j("/api/map")).body;
    const keys = new Set(map.nodes.map((n: any) => n.key));
    expect(keys).toEqual(new Set([`situation:${sid}`, `task:${buy}`, `task:${fit}`, `document:${docId}`]));
    expect(map.edges.every((e: any) => keys.has(e.source) && keys.has(e.target))).toBe(true);
    const c = (await j(`/api/connections/situation/${sid}`)).body;
    expect(c.related.map((r: any) => r.id).sort()).toEqual([buy, fit, docId].sort());
    expect((await j("/api/connections/planet/x")).status).toBe(400);
    const s = (await j("/api/search?q=filter")).body.results;
    expect(s.map((r: any) => r.type)).toEqual(["situation", "task", "task", "document"]);
    expect(s.every((r: any) => r.route.startsWith("#/"))).toBe(true);
    expect((await j("/api/search?q=")).status).toBe(400);
  });

  it("edits, completes, reopens and deletes with confirmation; recurrence saves the next occurrence once", async () => {
    expect((await post(`/api/tasks/${buy}/update`, { dueLocal: null, title: "Buy two filters" })).body.task.due_at).toBeNull();
    await post(`/api/tasks/${buy}/status`, { status: "completed", confirmedByUser: true });
    expect((await post(`/api/tasks/${fit}/status`, { status: "completed", confirmedByUser: true })).status).toBe(200);
    const next = (await j("/api/tasks?q=replace")).body.tasks;
    expect(next).toHaveLength(1); expect(next[0].recurrence_of).toBe(fit); expect(next[0].document_count).toBe(1);
    expect((await post(`/api/tasks/${buy}/reopen`, {})).body.task.status).toBe("pending");
    expect((await post(`/api/tasks/${buy}/delete`, {})).status).toBe(400); // no confirmation header
    const del = await post(`/api/tasks/${buy}/delete`, {}, { "X-HomeRelay-Confirm": "delete-task" });
    expect(del.status).toBe(200); expect(del.body.deleted.id).toBe(buy);
    expect((await j(`/api/tasks/${buy}`)).status).toBe(404);
    const log = (await j(`/api/tasks/${buy}/activity`)).body.events.map((e: any) => e.event_type);
    expect(log.at(-1)).toBe("task_deleted");
  });
});

describe("MCP contract for the v4 tools", () => {
  it("lists every new tool with a schema, and identifiers returned by one call work in the next", async () => {
    const client = new Client({ name: "v4-contract", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    const tools = (await client.listTools()).tools;
    for (const n of ["get_task", "update_task", "reopen_task", "delete_task", "link_document_to_task", "unlink_document_from_task", "search_household", "get_connections", "get_household_map"]) {
      const t = tools.find((x) => x.name === n);
      expect(t, n).toBeTruthy(); expect(t!.description!.length).toBeGreaterThan(40); expect(t!.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "add_task")!.inputSchema.required).toEqual(["title"]); // situation optional
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
    const created = await call("add_task", { title: "Defrost the freezer", category: "cleaning" });
    const tid = created.structuredContent.task.id;
    const detail = await call("get_task", { task_id: tid });
    expect(detail.structuredContent.task.title).toBe("Defrost the freezer");
    const none = await call("search_household", { query: "zz-no-such-thing" });
    expect(none.structuredContent).toEqual({ results: [], message: "Nothing in your records matches that." }); // empty still answers
    expect(tools.find((t) => t.name === "get_household_map")!.outputSchema?.type).toBe("object");
    const found = await call("search_household", { query: "freezer" });
    expect(found.structuredContent.results[0].id).toBe(tid);
    const conn = await call("get_connections", { type: "task", id: found.structuredContent.results[0].id });
    expect(conn.structuredContent.center.id).toBe(tid);
    // errors are structured and the server keeps working
    const bad = await call("update_task", { task_id: tid, depends_on_task_id: tid });
    expect(bad.isError).toBe(true); expect(bad.structuredContent.error.code).toBe("INVALID_INPUT");
    const unauth = await call("delete_task", { task_id: tid, approval_token: "wrong" });
    expect(unauth.structuredContent.error.code).toBe("UNAUTHORIZED");
    expect((await call("get_task", { task_id: tid })).structuredContent.task.id).toBe(tid);
    await client.close();
  });
});
