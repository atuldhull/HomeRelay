import type { ActivityEvent, Connections, DocumentCategory, EntityRef, EntityType, GraphEdge, GraphNode, HouseholdGraph, RelationType, SearchResult } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL, TASK_CATEGORY_LABEL, formatLocal, type TaskCategory } from "@homerelay/shared";
import type { Db } from "./db";
import { DomainError, type HomeRelayService } from "./domain";
import type { DocumentService } from "./documents";

/**
 * The household knowledge map. Nothing here is stored separately: nodes and edges are read from the same tables the
 * rest of HomeRelay uses (tasks.situation_id, tasks.depends_on_task_id, document_links, task_documents), so the map
 * cannot drift from the records and is current after every change.
 */

const ROUTE: Record<EntityType, string> = { situation: "#/situation/", task: "#/task/", document: "#/document/" };
const SITUATION_LABEL: Record<string, string> = { delivery: "Delivery", maintenance: "Maintenance", family_visit: "Family visit", general: "General" };
const OPEN_TASK = new Set(["pending", "in_progress", "blocked"]);
export const keyOf = (type: EntityType, id: string) => `${type}:${id}`;

interface SitRow { id: string; title: string; status: string; category: string; expected_at: string | null; source: string }
interface TaskRow { id: string; title: string; status: string; category: string; due_at: string | null; situation_id: string | null; depends_on_task_id: string | null; situation_title?: string | null }
interface DocRow { id: string; title: string; category: string; kind: string; extraction_status: string }

export class GraphService {
  constructor(private db: Db, private svc: HomeRelayService, private docs: DocumentService) {}

  private sitRef(s: SitRow): EntityRef {
    const when = s.expected_at ? ` · ${formatLocal(s.expected_at, this.svc.tz)}` : "";
    return { key: keyOf("situation", s.id), type: "situation", id: s.id, title: s.title, status: s.status, subtitle: `${SITUATION_LABEL[s.category] ?? s.category}${s.source === "demo" ? " (simulated)" : ""}${when}`, route: ROUTE.situation + s.id };
  }
  private taskRef(t: TaskRow): EntityRef {
    const due = t.due_at ? ` · due ${formatLocal(t.due_at, this.svc.tz)}` : "";
    const where = t.situation_title ? ` · ${t.situation_title}` : t.situation_id ? "" : " · household task";
    return { key: keyOf("task", t.id), type: "task", id: t.id, title: t.title, status: t.status, subtitle: `Task${due}${where}`, route: ROUTE.task + t.id };
  }
  private docRef(d: DocRow): EntityRef {
    return { key: keyOf("document", d.id), type: "document", id: d.id, title: d.title, status: d.extraction_status, subtitle: `${DOCUMENT_CATEGORY_LABEL[d.category as DocumentCategory] ?? d.category} · ${d.kind.toUpperCase()}`, route: ROUTE.document + d.id };
  }

  private sits(where: string, ...args: unknown[]): SitRow[] {
    return this.db.prepare(`SELECT id, title, status, category, expected_at, source FROM situations WHERE ${where}`).all(...args) as SitRow[];
  }
  private tasks(where: string, ...args: unknown[]): TaskRow[] {
    return this.db.prepare(`SELECT t.id, t.title, t.status, t.category, t.due_at, t.situation_id, t.depends_on_task_id, s.title AS situation_title
      FROM tasks t LEFT JOIN situations s ON s.id=t.situation_id WHERE ${where}`).all(...args) as TaskRow[];
  }
  private documents(where: string, ...args: unknown[]): DocRow[] {
    return this.db.prepare(`SELECT id, title, category, kind, extraction_status FROM documents WHERE ${where}`).all(...args) as DocRow[];
  }

  /** The map. Open situations and open tasks by default; resolved situations and finished tasks on request. */
  graph(o: { include_resolved?: boolean; include_done?: boolean; types?: EntityType[]; limit?: number } = {}): HouseholdGraph {
    const types = new Set<EntityType>(o.types?.length ? o.types : ["situation", "task", "document"]);
    const limit = Math.min(Math.max(o.limit ?? 300, 10), 1000);
    const sits = types.has("situation") ? this.sits(`${o.include_resolved ? "1=1" : "status != 'resolved'"} ORDER BY created_at DESC LIMIT ?`, limit) : [];
    const tasks = types.has("task") ? this.tasks(`t.status ${o.include_done ? "!= 'cancelled'" : "IN ('pending','in_progress','blocked')"} ORDER BY t.due_at IS NULL, t.due_at, t.created_at LIMIT ?`, limit) : [];
    const docs = types.has("document") ? this.documents("1=1 ORDER BY created_at DESC LIMIT ?", limit) : [];

    const nodes = new Map<string, GraphNode>();
    const add = (ref: EntityRef, category: string) => nodes.set(ref.key, { ...ref, category, degree: 0 });
    for (const s of sits) add(this.sitRef(s), s.category);
    for (const t of tasks) add(this.taskRef(t), t.category);
    for (const d of docs) add(this.docRef(d), d.category);

    const edges: GraphEdge[] = [];
    const edge = (id: string, source: string, target: string, relation: RelationType) => {
      const a = nodes.get(source); const b = nodes.get(target);
      if (!a || !b) return; // both ends must be on the map; never an edge to a missing record
      a.degree++; b.degree++;
      edges.push({ id, source, target, relation });
    };
    for (const t of tasks) {
      if (t.situation_id) edge(`part_of:${t.id}`, keyOf("task", t.id), keyOf("situation", t.situation_id), "part_of");
      if (t.depends_on_task_id) edge(`depends_on:${t.id}`, keyOf("task", t.id), keyOf("task", t.depends_on_task_id), "depends_on");
    }
    for (const l of this.db.prepare("SELECT document_id, situation_id FROM document_links").all() as { document_id: string; situation_id: string }[]) {
      edge(`attached_to:${l.document_id}:${l.situation_id}`, keyOf("document", l.document_id), keyOf("situation", l.situation_id), "attached_to");
    }
    for (const l of this.db.prepare("SELECT document_id, task_id FROM task_documents").all() as { document_id: string; task_id: string }[]) {
      edge(`attached_to:${l.document_id}:${l.task_id}`, keyOf("document", l.document_id), keyOf("task", l.task_id), "attached_to");
    }
    let list = [...nodes.values()];
    const truncated = list.length > limit;
    if (truncated) {
      // keep the most connected records; drop edges whose ends were cut
      list = list.sort((a, b) => b.degree - a.degree).slice(0, limit);
      const keep = new Set(list.map((n) => n.key));
      return { nodes: list, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)), truncated, generated_at: new Date().toISOString() };
    }
    return { nodes: list, edges, truncated, generated_at: new Date().toISOString() };
  }

  /** Everything stored as connected to one record, with how it is connected, plus gaps derived from the same data. */
  connections(type: EntityType, id: string): Connections {
    const related: Connections["related"] = [];
    const seen = new Set<string>();
    const push = (ref: EntityRef, relation: string, via: string | null = null) => {
      if (seen.has(ref.key)) return;
      seen.add(ref.key); related.push({ ...ref, relation, via });
    };
    const gaps: string[] = [];
    let center: EntityRef; let activity: ActivityEvent[];

    if (type === "situation") {
      const s = this.sits("id=?", id)[0];
      if (!s) throw new DomainError("NOT_FOUND", `Situation ${id} not found`);
      center = this.sitRef(s); seen.add(center.key);
      const tasks = this.tasks("t.situation_id=? AND t.status != 'cancelled' ORDER BY t.due_at IS NULL, t.due_at", id);
      for (const t of tasks) push(this.taskRef(t), "task in this situation");
      for (const d of this.documents("id IN (SELECT document_id FROM document_links WHERE situation_id=?) ORDER BY title", id)) push(this.docRef(d), "attached to this situation");
      for (const t of tasks) {
        for (const d of this.documents("id IN (SELECT document_id FROM task_documents WHERE task_id=?)", t.id)) push(this.docRef(d), "attached to a task", t.title);
        if (t.depends_on_task_id && !tasks.some((x) => x.id === t.depends_on_task_id)) {
          const dep = this.tasks("t.id=?", t.depends_on_task_id)[0];
          if (dep) push(this.taskRef(dep), "prerequisite of a task", t.title);
        }
      }
      const open = tasks.filter((t) => OPEN_TASK.has(t.status));
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const t of open) {
        const dep = t.depends_on_task_id ? byId.get(t.depends_on_task_id) ?? this.tasks("t.id=?", t.depends_on_task_id)[0] : undefined;
        if (dep && OPEN_TASK.has(dep.status)) gaps.push(`"${t.title}" is waiting for "${dep.title}"`);
        else if (t.status === "blocked") gaps.push(`"${t.title}" is marked blocked`);
      }
      if (!related.some((r) => r.type === "document")) gaps.push("No documents are attached");
      if (s.status !== "resolved" && !tasks.length) gaps.push("No tasks yet");
      const detail = this.svc.getSituation(id);
      if (detail.proposals.some((p) => p.status === "proposed")) gaps.push("A plan is waiting for your approval");
      if (s.status !== "resolved" && /\?$/.test(detail.workflow.next_action)) gaps.push(`Missing information: ${detail.workflow.next_action}`);
      activity = this.svc.getActivityLog(id, 200).slice(-8);
    } else if (type === "task") {
      const t = this.tasks("t.id=?", id)[0];
      if (!t) throw new DomainError("NOT_FOUND", `Task ${id} not found`);
      center = this.taskRef(t); seen.add(center.key);
      if (t.situation_id) { const s = this.sits("id=?", t.situation_id)[0]; if (s) push(this.sitRef(s), "situation this task belongs to"); }
      const dep = t.depends_on_task_id ? this.tasks("t.id=?", t.depends_on_task_id)[0] : undefined;
      if (dep) push(this.taskRef(dep), "must be done first");
      for (const x of this.tasks("t.depends_on_task_id=?", id)) push(this.taskRef(x), "waits for this task");
      for (const d of this.documents("id IN (SELECT document_id FROM task_documents WHERE task_id=?) ORDER BY title", id)) push(this.docRef(d), "attached to this task");
      if (t.situation_id) for (const d of this.documents("id IN (SELECT document_id FROM document_links WHERE situation_id=?) ORDER BY title", t.situation_id)) push(this.docRef(d), "attached to its situation", t.situation_title ?? null);
      if (OPEN_TASK.has(t.status) && dep && OPEN_TASK.has(dep.status)) gaps.push(`Cannot be completed until "${dep.title}" is done`);
      if (OPEN_TASK.has(t.status) && !t.due_at) gaps.push("No due time");
      activity = this.svc.getActivityLog(null, 50, id).slice(-8);
    } else {
      const d = this.documents("id=?", id)[0];
      if (!d) throw new DomainError("NOT_FOUND", `Document ${id} not found`);
      center = this.docRef(d); seen.add(center.key);
      for (const s of this.sits("id IN (SELECT situation_id FROM document_links WHERE document_id=?) ORDER BY title", id)) push(this.sitRef(s), "attached to this situation");
      for (const t of this.tasks("t.id IN (SELECT task_id FROM task_documents WHERE document_id=?) ORDER BY t.title", id)) push(this.taskRef(t), "attached to this task");
      if (!related.length) gaps.push("Not attached to any situation or task");
      if (d.extraction_status === "unsupported") gaps.push("No searchable text (images are not OCR'd)");
      if (d.extraction_status === "failed") gaps.push("The file's text could not be read");
      activity = (this.db.prepare("SELECT * FROM activity_events WHERE metadata_json LIKE ? ORDER BY seq DESC LIMIT 8").all(`%"document_id":"${id}"%`) as any[])
        .reverse().map(({ metadata_json, seq: _s, ...r }) => ({ ...r, metadata: JSON.parse(metadata_json) }) as ActivityEvent);
    }
    return { center, related, gaps, recent_activity: activity };
  }

  /** One search across situations, tasks and documents. Every result is a stored record with the route that opens it. */
  search(q: string, o: { types?: EntityType[]; limit?: number } = {}): SearchResult[] {
    const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6);
    if (!words.length) return [];
    const types = new Set<EntityType>(o.types?.length ? o.types : ["situation", "task", "document"]);
    const per = Math.min(Math.max(o.limit ?? 8, 1), 25);
    const likes = (cols: string[]) => {
      const where = words.map(() => `(${cols.map((c) => `lower(${c}) LIKE ?`).join(" OR ")})`).join(" AND ");
      return { where, args: words.flatMap((w) => cols.map(() => `%${w}%`)) };
    };
    const score = (title: string) => words.filter((w) => title.toLowerCase().includes(w)).length;
    const out: SearchResult[] = [];
    if (types.has("situation")) {
      const l = likes(["title", "description"]);
      const rows = this.sits(`${l.where} ORDER BY status='resolved', created_at DESC LIMIT ?`, ...l.args, per);
      out.push(...rows.sort((a, b) => score(b.title) - score(a.title)).map((s) => ({ ...this.sitRef(s), snippet: null })));
    }
    if (types.has("task")) {
      const l = likes(["t.title", "t.description", "t.tags_json"]);
      const rows = this.tasks(`${l.where} AND t.status != 'cancelled' ORDER BY t.status IN ('completed'), t.due_at IS NULL, t.due_at LIMIT ?`, ...l.args, per);
      out.push(...rows.sort((a, b) => score(b.title) - score(a.title)).map((t) => ({ ...this.taskRef(t), subtitle: `${this.taskRef(t).subtitle} · ${TASK_CATEGORY_LABEL[t.category as TaskCategory] ?? t.category}`, snippet: null })));
    }
    if (types.has("document")) {
      for (const h of this.docs.search(q, { limit: per })) {
        out.push({ ...this.docRef({ id: h.document.id, title: h.document.title, category: h.document.category, kind: h.document.kind, extraction_status: h.document.extraction_status }), snippet: h.snippet, ...(h.page ? { subtitle: `${this.docRef(h.document as unknown as DocRow).subtitle} · page ${h.page}` } : {}) });
      }
    }
    return out;
  }

  /** Self-check used by tests and the soak run: every relationship must point at an existing record of the right type. */
  integrity(): { problems: string[] } {
    const problems: string[] = [];
    const q = (sql: string, what: string) => { const n = (this.db.prepare(sql).get() as { n: number }).n; if (n) problems.push(`${n} ${what}`); };
    q("SELECT COUNT(*) AS n FROM tasks t WHERE t.situation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM situations s WHERE s.id=t.situation_id)", "task(s) pointing at a missing situation");
    q("SELECT COUNT(*) AS n FROM tasks t WHERE t.depends_on_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.id=t.depends_on_task_id)", "task(s) depending on a missing task");
    q("SELECT COUNT(*) AS n FROM document_links l WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=l.document_id) OR NOT EXISTS (SELECT 1 FROM situations s WHERE s.id=l.situation_id)", "dangling situation-document link(s)");
    q("SELECT COUNT(*) AS n FROM task_documents l WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=l.document_id) OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=l.task_id)", "dangling task-document link(s)");
    q("SELECT COUNT(*) AS n FROM documents_fts f WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=f.document_id)", "search row(s) for a deleted document");
    // dependency cycles: follow each chain at most N steps
    const deps = new Map((this.db.prepare("SELECT id, depends_on_task_id AS d FROM tasks WHERE depends_on_task_id IS NOT NULL").all() as { id: string; d: string }[]).map((r) => [r.id, r.d]));
    for (const start of deps.keys()) {
      let cur: string | undefined = deps.get(start); let steps = 0;
      while (cur && steps++ <= deps.size) { if (cur === start) { problems.push(`dependency cycle through task ${start}`); break; } cur = deps.get(cur); }
    }
    return { problems };
  }
}

