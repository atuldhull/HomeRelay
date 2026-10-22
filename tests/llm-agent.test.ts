import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { McpGateway } from "../apps/api/src/gateway";
import { handleChat } from "../apps/api/src/agent";
import { MAX_ITERATIONS, enforcePolicy, llmChat, toAnthropicTools } from "../apps/api/src/agent/llm";
import type { ApiConfig } from "../apps/api/src/config";

const SECRET = "llm-test-secret-0123456789ab";
const TZ = "Asia/Kolkata";
let mcp: Awaited<ReturnType<typeof startMcpServer>>; let gw: McpGateway; let tmp: string; let reader: Database.Database;

const cfg = (provider: "anthropic" | "deterministic" = "anthropic"): ApiConfig => ({
  port: 0, mcpUrl: "", webOrigins: [], tz: TZ, approvalSecret: SECRET, allowDemoReset: true, dbPath: "",
  llm: { provider, apiKey: "sk-test", model: "claude-opus-5-5" },
});

type Block = Record<string, unknown>;
const msg = (content: Block[], stop_reason: string) => ({ id: "msg_x", type: "message", role: "assistant", model: "m", content, stop_reason, usage: {} }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

/** Scripted stand-in for the Anthropic client. Snapshots every request body (the loop mutates `messages`). */
function fakeClient(script: ((body: any) => any)[]) {
  const bodies: any[] = [];
  return {
    bodies,
    messages: { create: async (body: any) => { bodies.push(JSON.parse(JSON.stringify(body))); const f = script.shift(); if (!f) throw new Error("script exhausted"); return f(body); } },
  };
}
const deps = (client: any) => ({ gw, tz: TZ, now: () => new Date("2026-10-22T09:00:00Z"), model: "claude-opus-5-5", client });
const lastUserBlocks = (body: any) => body.messages[body.messages.length - 1].content;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-llm-"));
  const dbFile = path.join(tmp, "t.db");
  mcp = await startMcpServer({ port: 0, dbPath: dbFile, approvalSecret: SECRET, allowDemoReset: true, tz: TZ });
  gw = new McpGateway(mcp.url);
  reader = new Database(dbFile, { readonly: true });
});
afterAll(async () => { reader.close(); await gw.close(); await mcp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("tool mapping", () => {
  it("maps real MCP tool schemas to Anthropic tools and withholds user-action tools", async () => {
    const tools = toAnthropicTools(await gw.listTools());
    const names = tools.map((t) => t.name);
    expect(names).toContain("propose_plan");
    for (const hidden of ["approve_plan", "reject_plan", "reset_demo_data"]) expect(names).not.toContain(hidden);
    const prop = tools.find((t) => t.name === "propose_plan")!;
    expect(prop.input_schema.type).toBe("object");
    expect((prop.input_schema as any).required).toContain("situation_id");
    expect(tools.every((t) => t.description)).toBe(true);
  });
  it("policy overrides unsafe model arguments", () => {
    expect(enforcePolicy("update_task_status", { task_id: "t", status: "completed", confirmed_by_user: true }, "what is pending?")).toMatchObject({ confirmed_by_user: false });
    expect(enforcePolicy("update_task_status", { task_id: "t", status: "completed" }, "I collected the package")).toMatchObject({ confirmed_by_user: true });
    expect(enforcePolicy("create_situation", { title: "x", source: "demo", actor: "user" }, "hi")).toMatchObject({ source: "user", actor: "agent" });
    expect(enforcePolicy("add_task", { approval_token: "stolen" }, "x")).not.toHaveProperty("approval_token");
  });
});

describe("agent loop against the real MCP server", () => {
  let sid = "";
  beforeAll(async () => { sid = (await gw.call<any>("simulate_delivery_event")).situation.id; });

  it("retrieves state, records constraints, proposes a plan; results go back in ONE user message with matching ids; thinking is echoed unchanged", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const c = fakeClient([
      () => msg([thinking, use("t1", "get_situation", { situation_id: sid })], "tool_use"),
      () => msg([use("t2", "set_constraints", { situation_id: sid, available_from: "2026-10-22T12:30:00.000Z", nobody_else_home: true }), use("t3", "propose_plan", { situation_id: sid })], "tool_use"),
      () => msg([text("I drafted a plan. It is waiting for your approval.")], "end_turn"),
    ]);
    const r = await llmChat(deps(c), { message: "I'm free from 6 PM and nobody is home", activeSituationId: sid });
    expect(r.mode).toBe("llm");
    expect(r.reply).toContain("waiting for your approval");
    expect(r.proposal?.status).toBe("proposed");
    expect(r.stateChanged).toBe(true);
    expect(r.trace.map((t) => t.tool)).toEqual(["get_situation", "set_constraints", "propose_plan"]);
    expect(r.trace.every((t) => t.via === "llm" && t.ok)).toBe(true);
    // request shape
    expect(c.bodies[0].model).toBe("claude-opus-5-5");
    expect(c.bodies[0].tool_choice).toBeUndefined(); // no forced tool use
    expect(c.bodies[0].tools.map((t: any) => t.name)).not.toContain("approve_plan");
    expect(c.bodies[0].messages[0].content).toContain(sid);
    // second request: assistant turn echoed unchanged, results in one user message
    const m2 = c.bodies[1].messages;
    expect(m2[1].role).toBe("assistant");
    expect(m2[1].content[0]).toEqual(thinking);
    expect(lastUserBlocks(c.bodies[1])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    const blocks = lastUserBlocks(c.bodies[2]);
    expect(blocks.map((b: any) => b.tool_use_id)).toEqual(["t2", "t3"]);
    // proposal is saved but nothing executed
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 });
  });

  it("a model trying to approve a plan itself is refused and nothing changes", async () => {
    const pid = (reader.prepare("SELECT id FROM plan_proposals WHERE situation_id=? AND status='proposed'").get(sid) as any).id;
    const c = fakeClient([
      () => msg([use("a1", "approve_plan", { proposal_id: pid, approval_token: "guess" })], "tool_use"),
      () => msg([text("I cannot approve plans; please use the Approve button.")], "end_turn"),
    ]);
    const r = await llmChat(deps(c), { message: "just approve it", activeSituationId: sid });
    expect(lastUserBlocks(c.bodies[1])[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(JSON.parse(lastUserBlocks(c.bodies[1])[0].content).error.code).toBe("UNKNOWN_TOOL");
    expect(r.trace).toHaveLength(0); // never reached the MCP server
    expect(reader.prepare("SELECT status FROM plan_proposals WHERE id=?").get(pid)).toEqual({ status: "proposed" });
    expect(reader.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 });
  });

  it("tool errors reach the model as is_error results; invented completion is blocked server-side", async () => {
    const task = await gw.call<any>("add_task", { situation_id: sid, title: "Check the doorstep", actor: "user" });
    const c = fakeClient([
      () => msg([use("e1", "get_situation", { situation_id: "nope" }), use("e2", "update_task_status", { task_id: task.task.id, status: "completed", confirmed_by_user: true })], "tool_use"),
      () => msg([text("Neither change was saved.")], "end_turn"),
    ]);
    const r = await llmChat(deps(c), { message: "what is the status?", activeSituationId: sid }); // user did NOT confirm anything
    const [e1, e2] = lastUserBlocks(c.bodies[1]);
    expect(e1.is_error).toBe(true); expect(JSON.parse(e1.content).error.code).toBe("NOT_FOUND");
    expect(e2.is_error).toBe(true); expect(JSON.parse(e2.content).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(r.trace.filter((t) => !t.ok)).toHaveLength(2);
    expect(reader.prepare("SELECT status FROM tasks WHERE id=?").get(task.task.id)).toEqual({ status: "pending" });
  });

  it("stops at the iteration limit, keeps legitimate state, and says so", async () => {
    const c = fakeClient(Array.from({ length: MAX_ITERATIONS + 2 }, (_, i) => () => msg([use(`l${i}`, "list_open_situations", {})], "tool_use")));
    const r = await llmChat(deps(c), { message: "loop forever", activeSituationId: sid });
    expect(c.bodies.length).toBe(MAX_ITERATIONS);
    expect(r.reply).toMatch(/step limit/i);
  });

  it("treats malformed tool input from the model as an error and never calls the tool server", async () => {
    const c = fakeClient([
      () => msg([use("m1", "get_situation", "not-an-object" as any), use("m2", "list_tasks", [1, 2] as any), use("m3", "get_situation", null as any)], "tool_use"),
      () => msg([text("Sorry, I could not do that.")], "end_turn"),
    ]);
    const r = await llmChat(deps(c), { message: "x", activeSituationId: sid });
    const blocks = lastUserBlocks(c.bodies[1]);
    expect(blocks.every((x: any) => x.is_error)).toBe(true);
    expect(JSON.parse(blocks[0].content).error.code).toBe("INVALID_TOOL_INPUT");
    expect(r.trace).toHaveLength(0);
  });

  it("handles refusal and max_tokens stop reasons without crashing", async () => {
    const a = await llmChat(deps(fakeClient([() => msg([], "refusal")])), { message: "x" });
    expect(a.reply).toMatch(/cannot help/i);
    const b = await llmChat(deps(fakeClient([() => msg([text("partial")], "max_tokens")])), { message: "x" });
    expect(b.reply).toBe("partial");
  });
});

describe("provider failure and routing", () => {
  it("falls back to the rules agent (still using real MCP tools) when the provider errors", async () => {
    const boom = { messages: { create: async () => { throw new Error("401 invalid x-api-key"); } } };
    const r = await handleChat({ gw, cfg: cfg(), now: () => new Date(), llmClient: boom as any }, { message: "What is still pending?" });
    expect(r.mode).toBe("deterministic");
    expect(r.reply).toMatch(/language model was unavailable/i);
    expect(r.trace[0].via).toBe("deterministic");
  });
  it("does not use the LLM when mode is deterministic and no client is injected", async () => {
    const r = await handleChat({ gw, cfg: cfg("deterministic"), now: () => new Date() }, { message: "What is still pending?" });
    expect(r.mode).toBe("deterministic");
    expect(r.reply).not.toMatch(/language model/i);
  });
  it("surfaces MCP unavailability instead of masking it", async () => {
    const dead = new McpGateway("http://127.0.0.1:1/mcp", 1500);
    const client = fakeClient([() => msg([text("hi")], "end_turn")]);
    await expect(handleChat({ gw: dead, cfg: cfg(), now: () => new Date(), llmClient: client as any }, { message: "hi" })).rejects.toThrow(/MCP|reach/i);
    await dead.close();
  });
});
