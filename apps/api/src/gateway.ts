import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TraceEntry } from "@homerelay/shared";

export class McpToolError extends Error {
  constructor(public code: string, message: string, public tool: string) { super(message); }
}
export class McpUnavailableError extends Error {
  constructor(message: string) { super(message); }
}

export interface CallOpts { via?: TraceEntry["via"]; trace?: TraceEntry[] }
const MAX_TRACE = 300;

function summarizeArgs(args: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) safe[k] = /token|secret|key/i.test(k) ? "[redacted]" : v;
  const s = JSON.stringify(safe);
  return s.length > 180 ? s.slice(0, 177) + "..." : s;
}
function summarizeResult(tool: string, d: any): string {
  switch (tool) {
    case "get_situation": return `situation retrieved (${d.tasks?.length ?? 0} tasks, ${d.proposals?.length ?? 0} proposals)`;
    case "list_open_situations": return `${d.situations?.length ?? 0} situation(s) returned`;
    case "list_tasks": return `${d.tasks?.length ?? 0} task(s) returned`;
    case "get_activity_log": return `${d.events?.length ?? 0} event(s) returned`;
    case "create_situation": return `situation saved (${String(d.situation?.id).slice(0, 8)})`;
    case "simulate_delivery_event": return d.already_exists ? "existing demo delivery returned" : "simulated delivery saved";
    case "set_constraints": return "constraints saved";
    case "propose_plan": return d.proposal ? `plan saved (${d.proposal.plan.actions.length} action(s)), awaiting approval` : d.plan?.missing_info?.length ? "more information needed" : "no changes needed";
    case "approve_plan": return d.already_applied ? "already applied (no duplicates)" : `applied: ${d.created_tasks?.length ?? 0} created, ${d.rescheduled_tasks?.length ?? 0} rescheduled`;
    case "reject_plan": return "proposal rejected";
    case "add_task": return "task saved";
    case "reschedule_task": return "task rescheduled";
    case "update_task_status": return `task now ${d.task?.status}`;
    case "resolve_situation": return `situation ${d.situation?.status}`;
    case "reset_demo_data": return `${d.situations_removed} demo situation(s) removed`;
    default: return "ok";
  }
}

/** The backend's single MCP client. Every domain read/write goes through here. */
export class McpGateway {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  readonly recent: TraceEntry[] = [];
  /** Optional hook so tests can observe calls. */
  constructor(private url: string, private timeoutMs = 10_000) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = new Client({ name: "homerelay-api", version: "0.1.0" });
        try {
          await c.connect(new StreamableHTTPClientTransport(new URL(this.url)), { timeout: this.timeoutMs });
        } catch (e: any) {
          await c.close().catch(() => undefined);
          throw new McpUnavailableError(`Cannot reach the HomeRelay MCP server at ${this.url}. Is it running? (${e?.message ?? e})`);
        }
        this.client = c;
        return c;
      })().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }
  private async reset() { const c = this.client; this.client = null; await c?.close().catch(() => undefined); }

  async listTools() {
    const c = await this.connect();
    return (await c.listTools()).tools;
  }

  /** Calls a tool; throws McpToolError for tool-reported errors, McpUnavailableError for transport failures. */
  async call<T = any>(tool: string, args: Record<string, unknown> = {}, opts: CallOpts = {}): Promise<T> {
    const started = Date.now();
    const entry: TraceEntry = { id: randomUUID(), at: new Date().toISOString(), tool, ok: false, duration_ms: 0, args_summary: summarizeArgs(args), result_summary: "", via: opts.via ?? "api" };
    const record = () => {
      entry.duration_ms = Date.now() - started;
      this.recent.push(entry); if (this.recent.length > MAX_TRACE) this.recent.shift();
      opts.trace?.push(entry);
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.connect();
        const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
        const text = (r.content as { type: string; text?: string }[] | undefined)?.find((x) => x.type === "text")?.text ?? "{}";
        let data: any; try { data = JSON.parse(text); } catch { data = { error: { code: /-32602|Input validation/i.test(text) ? "INVALID_INPUT" : "BAD_RESPONSE", message: text.slice(0, 200) } }; }
        if (r.isError) {
          const code = data?.error?.code ?? "TOOL_ERROR";
          const message = data?.error?.message ?? text.slice(0, 200);
          entry.result_summary = `error ${code}: ${message}`; record();
          throw new McpToolError(code, message, tool);
        }
        entry.ok = true; entry.result_summary = summarizeResult(tool, data); record();
        return data as T;
      } catch (e: any) {
        if (e instanceof McpToolError) throw e;
        if (e instanceof McpUnavailableError) { entry.result_summary = "error MCP_UNAVAILABLE"; record(); throw e; }
        // Argument-validation failures surface as protocol errors (McpError code -32602): report as tool errors, don't retry.
        if (e?.code === -32602) { entry.result_summary = `error INVALID_INPUT: ${String(e.message).slice(0, 160)}`; record(); throw new McpToolError("INVALID_INPUT", String(e.message), tool); }
        await this.reset();
        if (attempt === 0) continue; // one reconnect attempt (server may have restarted)
        entry.result_summary = "error MCP_UNAVAILABLE"; record();
        throw new McpUnavailableError(`MCP call "${tool}" failed: ${e?.message ?? e}`);
      }
    }
  }

  async ping(): Promise<boolean> {
    try { await this.connect(); const r = await fetch(this.url.replace(/\/mcp$/, "/health")); return r.ok; } catch { return false; }
  }
  async close() { await this.reset(); }
}
