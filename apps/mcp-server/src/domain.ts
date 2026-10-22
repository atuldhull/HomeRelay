import { randomUUID } from "node:crypto";
import type {
  ActivityEvent, Actor, Category, Constraints, Plan, Preference, Priority, Proposal, Recurrence, Situation,
  SituationDetail, SituationStatus, SituationSummary, Source, Task, TaskCategory, TaskDetail, TaskFilter, TaskKind, TaskStatus, TaskWithContext, WorkflowInfo, WorkloadSummary,
} from "@homerelay/shared";
import { DEFAULT_TZ, TASK_TRANSITIONS, formatClock, nextLocalTimeIso, sameLocalDay, shiftLocal, zonedToUtcIso, localYmd } from "@homerelay/shared";
import { SCENARIOS } from "./scenarios";
import type { Db } from "./db";
import { buildPlan } from "./planner";

export class DomainError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}

const OPEN_TASK = ["pending", "in_progress", "blocked"];
const OPEN_SITUATION: SituationStatus[] = ["open", "in_progress", "blocked"];
const isIso = (v: string) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

function must<T>(v: T | undefined, code: string, msg: string): T {
  if (v === undefined) throw new DomainError(code, msg);
  return v;
}

export interface ServiceOptions { now?: () => Date; tz?: string }

interface TaskFields {
  title: string; description?: string; kind?: TaskKind; due?: string | null; dep?: string | null; templateKey?: string | null;
  priority?: Priority; category?: TaskCategory; tags?: string[]; recurrence?: Recurrence; recurrenceOf?: string | null;
}

export class HomeRelayService {
  private now: () => Date;
  readonly tz: string;
  constructor(private db: Db, opts: ServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.tz = opts.tz ?? DEFAULT_TZ;
  }
  private ts() { return this.now().toISOString(); }

  // ---------- row mappers ----------
  private sit(r: any): Situation {
    const { constraints_json, ...rest } = r;
    return { ...rest, constraints: JSON.parse(constraints_json) } as Situation;
  }
  private prop(r: any): Proposal {
    const { plan_json, applied_action_ids_json, ...rest } = r;
    return { ...rest, plan: JSON.parse(plan_json), applied_action_ids: JSON.parse(applied_action_ids_json) } as Proposal;
  }
  private task<T extends Task = Task>(r: any): T {
    const { tags_json, ...rest } = r;
    return { ...rest, tags: JSON.parse(tags_json ?? "[]") } as T;
  }
  private tasksWhere(sql: string, ...args: unknown[]): Task[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE ${sql}`).all(...args) as any[]).map((r) => this.task(r));
  }
  private ev(r: any): ActivityEvent {
    const { metadata_json, seq: _seq, ...rest } = r;
    return { ...rest, metadata: JSON.parse(metadata_json) } as ActivityEvent;
  }

  /** Writes an activity event. Always called inside the same transaction as the mutation it describes. */
  private log(situationId: string | null, type: string, description: string, actor: Actor, meta: Record<string, unknown> = {}, taskId: string | null = null) {
    this.db.prepare(
      `INSERT INTO activity_events (id, situation_id, task_id, event_type, description, actor, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), situationId, taskId, type, description, actor, JSON.stringify(meta), this.ts());
  }

  private getSit(id: string): Situation {
    return this.sit(must(this.db.prepare("SELECT * FROM situations WHERE id=?").get(id), "NOT_FOUND", `Situation ${id} not found`));
  }
  private getTask(id: string): Task {
    return this.task(must(this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id), "NOT_FOUND", `Task ${id} not found`));
  }
  private getProp(id: string): Proposal {
    return this.prop(must(this.db.prepare("SELECT * FROM plan_proposals WHERE id=?").get(id), "NOT_FOUND", `Proposal ${id} not found`));
  }
  private touchSituation(id: string | null, status?: SituationStatus) {
    if (!id) return;
    if (status) this.db.prepare("UPDATE situations SET status=?, updated_at=? WHERE id=?").run(status, this.ts(), id);
    else this.db.prepare("UPDATE situations SET updated_at=? WHERE id=?").run(this.ts(), id);
  }

  // ---------- situations ----------
  createSituation(i: { title: string; description?: string; category: Category; expected_at?: string | null; priority?: Priority; source?: Source; constraints?: Constraints; initial_task?: { title: string; due_at?: string | null } }, actor: Actor = "agent"): Situation {
    if (i.expected_at && !isIso(i.expected_at)) throw new DomainError("INVALID_INPUT", "expected_at must be an ISO-8601 UTC timestamp");
    for (const k of ["available_from", "window_end"] as const) if (i.constraints?.[k] && !isIso(i.constraints[k]!)) throw new DomainError("INVALID_INPUT", `${k} must be an ISO-8601 UTC timestamp`);
    if (i.initial_task?.due_at && !isIso(i.initial_task.due_at)) throw new DomainError("INVALID_INPUT", "initial task due_at must be an ISO-8601 UTC timestamp");
    if (i.expected_at && i.constraints?.window_end && new Date(i.constraints.window_end) <= new Date(i.expected_at)) throw new DomainError("INVALID_INPUT", "window_end must be after expected_at");
    const id = randomUUID(); const t = this.ts();
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO situations (id,title,description,category,status,priority,expected_at,source,constraints_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, i.title.trim(), i.description ?? "", i.category, "open", i.priority ?? "normal", i.expected_at ?? null, i.source ?? "user", JSON.stringify(i.constraints ?? {}), t, t);
      this.log(id, "situation_created", `Situation created: ${i.title.trim()}`, actor, { source: i.source ?? "user", category: i.category });
      if (i.initial_task?.title?.trim()) this.insertTask(id, { title: i.initial_task.title, due: i.initial_task.due_at ?? null }, actor, { initial: true });
      return this.getSit(id);
    })();
  }

  getSituation(id: string): SituationDetail {
    const situation = this.getSit(id);
    const tasks: Task[] = this.withContext((this.db.prepare("SELECT * FROM tasks WHERE situation_id=? ORDER BY created_at, rowid").all(id) as any[]).map((r) => ({ ...r, situation_title: situation.title })), this.now());
    const proposals = (this.db.prepare("SELECT * FROM plan_proposals WHERE situation_id=? ORDER BY created_at DESC, rowid DESC").all(id) as any[]).map((r) => this.prop(r));
    const scopes = situation.source === "demo" ? ["household", "demo"] : ["household"];
    const preferences = this.db.prepare(`SELECT key,value,updated_at FROM preferences WHERE scope IN (${scopes.map(() => "?").join(",")}) ORDER BY key`).all(...scopes) as Preference[];
    return { situation, tasks, proposals, preferences, workflow: this.workflow(situation, tasks, proposals.some((p) => p.status === "proposed")) };
  }

  listSituations(o: { statuses?: SituationStatus[]; source?: Source; limit?: number } = {}): SituationSummary[] {
    const statuses = o.statuses?.length ? o.statuses : OPEN_SITUATION;
    const where = [`status IN (${statuses.map(() => "?").join(",")})`]; const args: unknown[] = [...statuses];
    if (o.source) { where.push("source=?"); args.push(o.source); }
    const rows = this.db.prepare(`SELECT * FROM situations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, o.limit ?? 50) as any[];
    // Two queries for the whole page instead of two per situation.
    const ids = rows.map((r) => r.id as string);
    const marks = ids.map(() => "?").join(",");
    const tasksBy = new Map<string, Task[]>();
    const pendingBy = new Map<string, string>();
    if (ids.length) {
      for (const t of this.tasksWhere(`situation_id IN (${marks}) ORDER BY created_at, rowid`, ...ids)) {
        (tasksBy.get(t.situation_id!) ?? tasksBy.set(t.situation_id!, []).get(t.situation_id!)!).push(t);
      }
      for (const p of this.db.prepare(`SELECT id, situation_id FROM plan_proposals WHERE status='proposed' AND situation_id IN (${marks}) ORDER BY created_at DESC, rowid DESC`).all(...ids) as { id: string; situation_id: string }[]) {
        if (!pendingBy.has(p.situation_id)) pendingBy.set(p.situation_id, p.id);
      }
    }
    return rows.map((r) => {
      const s = this.sit(r);
      const tasks = tasksBy.get(s.id) ?? [];
      const open = tasks.filter((t) => OPEN_TASK.includes(t.status));
      const next = open.map((t) => t.due_at).filter((x): x is string => !!x).sort()[0] ?? null;
      const pend = pendingBy.has(s.id) ? { id: pendingBy.get(s.id)! } : undefined;
      const wf = this.workflow(s, tasks, !!pend);
      return {
        ...s, open_task_count: open.length, total_task_count: tasks.length, next_due_at: next, pending_proposal_id: pend?.id ?? null,
        can_resolve: wf.can_resolve, next_action: wf.next_action,
      };
    });
  }
  /** Scenario-driven view of where a situation stands and what to do next. Derived from real state only. */
  private workflow(s: Situation, tasks: Task[], hasProposal: boolean): WorkflowInfo {
    const sc = SCENARIOS[s.category];
    const canResolve = s.status !== "resolved" && sc.canResolve({ situation: s, tasks, tz: this.tz, now: this.now() });
    const open = tasks.filter((t) => OPEN_TASK.includes(t.status));
    return { scenario: sc.label, summary: sc.summary, resolution: sc.resolution, can_resolve: canResolve, next_action: this.nextAction(s, open, hasProposal, canResolve) };
  }
  private nextAction(s: Situation, open: Task[], hasProposal: boolean, canResolve = false): string {
    if (s.status === "resolved") return "Resolved";
    if (hasProposal) return "Review the proposed plan";
    if (canResolve) return "All done: confirm to resolve";
    const missing = SCENARIOS[s.category].required.find((r) => !r.known({ situation: s, tasks: [], tz: this.tz, now: this.now() }));
    if (missing && open.length === 0) return missing.question;
    if (open.length) {
      const t = [...open].sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"))[0];
      return `${t.title}${t.due_at ? ` · ${formatClock(t.due_at, this.tz)}` : ""}`;
    }
    return "Ask HomeRelay to plan this";
  }

  getTasks(situationId: string, statuses?: TaskStatus[]): Task[] {
    this.getSit(situationId);
    const rows = this.tasksWhere("situation_id=? ORDER BY created_at, rowid", situationId);
    return statuses?.length ? rows.filter((t) => statuses.includes(t.status)) : rows;
  }

  setConstraints(situationId: string, patch: Constraints, actor: Actor = "agent"): Situation {
    for (const k of ["available_from", "window_end"] as const) if (patch[k] && !isIso(patch[k]!)) throw new DomainError("INVALID_INPUT", `${k} must be an ISO-8601 UTC timestamp`);
    return this.db.transaction(() => {
      const s = this.getSit(situationId);
      if (s.status === "resolved") throw new DomainError("INVALID_STATE", "Situation is resolved; constraints can no longer change");
      const next = { ...s.constraints, ...patch };
      if (JSON.stringify(next) === JSON.stringify(s.constraints)) return s;
      this.db.prepare("UPDATE situations SET constraints_json=?, updated_at=? WHERE id=?").run(JSON.stringify(next), this.ts(), situationId);
      this.log(situationId, "constraints_updated",
        patch.available_from ? `Availability updated: free from ${formatClock(patch.available_from, this.tz)}` : "Constraints updated",
        actor, { old: s.constraints, new: next });
      return this.getSit(situationId);
    })();
  }

  updateSituation(situationId: string, patch: { title?: string; description?: string; expected_at?: string | null; priority?: Priority }, actor: Actor = "agent"): Situation {
    if (patch.expected_at && !isIso(patch.expected_at)) throw new DomainError("INVALID_INPUT", "expected_at must be an ISO-8601 UTC timestamp");
    return this.db.transaction(() => {
      const s = this.getSit(situationId);
      if (s.status === "resolved") throw new DomainError("INVALID_STATE", "Situation is resolved and can no longer be edited");
      const next = { title: patch.title?.trim() || s.title, description: patch.description ?? s.description, expected_at: patch.expected_at === undefined ? s.expected_at : patch.expected_at, priority: patch.priority ?? s.priority };
      if (next.title === s.title && next.description === s.description && next.expected_at === s.expected_at && next.priority === s.priority) return s;
      const wEnd = s.constraints.window_end;
      if (next.expected_at && wEnd && new Date(wEnd) <= new Date(next.expected_at)) throw new DomainError("INVALID_INPUT", "expected_at must be before the window end; update window_end first");
      this.db.prepare("UPDATE situations SET title=?, description=?, expected_at=?, priority=?, updated_at=? WHERE id=?").run(next.title, next.description, next.expected_at, next.priority, this.ts(), situationId);
      const timeChanged = next.expected_at !== s.expected_at;
      this.log(situationId, "situation_updated", timeChanged ? `Time changed: ${formatClock(s.expected_at, this.tz)} → ${formatClock(next.expected_at, this.tz)}` : "Situation details updated", actor,
        { old: { title: s.title, expected_at: s.expected_at, priority: s.priority }, new: { title: next.title, expected_at: next.expected_at, priority: next.priority } });
      return this.getSit(situationId);
    })();
  }

  /** Adds overdue (past due time, open), waiting_on (title of an unfinished prerequisite) and the attached-document count. */
  private withContext(raw: any[], now: Date): TaskWithContext[] {
    if (!raw.length) return [];
    const depIds = [...new Set(raw.map((r) => r.depends_on_task_id).filter(Boolean))] as string[];
    const deps = new Map((depIds.length ? this.db.prepare(`SELECT id, title, status FROM tasks WHERE id IN (${depIds.map(() => "?").join(",")})`).all(...depIds) as { id: string; title: string; status: string }[] : []).map((t) => [t.id, t]));
    const ids = raw.map((r) => r.id as string);
    const docCount = new Map((this.db.prepare(`SELECT task_id, COUNT(*) AS n FROM task_documents WHERE task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`).all(...ids) as { task_id: string; n: number }[]).map((r) => [r.task_id, r.n]));
    return raw.map((r) => {
      const t = this.task<Task & { situation_title: string | null }>(r);
      const dep = t.depends_on_task_id ? deps.get(t.depends_on_task_id) : undefined;
      const open = OPEN_TASK.includes(t.status);
      return { ...t, situation_title: r.situation_title ?? null, document_count: docCount.get(t.id) ?? 0, overdue: open && !!t.due_at && new Date(t.due_at) < now, waiting_on: open && dep && !["completed", "cancelled"].includes(dep.status) ? dep.title : null };
    });
  }

  /** Tasks across the household (situation tasks and standalone tasks). Filters derive from stored state and the clock only. */
  listTasks(o: { filter?: TaskFilter; situation_id?: string; document_id?: string; category?: TaskCategory; priority?: Priority; q?: string; limit?: number } = {}): TaskWithContext[] {
    if (o.situation_id) this.getSit(o.situation_id);
    const now = this.now();
    const f = o.filter ?? "open";
    const where: string[] = []; const args: unknown[] = [];
    if (f === "done") where.push("t.status IN ('completed','cancelled')");
    else if (f !== "all") where.push("t.status IN ('pending','in_progress','blocked')");
    if (f === "standalone") where.push("t.situation_id IS NULL");
    if (o.situation_id) { where.push("t.situation_id=?"); args.push(o.situation_id); }
    if (o.document_id) { where.push("t.id IN (SELECT task_id FROM task_documents WHERE document_id=?)"); args.push(o.document_id); }
    if (o.category) { where.push("t.category=?"); args.push(o.category); }
    if (o.priority) { where.push("t.priority=?"); args.push(o.priority); }
    for (const w of (o.q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 6) ?? []) {
      where.push("(lower(t.title) LIKE ? ESCAPE '\\' OR lower(t.description) LIKE ? ESCAPE '\\' OR lower(t.tags_json) LIKE ? ESCAPE '\\' OR lower(coalesce(s.title,'')) LIKE ? ESCAPE '\\')");
      const like = `%${w.replace(/[\\%_]/g, "\\$&")}%`; args.push(like, like, like, like);
    }
    const rows = this.db.prepare(`SELECT t.*, s.title AS situation_title FROM tasks t LEFT JOIN situations s ON s.id=t.situation_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${f === "done" ? "t.updated_at DESC" : "t.due_at IS NULL, t.due_at, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.created_at"} LIMIT 1000`).all(...args);
    const all = this.withContext(rows, now);
    const today = (t: TaskWithContext) => !t.overdue && !!t.due_at && sameLocalDay(t.due_at, now, this.tz);
    const pick = f === "overdue" ? all.filter((t) => t.overdue)
      : f === "today" ? all.filter(today)
      : f === "blocked" || f === "waiting" ? all.filter((t) => t.status === "blocked" || !!t.waiting_on)
      : f === "upcoming" ? all.filter((t) => !t.overdue && !!t.due_at && !today(t))
      : all;
    return pick.slice(0, Math.min(o.limit ?? 100, 500));
  }

  /** Everything the dashboard needs, derived from stored state and the clock. Overdue means "past its due time", not "failed". */
  workloadSummary(): WorkloadSummary {
    const now = this.now();
    const rows = this.db.prepare(`SELECT t.*, s.title AS situation_title FROM tasks t LEFT JOIN situations s ON s.id=t.situation_id
      WHERE (s.id IS NULL OR s.status != 'resolved') AND t.status IN ('pending','in_progress','blocked') ORDER BY t.due_at IS NULL, t.due_at, t.created_at`).all();
    const tasks = this.withContext(rows, now);
    const weekEnd = now.getTime() + 8 * 86_400_000;
    const isToday = (t: TaskWithContext) => !!t.due_at && sameLocalDay(t.due_at, now, this.tz);
    const open = this.listSituations({ limit: 200 });
    const waiting = this.db.prepare(`SELECT p.id AS proposal_id, p.summary, p.situation_id, s.title AS situation_title FROM plan_proposals p JOIN situations s ON s.id=p.situation_id
      WHERE p.status='proposed' AND s.status!='resolved' ORDER BY p.created_at DESC`).all() as WorkloadSummary["waiting_approval"];
    const recent = (this.db.prepare(`SELECT e.*, s.title AS situation_title FROM activity_events e LEFT JOIN situations s ON s.id=e.situation_id ORDER BY e.seq DESC LIMIT 8`).all() as any[])
      .map((r) => ({ ...this.ev(r), situation_title: r.situation_title as string | null }));
    return {
      now: now.toISOString(), tz: this.tz, open_situations: open.length, open_tasks: tasks.length,
      overdue: tasks.filter((t) => t.overdue),
      due_today: tasks.filter((t) => !t.overdue && isToday(t)),
      blocked: tasks.filter((t) => t.status === "blocked" || t.waiting_on),
      upcoming: tasks.filter((t) => !t.overdue && !!t.due_at && !isToday(t) && new Date(t.due_at).getTime() < weekEnd),
      standalone_open: tasks.filter((t) => !t.situation_id).length,
      recent_documents: this.db.prepare("SELECT id, title, kind, category, created_at FROM documents ORDER BY created_at DESC, rowid DESC LIMIT 5").all() as WorkloadSummary["recent_documents"],
      waiting_approval: waiting,
      can_resolve: open.filter((x) => x.can_resolve).map((x) => ({ situation_id: x.id, situation_title: x.title })),
      recent_activity: recent,
    };
  }

  // ---------- planning ----------
  proposePlan(situationId: string, actor: Actor = "agent"): { proposal: Proposal | null; plan: Plan } {
    return this.db.transaction(() => {
      const s = this.getSit(situationId);
      if (s.status === "resolved") throw new DomainError("INVALID_STATE", "Situation is already resolved");
      const tasks = this.tasksWhere("situation_id=?", situationId);
      const plan = buildPlan(s, tasks, this.tz, this.now());
      if (plan.actions.length === 0) return { proposal: null, plan };
      // Supersede earlier unapproved proposals so only one plan is awaiting a decision.
      const old = this.db.prepare("SELECT id FROM plan_proposals WHERE situation_id=? AND status='proposed'").all(situationId) as { id: string }[];
      for (const o of old) {
        this.db.prepare("UPDATE plan_proposals SET status='superseded', updated_at=? WHERE id=?").run(this.ts(), o.id);
        this.log(situationId, "plan_superseded", "An earlier proposal was replaced by a newer one", "system", { proposal_id: o.id });
      }
      const id = randomUUID(); const t = this.ts();
      this.db.prepare(`INSERT INTO plan_proposals (id,situation_id,summary,status,plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, situationId, plan.summary, "proposed", JSON.stringify(plan), t, t);
      this.log(situationId, "plan_proposed", `Plan proposed: ${plan.actions.length} action(s), awaiting approval`, actor, { proposal_id: id, action_ids: plan.actions.map((a) => a.id) });
      return { proposal: this.getProp(id), plan };
    })();
  }

  approvePlan(proposalId: string, selected?: string[]): { proposal: Proposal; created_tasks: Task[]; rescheduled_tasks: Task[]; skipped: string[]; already_applied: boolean } {
    return this.db.transaction(() => {
      const p = this.getProp(proposalId);
      if (p.status === "approved") return { proposal: p, created_tasks: [], rescheduled_tasks: [], skipped: [], already_applied: true };
      if (p.status !== "proposed") throw new DomainError("INVALID_STATE", `Proposal is ${p.status} and cannot be approved`);
      const allIds = p.plan.actions.map((a) => a.id);
      const chosen = selected?.length ? selected : allIds;
      const bad = chosen.filter((x) => !allIds.includes(x));
      if (bad.length) throw new DomainError("INVALID_INPUT", `Unknown action id(s): ${bad.join(", ")}`);
      const sit = this.getSit(p.situation_id);
      if (sit.status === "resolved") throw new DomainError("INVALID_STATE", "The situation is resolved; this plan can no longer be applied");
      const created: Task[] = []; const resched: Task[] = []; const skipped: string[] = []; const refMap = new Map<string, string>();
      this.log(p.situation_id, "plan_approved", `Plan approved (${chosen.length} of ${allIds.length} action(s))`, "user", { proposal_id: p.id, action_ids: chosen });
      for (const a of p.plan.actions.filter((x) => chosen.includes(x.id))) {
        if (a.type === "add_task") {
          const dup = this.db.prepare(`SELECT id FROM tasks WHERE situation_id=? AND (title=? OR (template_key IS NOT NULL AND template_key=?)) AND status IN ('pending','in_progress','blocked')`).get(p.situation_id, a.title, a.template_key ?? null) as { id: string } | undefined;
          if (dup) { skipped.push(a.id); refMap.set(a.id, dup.id); continue; }
          const dep = (a.depends_on_ref ? refMap.get(a.depends_on_ref) : undefined) ?? a.depends_on_task_id ?? null;
          const t = this.insertTask(p.situation_id, { title: a.title, description: a.description, kind: a.kind, due: a.due_at, dep, templateKey: a.template_key ?? null }, "agent", { proposal_id: p.id, action_id: a.id });
          refMap.set(a.id, t.id); created.push(t);
        } else {
          const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(a.task_id);
          const cur = row ? this.task(row) : undefined;
          if (!cur || !OPEN_TASK.includes(cur.status) || cur.due_at === a.new_due_at) { skipped.push(a.id); continue; }
          resched.push(this.doReschedule(cur, a.new_due_at, "Availability changed", "agent", { proposal_id: p.id, action_id: a.id }));
        }
      }
      this.db.prepare("UPDATE plan_proposals SET status='approved', approved_at=?, updated_at=?, applied_action_ids_json=? WHERE id=?")
        .run(this.ts(), this.ts(), JSON.stringify(chosen.filter((c) => !skipped.includes(c))), p.id);
      if (sit.status === "open") this.touchSituation(sit.id, "in_progress"); else this.touchSituation(sit.id);
      return { proposal: this.getProp(p.id), created_tasks: created, rescheduled_tasks: resched, skipped, already_applied: false };
    })();
  }

  rejectPlan(proposalId: string, reason?: string): Proposal {
    return this.db.transaction(() => {
      const p = this.getProp(proposalId);
      if (p.status === "rejected") return p;
      if (p.status !== "proposed") throw new DomainError("INVALID_STATE", `Proposal is ${p.status} and cannot be rejected`);
      this.db.prepare("UPDATE plan_proposals SET status='rejected', rejected_at=?, updated_at=? WHERE id=?").run(this.ts(), this.ts(), p.id);
      this.log(p.situation_id, "plan_rejected", `Plan rejected${reason ? `: ${reason}` : ""}`, "user", { proposal_id: p.id, reason: reason ?? null });
      this.touchSituation(p.situation_id);
      return this.getProp(p.id);
    })();
  }

  // ---------- tasks ----------
  private insertTask(situationId: string | null, f: TaskFields, actor: Actor, meta: Record<string, unknown> = {}): Task {
    const id = randomUUID(); const t = this.ts(); const title = f.title.trim();
    this.db.prepare(`INSERT INTO tasks (id,situation_id,title,description,kind,status,due_at,depends_on_task_id,template_key,priority,category,tags_json,recurrence,recurrence_of,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, situationId, title, f.description ?? "", f.kind ?? "general", "pending", f.due ?? null, f.dep ?? null, f.templateKey ?? null, f.priority ?? "normal", f.category ?? "general", JSON.stringify(f.tags ?? []), f.recurrence ?? "none", f.recurrenceOf ?? null, t, t);
    this.log(situationId, "task_created", `Task created: ${title}${f.due ? ` (due ${formatClock(f.due, this.tz)})` : ""}`, actor, { ...meta, due_at: f.due ?? null, kind: f.kind ?? "general", standalone: !situationId }, id);
    return this.getTask(id);
  }

  /** Validates a prerequisite: it must exist, not be the task itself, not create a cycle, and not belong to a different situation. */
  private checkDependency(taskId: string | null, situationId: string | null, depId: string) {
    if (taskId && depId === taskId) throw new DomainError("INVALID_INPUT", "A task cannot depend on itself");
    const d = this.getTask(depId);
    if (d.situation_id && situationId && d.situation_id !== situationId) throw new DomainError("INVALID_INPUT", "Dependency belongs to a different situation");
    if (!taskId) return;
    // walk the prerequisite chain from the new dependency; reaching this task means a cycle
    let cur: string | null = depId; const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === taskId) throw new DomainError("DEPENDENCY_CYCLE", `"${d.title}" already depends on this task (directly or through other tasks)`);
      seen.add(cur);
      cur = (this.db.prepare("SELECT depends_on_task_id AS d FROM tasks WHERE id=?").get(cur) as { d: string | null } | undefined)?.d ?? null;
    }
  }
  private checkTags(tags?: string[]) {
    if (!tags) return undefined;
    const clean = [...new Set(tags.map((x) => x.trim()).filter(Boolean))];
    if (clean.length > 12 || clean.some((x) => x.length > 40)) throw new DomainError("INVALID_INPUT", "Up to 12 tags of at most 40 characters");
    return clean;
  }
  private requireDocument(id: string): { id: string; title: string } {
    return must(this.db.prepare("SELECT id, title FROM documents WHERE id=?").get(id) as { id: string; title: string } | undefined, "NOT_FOUND", `Document ${id} not found`);
  }

  /** Adds a task to a situation, or a standalone household task when situation_id is omitted. */
  addTask(i: { situation_id?: string | null; title: string; description?: string; kind?: TaskKind; due_at?: string | null; depends_on_task_id?: string | null; priority?: Priority; category?: TaskCategory; tags?: string[]; recurrence?: Recurrence; document_ids?: string[] }, actor: Actor = "agent"): Task {
    if (i.due_at && !isIso(i.due_at)) throw new DomainError("INVALID_INPUT", "due_at must be an ISO-8601 UTC timestamp");
    if (i.recurrence && i.recurrence !== "none" && !i.due_at) throw new DomainError("INVALID_INPUT", "A recurring task needs a due time");
    const tags = this.checkTags(i.tags);
    return this.db.transaction(() => {
      const sid = i.situation_id || null;
      if (sid) {
        const s = this.getSit(sid);
        if (s.status === "resolved") throw new DomainError("INVALID_STATE", "Cannot add tasks to a resolved situation");
      }
      if (i.depends_on_task_id) this.checkDependency(null, sid, i.depends_on_task_id);
      const dup = this.db.prepare(`SELECT id FROM tasks WHERE ${sid ? "situation_id=?" : "situation_id IS NULL"} AND title=? AND status IN ('pending','in_progress','blocked')`).get(...(sid ? [sid] : []), i.title.trim()) as { id: string } | undefined;
      if (dup) throw new DomainError("DUPLICATE", sid ? "An open task with this title already exists in this situation" : "An open household task with this title already exists", { task_id: dup.id });
      const docs = [...new Set(i.document_ids ?? [])].map((d) => this.requireDocument(d));
      const t = this.insertTask(sid, { title: i.title, description: i.description, kind: i.kind, due: i.due_at ?? null, dep: i.depends_on_task_id ?? null, priority: i.priority, category: i.category, tags, recurrence: i.recurrence }, actor);
      for (const d of docs) this.attachDoc(t, d, actor);
      this.touchSituation(sid);
      return this.getTask(t.id);
    })();
  }

  /** Edits an open task. Only the fields sent change; null clears due_at, situation_id or depends_on_task_id. */
  updateTask(taskId: string, p: { title?: string; description?: string; priority?: Priority; category?: TaskCategory; tags?: string[]; due_at?: string | null; situation_id?: string | null; depends_on_task_id?: string | null; recurrence?: Recurrence }, actor: Actor = "agent"): Task {
    if (p.due_at && !isIso(p.due_at)) throw new DomainError("INVALID_INPUT", "due_at must be an ISO-8601 UTC timestamp");
    const tags = this.checkTags(p.tags);
    return this.db.transaction(() => {
      const cur = this.getTask(taskId);
      if (!OPEN_TASK.includes(cur.status)) throw new DomainError("INVALID_STATE", `Task is ${cur.status}; reopen it before editing`);
      const sid = p.situation_id === undefined ? cur.situation_id : p.situation_id;
      if (p.situation_id) { const s = this.getSit(p.situation_id); if (s.status === "resolved") throw new DomainError("INVALID_STATE", "Cannot move a task into a resolved situation"); }
      const dep = p.depends_on_task_id === undefined ? cur.depends_on_task_id : p.depends_on_task_id;
      if (dep && (dep !== cur.depends_on_task_id || sid !== cur.situation_id)) this.checkDependency(cur.id, sid, dep);
      const due = p.due_at === undefined ? cur.due_at : p.due_at;
      const recurrence = p.recurrence ?? cur.recurrence;
      if (recurrence !== "none" && !due) throw new DomainError("INVALID_INPUT", "A recurring task needs a due time");
      const title = p.title?.trim() || cur.title;
      if (title !== cur.title || sid !== cur.situation_id) {
        const dup = this.db.prepare(`SELECT id FROM tasks WHERE id!=? AND ${sid ? "situation_id=?" : "situation_id IS NULL"} AND title=? AND status IN ('pending','in_progress','blocked')`).get(cur.id, ...(sid ? [sid] : []), title);
        if (dup) throw new DomainError("DUPLICATE", "Another open task with this title already exists there");
      }
      const next = { title, description: p.description ?? cur.description, priority: p.priority ?? cur.priority, category: p.category ?? cur.category, tags: tags ?? cur.tags, situation_id: sid, depends_on_task_id: dep, recurrence };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
      if (!changed.length && due === cur.due_at) throw new DomainError("NO_CHANGE", "Nothing to change");
      if (changed.length) {
        this.db.prepare("UPDATE tasks SET title=?, description=?, priority=?, category=?, tags_json=?, situation_id=?, depends_on_task_id=?, recurrence=?, updated_at=? WHERE id=?")
          .run(next.title, next.description, next.priority, next.category, JSON.stringify(next.tags), next.situation_id, next.depends_on_task_id, next.recurrence, this.ts(), cur.id);
        const old = Object.fromEntries(changed.map((k) => [k, cur[k]])); const now = Object.fromEntries(changed.map((k) => [k, next[k]]));
        const what = changed.includes("situation_id") ? (sid ? "moved to a situation" : "made a standalone household task") : changed.includes("depends_on_task_id") ? (dep ? "now depends on another task" : "no longer depends on another task") : "details updated";
        this.log(sid, "task_updated", `Task ${what}: ${next.title}`, actor, { fields: changed, old, new: now }, cur.id);
        if (changed.includes("situation_id") && cur.situation_id) this.log(cur.situation_id, "task_updated", `Task moved out of this situation: ${next.title}`, actor, { fields: ["situation_id"], old: { situation_id: cur.situation_id }, new: { situation_id: sid } }, cur.id);
      }
      if (due !== cur.due_at) {
        if (due) this.doReschedule({ ...cur, situation_id: sid, title }, due, "Edited by the user", actor);
        else { this.db.prepare("UPDATE tasks SET due_at=NULL, updated_at=? WHERE id=?").run(this.ts(), cur.id); this.log(sid, "task_rescheduled", `Due time removed: ${title}`, actor, { old_due_at: cur.due_at, new_due_at: null }, cur.id); }
      }
      this.touchSituation(sid); if (cur.situation_id !== sid) this.touchSituation(cur.situation_id);
      return this.getTask(cur.id);
    })();
  }

  /** Permanently deletes a task. Its history stays in the activity log; tasks that depended on it lose that prerequisite. */
  deleteTask(taskId: string, actor: Actor = "user"): { deleted: { id: string; title: string }; released_dependents: number } {
    return this.db.transaction(() => {
      const cur = this.getTask(taskId);
      const dependents = this.db.prepare("SELECT id, title FROM tasks WHERE depends_on_task_id=?").all(cur.id) as { id: string; title: string }[];
      this.db.prepare("DELETE FROM tasks WHERE id=?").run(cur.id);
      this.log(cur.situation_id, "task_deleted", `Task deleted: ${cur.title}`, actor, { title: cur.title, status: cur.status, released_dependents: dependents.map((d) => d.id) }, cur.id);
      for (const d of dependents) this.log(cur.situation_id, "task_updated", `Prerequisite removed (deleted): ${d.title}`, "system", { fields: ["depends_on_task_id"], old: { depends_on_task_id: cur.id }, new: { depends_on_task_id: null } }, d.id);
      this.touchSituation(cur.situation_id);
      return { deleted: { id: cur.id, title: cur.title }, released_dependents: dependents.length };
    })();
  }

  private attachDoc(t: Task, d: { id: string; title: string }, actor: Actor): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO task_documents (task_id, document_id, created_at) VALUES (?,?,?)").run(t.id, d.id, this.ts());
    if (r.changes) this.log(t.situation_id, "document_linked", `Document attached to task "${t.title}": ${d.title}`, actor, { document_id: d.id, task_title: t.title }, t.id);
    return r.changes > 0;
  }
  linkTaskDocument(taskId: string, documentId: string, actor: Actor = "agent"): { already_linked: boolean } {
    return this.db.transaction(() => ({ already_linked: !this.attachDoc(this.getTask(taskId), this.requireDocument(documentId), actor) }))();
  }
  unlinkTaskDocument(taskId: string, documentId: string, actor: Actor = "agent"): { unlinked: boolean } {
    return this.db.transaction(() => {
      const t = this.getTask(taskId); const d = this.requireDocument(documentId);
      const r = this.db.prepare("DELETE FROM task_documents WHERE task_id=? AND document_id=?").run(t.id, d.id);
      if (!r.changes) throw new DomainError("NOT_LINKED", "That document is not attached to this task");
      this.log(t.situation_id, "document_unlinked", `Document detached from task "${t.title}": ${d.title}`, actor, { document_id: d.id, task_title: t.title }, t.id);
      return { unlinked: true };
    })();
  }

  /** One task with everything it is connected to, read from stored relationships. */
  getTaskDetail(taskId: string): TaskDetail {
    const cur = this.getTask(taskId);
    const [task] = this.withContext([{ ...this.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as object, situation_title: cur.situation_id ? this.getSit(cur.situation_id).title : null }], this.now());
    const situation = cur.situation_id ? (this.db.prepare("SELECT id, title, status, category FROM situations WHERE id=?").get(cur.situation_id) as TaskDetail["situation"]) : null;
    const depends_on = cur.depends_on_task_id ? (this.db.prepare("SELECT id, title, status FROM tasks WHERE id=?").get(cur.depends_on_task_id) as TaskDetail["depends_on"]) ?? null : null;
    const dependents = this.db.prepare("SELECT id, title, status FROM tasks WHERE depends_on_task_id=? ORDER BY created_at").all(cur.id) as TaskDetail["dependents"];
    const documents = this.db.prepare("SELECT d.id, d.title, d.kind, d.category FROM task_documents l JOIN documents d ON d.id=l.document_id WHERE l.task_id=? ORDER BY l.created_at").all(cur.id) as TaskDetail["documents"];
    const activity = (this.db.prepare("SELECT * FROM activity_events WHERE task_id=? ORDER BY seq ASC LIMIT 100").all(cur.id) as any[]).map((r) => this.ev(r));
    const blocked_reason = !OPEN_TASK.includes(cur.status) ? null
      : depends_on && !["completed", "cancelled"].includes(depends_on.status) ? `Waiting for "${depends_on.title}" (${depends_on.status.replace("_", " ")})`
      : cur.status === "blocked" ? "Marked blocked" : null;
    const occ = (sql: string, v: string | null) => (v ? (this.db.prepare(`SELECT id, title, status, due_at FROM tasks WHERE ${sql}=?`).get(v) as TaskDetail["next_occurrence"]) ?? null : null);
    return { task, situation, depends_on, dependents, documents, activity, blocked_reason, previous_occurrence: occ("id", cur.recurrence_of), next_occurrence: occ("recurrence_of", cur.id) };
  }

  private doReschedule(cur: Pick<Task, "id" | "situation_id" | "title" | "due_at">, newDue: string, reason: string | undefined, actor: Actor, meta: Record<string, unknown> = {}): Task {
    this.db.prepare("UPDATE tasks SET due_at=?, updated_at=? WHERE id=?").run(newDue, this.ts(), cur.id);
    this.log(cur.situation_id, "task_rescheduled", `Task rescheduled: ${cur.title} → ${formatClock(newDue, this.tz)}`, actor,
      { ...meta, old_due_at: cur.due_at, new_due_at: newDue, reason: reason ?? null }, cur.id);
    return this.getTask(cur.id);
  }

  rescheduleTask(taskId: string, newDue: string, reason?: string, actor: Actor = "agent"): Task {
    if (!isIso(newDue)) throw new DomainError("INVALID_INPUT", "new_due_at must be an ISO-8601 UTC timestamp");
    return this.db.transaction(() => {
      const cur = this.getTask(taskId);
      if (!OPEN_TASK.includes(cur.status)) throw new DomainError("INVALID_STATE", `Task is ${cur.status} and cannot be rescheduled`);
      if (cur.due_at === newDue) throw new DomainError("NO_CHANGE", "Task is already due at that time");
      const r = this.doReschedule(cur, newDue, reason, actor);
      this.touchSituation(cur.situation_id);
      return r;
    })();
  }

  updateTaskStatus(taskId: string, status: TaskStatus, o: { confirmed_by_user?: boolean; note?: string } = {}, actor: Actor = "agent"): Task {
    return this.db.transaction(() => {
      const cur = this.getTask(taskId);
      if (cur.status === status) return cur;
      if (!TASK_TRANSITIONS[cur.status].includes(status)) throw new DomainError("INVALID_TRANSITION", `Cannot move a task from ${cur.status} to ${status}`);
      if (status === "completed" && !o.confirmed_by_user) throw new DomainError("CONFIRMATION_REQUIRED", "Completing a task requires the user's explicit confirmation");
      if (cur.depends_on_task_id && (status === "completed" || status === "in_progress")) {
        const dep = this.getTask(cur.depends_on_task_id);
        if (!["completed", "cancelled"].includes(dep.status)) throw new DomainError("DEPENDENCY_INCOMPLETE", `Depends on "${dep.title}", which is still ${dep.status}`);
      }
      const t = this.ts();
      this.db.prepare("UPDATE tasks SET status=?, updated_at=?, completed_at=? WHERE id=?").run(status, t, status === "completed" ? t : null, cur.id);
      this.log(cur.situation_id, status === "completed" ? "task_completed" : "task_status_changed",
        `Task ${status === "completed" ? "completed" : `marked ${status}`}: ${cur.title}`, actor,
        { from: cur.status, to: status, note: o.note ?? null, evidence: status === "completed" ? "user_confirmed" : undefined }, cur.id);
      if (status === "completed") this.scheduleNextOccurrence(cur, actor);
      this.touchSituation(cur.situation_id);
      return this.getTask(cur.id);
    })();
  }

  /** Explicitly reopens a completed or cancelled task (back to pending). Not allowed inside a resolved situation. */
  reopenTask(taskId: string, reason?: string, actor: Actor = "agent"): Task {
    return this.db.transaction(() => {
      const cur = this.getTask(taskId);
      if (OPEN_TASK.includes(cur.status)) throw new DomainError("NO_CHANGE", "Task is already open");
      if (cur.situation_id && this.getSit(cur.situation_id).status === "resolved") throw new DomainError("INVALID_STATE", "The situation is resolved; its tasks cannot be reopened");
      const dup = this.db.prepare(`SELECT id FROM tasks WHERE id!=? AND ${cur.situation_id ? "situation_id=?" : "situation_id IS NULL"} AND title=? AND status IN ('pending','in_progress','blocked')`).get(cur.id, ...(cur.situation_id ? [cur.situation_id] : []), cur.title) as { id: string } | undefined;
      if (dup) throw new DomainError("DUPLICATE", "An open task with this title already exists (for a recurring task, its next occurrence)", { task_id: dup.id });
      this.db.prepare("UPDATE tasks SET status='pending', completed_at=NULL, updated_at=? WHERE id=?").run(this.ts(), cur.id);
      this.log(cur.situation_id, "task_reopened", `Task reopened: ${cur.title}`, actor, { from: cur.status, to: "pending", reason: reason ?? null }, cur.id);
      this.touchSituation(cur.situation_id);
      return this.getTask(cur.id);
    })();
  }

  /**
   * Completion-based recurrence: completing a recurring task saves its next occurrence, once (recurrence_of is UNIQUE).
   * The next due time keeps the local clock time and is moved forward until it is in the future. Nothing is "sent".
   */
  private scheduleNextOccurrence(cur: Task, actor: Actor) {
    if (cur.recurrence === "none" || !cur.due_at) return;
    if (this.db.prepare("SELECT 1 FROM tasks WHERE recurrence_of=?").get(cur.id)) return;
    if (cur.situation_id && this.getSit(cur.situation_id).status === "resolved") return;
    const step = cur.recurrence === "weekly" ? { days: 7 } : { months: 1 };
    let due = shiftLocal(cur.due_at, step, this.tz);
    for (let i = 0; i < 520 && new Date(due) <= this.now(); i++) due = shiftLocal(due, step, this.tz);
    const dup = this.db.prepare(`SELECT id FROM tasks WHERE ${cur.situation_id ? "situation_id=?" : "situation_id IS NULL"} AND title=? AND status IN ('pending','in_progress','blocked')`).get(...(cur.situation_id ? [cur.situation_id] : []), cur.title);
    if (dup) return; // an open copy already exists (e.g. added by hand); never create a second
    const next = this.insertTask(cur.situation_id, { title: cur.title, description: cur.description, kind: cur.kind, due, priority: cur.priority, category: cur.category, tags: cur.tags, recurrence: cur.recurrence, recurrenceOf: cur.id }, "system", { recurrence_of: cur.id, recurrence: cur.recurrence });
    for (const d of this.db.prepare("SELECT d.id, d.title FROM task_documents l JOIN documents d ON d.id=l.document_id WHERE l.task_id=?").all(cur.id) as { id: string; title: string }[]) this.attachDoc(next, d, "system");
    this.log(cur.situation_id, "task_recurred", `Next occurrence saved: ${cur.title} (due ${formatClock(due, this.tz)})`, actor, { previous_task_id: cur.id, next_task_id: next.id, due_at: due }, next.id);
  }

  resolveSituation(situationId: string, o: { confirmed_by_user: boolean; close_outstanding?: boolean; note?: string }, actor: Actor = "agent"): { situation: Situation; cancelled_tasks: Task[] } {
    return this.db.transaction(() => {
      const s = this.getSit(situationId);
      if (s.status === "resolved") return { situation: s, cancelled_tasks: [] };
      if (!o.confirmed_by_user) throw new DomainError("CONFIRMATION_REQUIRED", "Resolving a situation requires the user's explicit confirmation");
      const open = this.tasksWhere("situation_id=? AND status IN ('pending','in_progress','blocked')", situationId);
      if (open.length && !o.close_outstanding) throw new DomainError("OUTSTANDING_TASKS", `${open.length} task(s) are still open. Complete or cancel them, or close the situation explicitly.`);
      const cancelled: Task[] = [];
      for (const t of open) {
        this.db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(this.ts(), t.id);
        this.log(situationId, "task_status_changed", `Task cancelled on closure: ${t.title}`, actor, { from: t.status, to: "cancelled" }, t.id);
        cancelled.push(this.getTask(t.id));
      }
      // a plan still awaiting a decision no longer applies once the situation is over
      for (const p of this.db.prepare("SELECT id FROM plan_proposals WHERE situation_id=? AND status='proposed'").all(situationId) as { id: string }[]) {
        this.db.prepare("UPDATE plan_proposals SET status='superseded', updated_at=? WHERE id=?").run(this.ts(), p.id);
        this.log(situationId, "plan_superseded", "The proposed plan was retired because the situation was resolved", "system", { proposal_id: p.id, reason: "situation_resolved" });
      }
      const t = this.ts();
      this.db.prepare("UPDATE situations SET status='resolved', resolved_at=?, updated_at=? WHERE id=?").run(t, t, situationId);
      this.log(situationId, "situation_resolved", `Situation resolved${o.note ? `: ${o.note}` : ""}`, actor, { closed_outstanding: cancelled.length, note: o.note ?? null });
      return { situation: this.getSit(situationId), cancelled_tasks: cancelled };
    })();
  }

  getActivityLog(situationId?: string | null, limit = 100, taskId?: string | null): ActivityEvent[] {
    if (taskId) {
      return (this.db.prepare("SELECT * FROM activity_events WHERE task_id=? ORDER BY seq ASC LIMIT ?").all(taskId, limit) as any[]).map((r) => this.ev(r));
    }
    if (situationId) this.getSit(situationId);
    const rows = situationId
      ? this.db.prepare("SELECT * FROM activity_events WHERE situation_id=? ORDER BY seq ASC LIMIT ?").all(situationId, limit)
      : this.db.prepare("SELECT * FROM (SELECT * FROM activity_events ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC").all(limit);
    return (rows as any[]).map((r) => this.ev(r));
  }

  // ---------- demo ----------
  simulateDeliveryEvent(forceNew = false): { situation: Situation; already_exists: boolean } {
    return this.db.transaction(() => {
      if (!forceNew) {
        const ex = this.db.prepare("SELECT * FROM situations WHERE source='demo' AND category='delivery' AND status!='resolved' ORDER BY created_at DESC LIMIT 1").get();
        if (ex) return { situation: this.sit(ex), already_exists: true };
      }
      const expected = nextLocalTimeIso(this.now(), 17, 0, this.tz);
      const { y, mo, d } = localYmd(expected, this.tz);
      const s = this.createSituation({
        title: "Package arriving while you are at work",
        description: "SIMULATED EVENT: a courier delivery is expected between 5 and 6 PM. Created by the HomeRelay demo.",
        category: "delivery", expected_at: expected, priority: "high", source: "demo",
        constraints: { window_end: zonedToUtcIso(y, mo, d, 18, 0, this.tz) },
      }, "system");
      const up = this.db.prepare("INSERT INTO preferences (scope,key,value,updated_at) VALUES ('demo',?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
      up.run("package_drop_location", "Never leave packages outside the door", this.ts());
      up.run("household_members", "Demo household: no one else confirmed available", this.ts());
      return { situation: s, already_exists: false };
    })();
  }

  /** Removes ONLY demo-sourced situations (cascades to their tasks/proposals/events) and demo-scoped preferences. */
  resetDemoData(): { situations_removed: number } {
    return this.db.transaction(() => {
      const n = this.db.prepare("DELETE FROM situations WHERE source='demo'").run().changes;
      this.db.prepare("DELETE FROM preferences WHERE scope='demo'").run();
      this.log(null, "demo_reset", `Demo data reset (${n} situation(s) removed)`, "system", { situations_removed: n });
      return { situations_removed: n };
    })();
  }
}
