import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../apps/mcp-server/src/db";
import { DomainError, HomeRelayService } from "../apps/mcp-server/src/domain";
import { DocumentService } from "../apps/mcp-server/src/documents";
import { GraphService } from "../apps/mcp-server/src/graph";
import { makePdf } from "./fixtures/pdf";
import type { Task } from "@homerelay/shared";

const NOW = new Date("2026-10-22T04:30:00.000Z"); // 10:00 IST
const H = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const code = (fn: () => unknown) => { try { fn(); return "no-error"; } catch (e) { return e instanceof DomainError ? e.code : String(e); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hr-v4-"));

let db: Db; let svc: HomeRelayService; let docs: DocumentService; let graph: GraphService; let clock: Date;
beforeEach(() => {
  clock = NOW;
  db = openDb(":memory:");
  svc = new HomeRelayService(db, { now: () => clock, tz: "Asia/Kolkata" });
  docs = new DocumentService(db, { dir: tmp(), now: () => clock });
  graph = new GraphService(db, svc, docs);
});
const sit = (title = "Washer repair", category: "maintenance" | "delivery" = "maintenance") => svc.createSituation({ title, category, expected_at: H(30) }, "user").id;
const doc = async (name: string, text: string) => (await docs.ingest({ bytes: Buffer.from(text), filename: name }, "user")).id;

describe("standalone household tasks", () => {
  it("creates, lists and persists a task with no situation", () => {
    const t = svc.addTask({ title: "Buy a replacement water filter", priority: "high", category: "shopping", tags: ["kitchen", "filter", "kitchen"], due_at: H(5) }, "user");
    expect(t.situation_id).toBeNull();
    expect(t.tags).toEqual(["kitchen", "filter"]);
    expect(t.priority).toBe("high");
    const listed = svc.listTasks({ filter: "standalone" });
    expect(listed.map((x) => x.id)).toEqual([t.id]);
    expect(listed[0].situation_title).toBeNull();
    expect(svc.workloadSummary().standalone_open).toBe(1);
    expect(svc.getActivityLog(null, 10, t.id).map((e) => e.event_type)).toEqual(["task_created"]);
    expect(code(() => svc.addTask({ title: "Buy a replacement water filter" }))).toBe("DUPLICATE");
    // the same title inside a situation is a different place, so it is allowed
    expect(svc.addTask({ situation_id: sit(), title: "Buy a replacement water filter" }).situation_id).not.toBeNull();
  });

  it("filters by text, category, priority and document", async () => {
    const a = svc.addTask({ title: "Clean the gutters", category: "garden", priority: "low" });
    svc.addTask({ title: "Pay electricity bill", category: "bills", priority: "high", description: "Due on the 25th" });
    const d = await doc("bill.txt", "Electricity bill October");
    const b = svc.listTasks({ q: "electricity" })[0];
    svc.linkTaskDocument(b.id, d, "user");
    expect(svc.listTasks({ category: "garden" }).map((t) => t.id)).toEqual([a.id]);
    expect(svc.listTasks({ priority: "high" }).map((t) => t.title)).toEqual(["Pay electricity bill"]);
    expect(svc.listTasks({ q: "25th" }).map((t) => t.title)).toEqual(["Pay electricity bill"]);
    expect(svc.listTasks({ document_id: d }).map((t) => t.id)).toEqual([b.id]);
    expect(svc.listTasks({ q: "electricity" })[0].document_count).toBe(1);
  });
});

describe("dependencies", () => {
  it("rejects missing, self, cross-situation and circular prerequisites", () => {
    const s1 = sit(); const s2 = sit("Another", "delivery");
    const buy = svc.addTask({ title: "Buy filter" });
    const fit = svc.addTask({ title: "Replace filter", depends_on_task_id: buy.id });
    expect(fit.depends_on_task_id).toBe(buy.id);
    expect(code(() => svc.addTask({ title: "X", depends_on_task_id: "nope" }))).toBe("NOT_FOUND");
    expect(code(() => svc.updateTask(buy.id, { depends_on_task_id: buy.id }))).toBe("INVALID_INPUT");
    expect(code(() => svc.updateTask(buy.id, { depends_on_task_id: fit.id }))).toBe("DEPENDENCY_CYCLE");
    const third = svc.addTask({ title: "Test water", depends_on_task_id: fit.id });
    expect(code(() => svc.updateTask(buy.id, { depends_on_task_id: third.id }))).toBe("DEPENDENCY_CYCLE"); // longer cycle
    const a = svc.addTask({ situation_id: s1, title: "A" });
    expect(code(() => svc.addTask({ situation_id: s2, title: "B", depends_on_task_id: a.id }))).toBe("INVALID_INPUT");
    // a situation task may depend on a standalone task
    expect(svc.addTask({ situation_id: s1, title: "C", depends_on_task_id: buy.id }).depends_on_task_id).toBe(buy.id);
    expect(graph.integrity().problems).toEqual([]);
  });

  it("explains a blocked task and refuses to complete it until the prerequisite is done", () => {
    const buy = svc.addTask({ title: "Buy filter" });
    const fit = svc.addTask({ title: "Replace filter", depends_on_task_id: buy.id });
    const d = svc.getTaskDetail(fit.id);
    expect(d.blocked_reason).toBe('Waiting for "Buy filter" (pending)');
    expect(d.depends_on?.id).toBe(buy.id);
    expect(svc.getTaskDetail(buy.id).dependents.map((x) => x.id)).toEqual([fit.id]);
    expect(svc.listTasks({ filter: "blocked" }).map((t) => t.id)).toEqual([fit.id]);
    expect(code(() => svc.updateTaskStatus(fit.id, "completed", { confirmed_by_user: true }))).toBe("DEPENDENCY_INCOMPLETE");
    svc.updateTaskStatus(buy.id, "completed", { confirmed_by_user: true });
    expect(svc.getTaskDetail(fit.id).blocked_reason).toBeNull();
    expect(svc.updateTaskStatus(fit.id, "completed", { confirmed_by_user: true }).status).toBe("completed");
  });

  it("a situation's own task list knows about a prerequisite outside the situation", () => {
    const s = sit();
    const buy = svc.addTask({ title: "Buy a bearing kit" }); // household task
    svc.addTask({ situation_id: s, title: "Fit the bearing", depends_on_task_id: buy.id });
    const [t] = svc.getSituation(s).tasks as (Task & { waiting_on: string | null })[];
    expect(t.waiting_on).toBe("Buy a bearing kit");
  });
});

describe("editing, reopening and deleting", () => {
  it("edits fields, moves between a situation and standalone, and records each change", () => {
    const s = sit();
    const t = svc.addTask({ title: "Clear space under the sink" });
    const moved = svc.updateTask(t.id, { situation_id: s, priority: "high", due_at: H(20) }, "user");
    expect(moved.situation_id).toBe(s);
    expect(svc.getSituation(s).tasks.map((x) => x.id)).toContain(t.id);
    const back = svc.updateTask(t.id, { situation_id: null, due_at: null }, "user");
    expect(back.situation_id).toBeNull(); expect(back.due_at).toBeNull();
    expect(code(() => svc.updateTask(t.id, {}))).toBe("NO_CHANGE");
    const types = svc.getActivityLog(null, 50, t.id).map((e) => e.event_type);
    // move in (+ due time), then move out: the move out is logged on the task and on the situation it left
    expect(types).toEqual(["task_created", "task_updated", "task_rescheduled", "task_updated", "task_updated", "task_rescheduled"]);
    // the situation's own timeline also shows the task leaving it
    expect(svc.getActivityLog(s).some((e) => e.description.startsWith("Task moved out of this situation"))).toBe(true);
  });

  it("reopens explicitly, never through a status change, and not inside a resolved situation", () => {
    const t = svc.addTask({ title: "Water the plants" });
    svc.updateTaskStatus(t.id, "completed", { confirmed_by_user: true });
    expect(code(() => svc.updateTaskStatus(t.id, "pending"))).toBe("INVALID_TRANSITION");
    expect(code(() => svc.updateTask(t.id, { title: "x" }))).toBe("INVALID_STATE");
    const r = svc.reopenTask(t.id, "Not done after all", "user");
    expect(r.status).toBe("pending"); expect(r.completed_at).toBeNull();
    const s = sit();
    const st = svc.addTask({ situation_id: s, title: "Be home" });
    svc.resolveSituation(s, { confirmed_by_user: true, close_outstanding: true });
    expect(code(() => svc.reopenTask(st.id))).toBe("INVALID_STATE");
  });

  it("deletes a task, keeps its history and releases dependents", () => {
    const buy = svc.addTask({ title: "Buy filter" });
    const fit = svc.addTask({ title: "Replace filter", depends_on_task_id: buy.id });
    const r = svc.deleteTask(buy.id);
    expect(r.released_dependents).toBe(1);
    expect(code(() => svc.getTaskDetail(buy.id))).toBe("NOT_FOUND");
    expect(svc.getTaskDetail(fit.id).depends_on).toBeNull();
    expect(svc.getActivityLog(null, 50, buy.id).map((e) => e.event_type)).toEqual(["task_created", "task_deleted"]);
    expect(graph.integrity().problems).toEqual([]);
  });
});

describe("recurrence", () => {
  it("saves exactly one next occurrence on completion, keeping the local time and attachments", async () => {
    const d = await doc("filter-manual.txt", "Replace the filter cartridge every month");
    const t = svc.addTask({ title: "Replace water filter", recurrence: "monthly", due_at: "2026-10-31T04:30:00.000Z", document_ids: [d] }); // 31 Oct, 10:00 IST
    expect(code(() => svc.addTask({ title: "Weekly check", recurrence: "weekly" }))).toBe("INVALID_INPUT"); // needs a due time
    svc.updateTaskStatus(t.id, "completed", { confirmed_by_user: true });
    const next = svc.listTasks({ q: "water filter" });
    expect(next).toHaveLength(1);
    expect(next[0].recurrence_of).toBe(t.id);
    expect(next[0].due_at).toBe("2026-11-30T04:30:00.000Z"); // month end clamps (30 Nov), still 10:00 IST
    expect(next[0].document_count).toBe(1);
    expect(svc.getTaskDetail(t.id).next_occurrence?.id).toBe(next[0].id);
    expect(svc.getTaskDetail(next[0].id).previous_occurrence?.id).toBe(t.id);
    // reopening and completing again does not create a second successor
    expect(code(() => svc.reopenTask(t.id))).toBe("DUPLICATE");
  });

  it("moves a late occurrence into the future and survives a restart without duplicates", () => {
    const dir = tmp(); const file = path.join(dir, "r.db");
    let d1 = openDb(file); let s1 = new HomeRelayService(d1, { now: () => new Date("2026-11-20T00:00:00Z"), tz: "Asia/Kolkata" });
    const t = s1.addTask({ title: "Weekly inspection", recurrence: "weekly", due_at: "2026-10-26T03:30:00.000Z" }); // Monday 09:00 IST, 3+ weeks ago
    s1.updateTaskStatus(t.id, "completed", { confirmed_by_user: true });
    d1.close();
    d1 = openDb(file); s1 = new HomeRelayService(d1, { now: () => new Date("2026-11-20T00:00:00Z"), tz: "Asia/Kolkata" });
    const open = s1.listTasks({ q: "weekly inspection" });
    expect(open).toHaveLength(1);
    expect(open[0].due_at).toBe("2026-11-23T03:30:00.000Z"); // next Monday 09:00 IST after "now"
    expect(code(() => d1.prepare("INSERT INTO tasks (id,title,status,created_at,updated_at,recurrence_of) VALUES ('x','dup','pending','t','t',?)").run(t.id))).toMatch(/UNIQUE/);
    d1.close();
  });
});

describe("task documents and document deletion", () => {
  it("links both ways, is idempotent, and deleting the document removes only the links", async () => {
    const s = sit();
    const t = svc.addTask({ situation_id: s, title: "Show the receipt to the technician" });
    const other = svc.addTask({ title: "Unrelated" });
    const d = await doc("receipt.txt", "Washer receipt, model WM-4471");
    docs.link(d, s, "user");
    expect(svc.linkTaskDocument(t.id, d, "user").already_linked).toBe(false);
    expect(svc.linkTaskDocument(t.id, d, "user").already_linked).toBe(true);
    expect(docs.get(d).linked_tasks.map((x) => x.id)).toEqual([t.id]);
    expect(svc.getTaskDetail(t.id).documents.map((x) => x.id)).toEqual([d]);
    expect(code(() => svc.linkTaskDocument(t.id, "missing"))).toBe("NOT_FOUND");
    docs.delete(d, "user");
    expect(svc.getTaskDetail(t.id).documents).toEqual([]);
    expect(svc.getTaskDetail(other.id).task.id).toBe(other.id);
    expect(svc.getSituation(s).situation.id).toBe(s);
    expect(svc.getActivityLog(null, 50, t.id).at(-1)?.event_type).toBe("document_unlinked");
    expect(graph.graph().nodes.some((n) => n.id === d)).toBe(false);
    expect(graph.integrity().problems).toEqual([]);
    expect(code(() => svc.unlinkTaskDocument(t.id, d))).toBe("NOT_FOUND");
  });
});

describe("household map, connections and search", () => {
  it("derives nodes and edges from stored relationships only, and updates after each change", async () => {
    const s = sit();
    const buy = svc.addTask({ title: "Buy filter" });
    const fit = svc.addTask({ situation_id: s, title: "Fit filter", depends_on_task_id: buy.id });
    const d = await doc("warranty.txt", "Warranty card");
    docs.link(d, s, "user");
    let g = graph.graph();
    expect(g.nodes.map((n) => n.key).sort()).toEqual([`document:${d}`, `situation:${s}`, `task:${buy.id}`, `task:${fit.id}`].sort());
    expect(g.edges.map((e) => `${e.relation} ${e.source} ${e.target}`).sort()).toEqual([
      `attached_to document:${d} situation:${s}`, `depends_on task:${fit.id} task:${buy.id}`, `part_of task:${fit.id} situation:${s}`,
    ].sort());
    expect(g.nodes.find((n) => n.id === s)!.route).toBe(`#/situation/${s}`);
    expect(g.nodes.find((n) => n.id === fit.id)!.degree).toBe(2);
    // completing removes it from the default (open) map, include_done brings it back
    svc.updateTaskStatus(buy.id, "completed", { confirmed_by_user: true });
    g = graph.graph();
    expect(g.nodes.some((n) => n.id === buy.id)).toBe(false);
    expect(g.edges.some((e) => e.relation === "depends_on")).toBe(false); // no edge to a node that is not on the map
    expect(graph.graph({ include_done: true }).edges.some((e) => e.relation === "depends_on")).toBe(true);
    // every edge points at a node that exists
    const keys = new Set(g.nodes.map((n) => n.key));
    expect(g.edges.every((e) => keys.has(e.source) && keys.has(e.target))).toBe(true);
  });

  it("collects everything connected to a situation, with gaps from the data", async () => {
    const s = sit();
    const buy = svc.addTask({ title: "Buy filter" });
    const fit = svc.addTask({ situation_id: s, title: "Fit filter", depends_on_task_id: buy.id });
    const r = await doc("receipt.txt", "Filter receipt");
    svc.linkTaskDocument(fit.id, r, "user");
    const c = graph.connections("situation", s);
    expect(c.center.id).toBe(s);
    expect(c.related.map((x) => `${x.type}:${x.relation}`)).toEqual(["task:task in this situation", "document:attached to a task", "task:prerequisite of a task"]);
    expect(c.gaps).toContain('"Fit filter" is waiting for "Buy filter"');
    expect(c.gaps).not.toContain("No documents are attached"); // a document on one of its tasks counts
    expect(graph.connections("situation", sit("Empty")).gaps).toEqual(["No documents are attached", "No tasks yet", "Missing information: What time window did the technician give (for example 2 PM to 4 PM)?"]);
    const ct = graph.connections("task", fit.id);
    expect(ct.related.map((x) => x.relation)).toEqual(["situation this task belongs to", "must be done first", "attached to this task"]);
    const cd = graph.connections("document", r);
    expect(cd.related.map((x) => x.id)).toEqual([fit.id]);
    expect(code(() => graph.connections("task", "missing"))).toBe("NOT_FOUND");
  });

  it("searches situations, tasks and document text with real routes", async () => {
    const s = sit("Washer repair visit");
    const t = svc.addTask({ title: "Find the washer receipt", tags: ["laundry"] });
    const d = await docs.ingest({ bytes: makePdf(["Warranty card", "Washer model WM-4471 serial 88213"]), filename: "warranty.pdf" }, "user");
    const r = graph.search("washer");
    expect(r.map((x) => x.key)).toEqual([`situation:${s}`, `task:${t.id}`, `document:${d.id}`]);
    expect(r[2].route).toBe(`#/document/${d.id}`);
    expect(graph.search("88213")[0].snippet).toContain("«88213»");
    expect(graph.search("laundry").map((x) => x.id)).toEqual([t.id]);
    expect(graph.search("")).toEqual([]);
    expect(graph.search("%")).toEqual([]);
    expect(graph.search("washer", { types: ["task"] }).map((x) => x.type)).toEqual(["task"]);
  });

  it("the integrity check reports a broken reference", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO tasks (id,situation_id,title,status,created_at,updated_at) VALUES ('t1','gone','x','pending','t','t')").run();
    expect(graph.integrity().problems).toEqual(["1 task(s) pointing at a missing situation"]);
  });
});

describe("migration v3 -> v4", () => {
  it("keeps tasks, dependencies and links when the tasks table is rebuilt", () => {
    const file = path.join(tmp(), "v3.db");
    const old = new (require("better-sqlite3"))(file); old.pragma("foreign_keys = ON");
    migrate(old, 3);
    old.prepare("INSERT INTO situations (id,title,category,status,created_at,updated_at) VALUES ('s','S','general','open','t','t')").run();
    old.prepare("INSERT INTO tasks (id,situation_id,title,status,created_at,updated_at) VALUES ('a','s','A','pending','t','t')").run();
    old.prepare("INSERT INTO tasks (id,situation_id,title,status,depends_on_task_id,created_at,updated_at) VALUES ('b','s','B','pending','a','t','t')").run();
    old.close();
    const db4 = openDb(file);
    expect(db4.pragma("user_version", { simple: true })).toBe(5); // v4 rebuild, then v5 (OAuth tables)
    const rows = db4.prepare("SELECT id, situation_id, depends_on_task_id, priority, category, tags_json, recurrence FROM tasks ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", situation_id: "s", depends_on_task_id: null, priority: "normal", category: "general", tags_json: "[]", recurrence: "none" },
      { id: "b", situation_id: "s", depends_on_task_id: "a", priority: "normal", category: "general", tags_json: "[]", recurrence: "none" },
    ]);
    expect(db4.pragma("foreign_keys", { simple: true })).toBe(1);
    // the rebuilt table still cascades and still enforces its foreign keys
    expect(() => db4.prepare("INSERT INTO tasks (id,situation_id,title,status,created_at,updated_at) VALUES ('c','nope','C','pending','t','t')").run()).toThrow(/FOREIGN KEY/);
    db4.prepare("DELETE FROM situations WHERE id='s'").run();
    expect((db4.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
    db4.close();
  });
});
