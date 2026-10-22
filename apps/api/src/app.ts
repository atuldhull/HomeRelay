import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CATEGORIES, PRIORITIES, SITUATION_STATUSES, TASK_STATUSES } from "@homerelay/shared";
import type { ActivityEvent, ChatResponse, DashboardResponse, SituationDetail, SituationSummary, TaskWithContext, WorkloadSummary } from "@homerelay/shared";
import type { ApiConfig } from "./config";
import { McpToolError, McpUnavailableError, type McpGateway } from "./gateway";
import { handleChat } from "./agent";
import { CLIENT_HEADER, rateLimit, securityGuards } from "./security";
import { documentRoutes } from "./documents-routes";
import { householdRoutes } from "./household-routes";
import { HttpError, localDateTime, parse, toUtc } from "./http";
import { MAX_ACTIVITY_EXPORT, MAX_EXPORT_ROWS, situationReport, tasksToCsv, type TaskRow } from "./export";

const TOOL_STATUS: Record<string, number> = {
  NOT_FOUND: 404, INVALID_INPUT: 400, INVALID_TRANSITION: 409, INVALID_STATE: 409, DUPLICATE: 409, NO_CHANGE: 409,
  CONFIRMATION_REQUIRED: 400, DEPENDENCY_INCOMPLETE: 409, DEPENDENCY_CYCLE: 409, OUTSTANDING_TASKS: 409, FORBIDDEN: 403, UNAUTHORIZED: 403, NOT_LINKED: 409,
};

const chatBody = z.object({ message: z.string().trim().min(1, "message is required").max(1000), activeSituationId: z.string().min(1).max(100).nullish(), activeDocumentId: z.string().min(1).max(100).nullish(), activeTaskId: z.string().min(1).max(100).nullish() });
const approveBody = z.object({ selectedActionIds: z.array(z.string().max(40)).max(20).optional() }).default({});
const rejectBody = z.object({ reason: z.string().max(500).optional() }).default({});
const statusBody = z.object({ status: z.enum(TASK_STATUSES), confirmedByUser: z.boolean().optional(), note: z.string().max(500).optional() });
const resolveBody = z.object({ confirmed: z.boolean(), closeOutstanding: z.boolean().optional(), note: z.string().max(500).optional() });
const demoBody = z.object({ startNew: z.boolean().optional() }).default({});

const createBody = z.object({
  title: z.string().trim().min(1, "title is required").max(200),
  category: z.enum(CATEGORIES),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  startLocal: localDateTime.optional(),
  windowEndLocal: localDateTime.optional(),
  availableFromLocal: localDateTime.optional(),
  nobodyElseHome: z.boolean().optional(),
  initialTaskTitle: z.string().trim().min(1).max(200).optional(),
  initialTaskDueLocal: localDateTime.optional(),
});

export function createApp(gw: McpGateway, cfg: ApiConfig, opts?: { llmClient?: import("./agent/llm").LlmClient; uploadLimit?: number; /** chat requests per minute (default 60) */ chatRateLimit?: number }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityGuards(cfg));
  app.use(cors({ origin: cfg.webOrigins, allowedHeaders: ["Content-Type", CLIENT_HEADER, "X-HomeRelay-Confirm", "X-Filename", "X-Declared-Type"], maxAge: 600 }));
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", documentRoutes(gw, cfg, opts?.uploadLimit));
  app.use("/api", householdRoutes(gw, cfg));

  // Correlation id + structured request log (never logs bodies, so no message content or secrets).
  app.use((req, res, next) => {
    const id = (req as any).id = randomUUID().slice(0, 8);
    const t0 = Date.now();
    res.setHeader("X-Request-Id", id);
    res.on("finish", () => { if (req.path.startsWith("/api") && req.path !== "/api/health") console.log(JSON.stringify({ ts: new Date().toISOString(), id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 })); });
    next();
  });

  const mode = () => cfg.llm.provider === "anthropic" ? "llm" as const : "deterministic" as const;
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const via = { via: "api" as const };

  app.get("/api/health", wrap(async (_req, res) => {
    res.json({ ok: true, mode: mode(), tz: cfg.tz, mcp: (await gw.ping()) ? "up" : "down", time: new Date().toISOString(), documentMaxMb: Math.round(((opts?.uploadLimit ?? 10 * 1024 * 1024) / 1024 / 1024) * 10) / 10, llmDocumentAccess: !!cfg.llm.documentAccess });
  }));

  app.get("/api/dashboard", wrap(async (_req, res) => {
    const open = await gw.call<{ situations: SituationSummary[] }>("list_open_situations", { limit: 50 }, via);
    const resolved = await gw.call<{ situations: SituationSummary[] }>("list_open_situations", { statuses: ["resolved"], limit: 5 }, via);
    const summary = await gw.call<WorkloadSummary>("get_workload_summary", {}, via);
    const body: DashboardResponse = { mode: mode(), situations: [...open.situations, ...resolved.situations], openCount: open.situations.length, summary };
    res.json(body);
  }));

  app.get("/api/situations", wrap(async (req, res) => {
    const statuses = typeof req.query.status === "string" ? parse(z.array(z.enum(SITUATION_STATUSES)), req.query.status.split(",")) : undefined;
    res.json(await gw.call("list_open_situations", { statuses, limit: 100 }, via));
  }));

  app.get("/api/situations/:id", wrap(async (req, res) => { res.json(await gw.call("get_situation", { situation_id: req.params.id }, via)); }));
  app.get("/api/situations/:id/activity", wrap(async (req, res) => { res.json(await gw.call("get_activity_log", { situation_id: req.params.id, limit: 200 }, via)); }));
  app.get("/api/activity", wrap(async (_req, res) => { res.json(await gw.call("get_activity_log", { limit: 100 }, via)); }));

  app.post("/api/chat", rateLimit(opts?.chatRateLimit ?? 60, 60_000), wrap(async (req, res) => {
    const body = parse(chatBody, req.body);
    const out: ChatResponse = await handleChat({ gw, cfg, now: () => new Date(), llmClient: opts?.llmClient }, { message: body.message, activeSituationId: body.activeSituationId ?? null, activeDocumentId: body.activeDocumentId ?? null, activeTaskId: body.activeTaskId ?? null });
    res.json(out);
  }));

  app.post("/api/demo/delivery", wrap(async (req, res) => {
    const body = parse(demoBody, req.body);
    const trace: any[] = [];
    const r = await gw.call<any>("simulate_delivery_event", { force_new: body.startNew ?? false }, { via: "api", trace });
    res.status(r.already_exists ? 200 : 201).json({ ...r, trace });
  }));

  app.post("/api/demo/reset", wrap(async (req, res) => {
    if (!cfg.allowDemoReset) throw new HttpError(403, "FORBIDDEN", "Demo reset is disabled.");
    if (req.get("X-HomeRelay-Confirm") !== "reset-demo") throw new HttpError(400, "CONFIRMATION_REQUIRED", "Missing reset confirmation header.");
    res.json(await gw.call("reset_demo_data", { approval_token: cfg.approvalSecret }, via));
  }));

  // User-action endpoints: these (and only these) hold the approval token.
  app.post("/api/proposals/:id/approve", wrap(async (req, res) => {
    const b = parse(approveBody, req.body);
    res.json(await gw.call("approve_plan", { proposal_id: req.params.id, selected_action_ids: b.selectedActionIds, approval_token: cfg.approvalSecret }, via));
  }));
  app.post("/api/proposals/:id/reject", wrap(async (req, res) => {
    const b = parse(rejectBody, req.body);
    res.json(await gw.call("reject_plan", { proposal_id: req.params.id, reason: b.reason, approval_token: cfg.approvalSecret }, via));
  }));

  app.post("/api/tasks/:id/status", wrap(async (req, res) => {
    const b = parse(statusBody, req.body);
    res.json(await gw.call("update_task_status", { task_id: req.params.id, status: b.status, confirmed_by_user: b.confirmedByUser, note: b.note, actor: "user" }, via));
  }));
  app.post("/api/situations/:id/resolve", wrap(async (req, res) => {
    const b = parse(resolveBody, req.body);
    res.json(await gw.call("resolve_situation", { situation_id: req.params.id, confirmed_by_user: b.confirmed, close_outstanding: b.closeOutstanding, note: b.note, actor: "user" }, via));
  }));

  // Manual situation intake (the one-click demo and chat remain the other entry points).
  app.post("/api/situations", wrap(async (req, res) => {
    const b = parse(createBody, req.body);
    const out = await gw.call<{ situation: { id: string } }>("create_situation", {
      title: b.title, category: b.category, description: b.description, priority: b.priority, source: "user", actor: "user",
      expected_at: toUtc(b.startLocal, cfg.tz), window_end: toUtc(b.windowEndLocal, cfg.tz), available_from: toUtc(b.availableFromLocal, cfg.tz),
      nobody_else_home: b.nobodyElseHome, initial_task_title: b.initialTaskTitle, initial_task_due_at: toUtc(b.initialTaskDueLocal, cfg.tz),
    }, via);
    res.status(201).json(out);
  }));

  // Exports: bounded, built only from stored records. Downloads, so they are plain GETs.
  const stamp = () => new Date().toISOString().slice(0, 10);
  app.get("/api/situations/:id/export.json", wrap(async (req, res) => {
    const detail = await gw.call<SituationDetail>("get_situation", { situation_id: req.params.id }, via);
    const log = await gw.call<{ events: ActivityEvent[] }>("get_activity_log", { situation_id: req.params.id, limit: MAX_ACTIVITY_EXPORT }, via);
    res.setHeader("Content-Disposition", `attachment; filename="homerelay-situation-${stamp()}.json"`);
    res.json({ exported_at: new Date().toISOString(), tz: cfg.tz, ...detail, activity: log.events });
  }));
  app.get("/api/situations/:id/report.md", wrap(async (req, res) => {
    const detail = await gw.call<SituationDetail>("get_situation", { situation_id: req.params.id }, via);
    const log = await gw.call<{ events: ActivityEvent[] }>("get_activity_log", { situation_id: req.params.id, limit: MAX_ACTIVITY_EXPORT }, via);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="homerelay-report-${stamp()}.md"`);
    res.send(situationReport(detail, log.events, cfg.tz, new Date()));
  }));
  app.get("/api/export/tasks.csv", wrap(async (_req, res) => {
    const list = await gw.call<{ tasks: TaskWithContext[] }>("list_tasks", { filter: "open", limit: Math.min(MAX_EXPORT_ROWS, 500) }, via);
    const rows: TaskRow[] = list.tasks.map((task) => ({ situation: task.situation_title ?? "(household task)", task }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="homerelay-open-tasks-${stamp()}.csv"`);
    res.send(tasksToCsv(rows, cfg.tz));
  }));

  app.get("/api/trace", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 40) || 40, 200);
    res.json({ trace: gw.recent.slice(-limit) });
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown API route")));

  // Consistent error format. Never leaks stack traces, paths or env details.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: { code: err.code, message: err.message } }); return; }
    if (err instanceof McpToolError) { res.status(TOOL_STATUS[err.code] ?? 500).json({ error: { code: err.code, message: err.message } }); return; }
    if (err instanceof McpUnavailableError) { res.status(503).json({ error: { code: "MCP_UNAVAILABLE", message: "The HomeRelay tool server is unavailable. Nothing was changed. Check that it is running and try again." } }); return; }
    if ((err as any)?.type === "entity.too.large") { res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } }); return; }
    if ((err as any)?.type === "entity.parse.failed") { res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Request body is not valid JSON." } }); return; }
    console.error(JSON.stringify({ ts: new Date().toISOString(), id: (req as any).id, level: "error", message: String((err as Error)?.message ?? err) }));
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Nothing was reported as saved." } });
  });

  return app;
}
