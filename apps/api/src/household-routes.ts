import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { ENTITY_TYPES, PRIORITIES, RECURRENCES, TASK_CATEGORIES, TASK_FILTERS } from "@homerelay/shared";
import type { Connections, HouseholdGraph, SearchResult, TaskDetail, TaskWithContext } from "@homerelay/shared";
import type { ApiConfig } from "./config";
import type { McpGateway } from "./gateway";
import { HttpError, localDateTime, parse, toUtc } from "./http";

/** Household tasks, the knowledge map, connections and global search. Every route is a thin call to an MCP tool. */

const id = z.string().min(1).max(100);
const tags = z.array(z.string().trim().min(1).max(40)).max(12);
const createTask = z.object({
  title: z.string().trim().min(1, "title is required").max(200),
  description: z.string().trim().max(2000).optional(),
  dueLocal: localDateTime.optional(),
  situationId: id.optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(TASK_CATEGORIES).optional(),
  tags: tags.optional(),
  recurrence: z.enum(RECURRENCES).optional(),
  dependsOnTaskId: id.optional(),
  documentIds: z.array(id).max(20).optional(),
});
const updateTask = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  dueLocal: localDateTime.nullable().optional(),
  situationId: id.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(TASK_CATEGORIES).optional(),
  tags: tags.optional(),
  recurrence: z.enum(RECURRENCES).optional(),
  dependsOnTaskId: id.nullable().optional(),
});
const docBody = z.object({ documentId: id });
const reopenBody = z.object({ reason: z.string().max(500).optional() }).default({});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const flag = (v: unknown) => v === "1" || v === "true";

export function householdRoutes(gw: McpGateway, cfg: ApiConfig): Router {
  const r = express.Router();
  const via = { via: "api" as const };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const due = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : toUtc(v, cfg.tz));

  r.get("/tasks", wrap(async (req, res) => {
    const filter = str(req.query.filter) ? parse(z.enum(TASK_FILTERS), req.query.filter) : undefined;
    const category = str(req.query.category) ? parse(z.enum(TASK_CATEGORIES), req.query.category) : undefined;
    const priority = str(req.query.priority) ? parse(z.enum(PRIORITIES), req.query.priority) : undefined;
    const q = str(req.query.q) ? parse(z.string().max(200), req.query.q) : undefined;
    res.json(await gw.call<{ tasks: TaskWithContext[] }>("list_tasks", { filter, category, priority, q, situation_id: str(req.query.situationId), document_id: str(req.query.documentId), limit: 500 }, via));
  }));
  r.post("/tasks", wrap(async (req, res) => {
    const b = parse(createTask, req.body);
    res.status(201).json(await gw.call("add_task", {
      title: b.title, description: b.description, due_at: due(b.dueLocal), situation_id: b.situationId, priority: b.priority, category: b.category,
      tags: b.tags, recurrence: b.recurrence, depends_on_task_id: b.dependsOnTaskId, document_ids: b.documentIds, actor: "user",
    }, via));
  }));
  r.get("/tasks/:id", wrap(async (req, res) => { res.json(await gw.call<TaskDetail>("get_task", { task_id: req.params.id }, via)); }));
  r.post("/tasks/:id/update", wrap(async (req, res) => {
    const b = parse(updateTask, req.body);
    res.json(await gw.call("update_task", {
      task_id: req.params.id, title: b.title, description: b.description, due_at: due(b.dueLocal), situation_id: b.situationId, priority: b.priority,
      category: b.category, tags: b.tags, recurrence: b.recurrence, depends_on_task_id: b.dependsOnTaskId, actor: "user",
    }, via));
  }));
  r.post("/tasks/:id/reopen", wrap(async (req, res) => {
    const b = parse(reopenBody, req.body);
    res.json(await gw.call("reopen_task", { task_id: req.params.id, reason: b.reason, actor: "user" }, via));
  }));
  // Destructive user action: confirmation header + the user-action token, which lives only in this process.
  r.post("/tasks/:id/delete", wrap(async (req, res) => {
    if (req.get("X-HomeRelay-Confirm") !== "delete-task") throw new HttpError(400, "CONFIRMATION_REQUIRED", "Missing delete confirmation header.");
    res.json(await gw.call("delete_task", { task_id: req.params.id, approval_token: cfg.approvalSecret }, via));
  }));
  r.post("/tasks/:id/documents/link", wrap(async (req, res) => {
    const b = parse(docBody, req.body);
    res.json(await gw.call("link_document_to_task", { task_id: req.params.id, document_id: b.documentId, actor: "user" }, via));
  }));
  r.post("/tasks/:id/documents/unlink", wrap(async (req, res) => {
    const b = parse(docBody, req.body);
    res.json(await gw.call("unlink_document_from_task", { task_id: req.params.id, document_id: b.documentId, actor: "user" }, via));
  }));
  r.get("/tasks/:id/activity", wrap(async (req, res) => { res.json(await gw.call("get_activity_log", { task_id: req.params.id, limit: 200 }, via)); }));

  r.get("/map", wrap(async (req, res) => {
    res.json(await gw.call<HouseholdGraph>("get_household_map", { include_resolved: flag(req.query.includeResolved), include_done: flag(req.query.includeDone), limit: 400 }, via));
  }));
  r.get("/connections/:type/:id", wrap(async (req, res) => {
    const type = parse(z.enum(ENTITY_TYPES), req.params.type);
    res.json(await gw.call<Connections>("get_connections", { type, id: req.params.id }, via));
  }));
  r.get("/search", wrap(async (req, res) => {
    const q = parse(z.string().trim().min(1, "q is required").max(200), req.query.q);
    res.json(await gw.call<{ results: SearchResult[] }>("search_household", { query: q, limit: 6 }, via));
  }));
  return r;
}
