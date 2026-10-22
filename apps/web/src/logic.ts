import type { ChatResponse, DashboardResponse, Proposal, SituationDetail, SituationSummary, TraceEntry } from "@homerelay/shared";
import type { ChatMsg, Route } from "./types";

/**
 * Pure UI state logic (no React, no DOM) so the rules that keep the screen consistent with persisted state are unit tested.
 */

/** Conversations belong to ONE situation (or to the household "home" view). They are never shown against another. */
export const HOME = "home";
export type Threads = Record<string, ChatMsg[]>;
const KEY = "homerelay.threads.v2";
const LEGACY_KEY = "homerelay.chat.v1"; // the old single global conversation: it caused cross-situation leakage
const MAX_PER_THREAD = 40;

export const threadKeyFor = (r: Route): string =>
  r.view === "situation" ? r.id : r.view === "assistant" && r.id ? r.id : r.view === "document" ? `doc:${r.id}` : r.view === "task" ? `task:${r.id}` : HOME;
/** The situation id sent to the agent: the open situation only, never a remembered one. */
export const activeSituationFor = (r: Route): string | null => (r.view === "situation" ? r.id : r.view === "assistant" && r.id ? r.id : null);
/** The document id sent to the agent when a document is open. */
export const activeDocumentFor = (r: Route): string | null => (r.view === "document" ? r.id : null);
/** The task id sent to the agent when a task is open. */
export const activeTaskFor = (r: Route): string | null => (r.view === "task" ? r.id : null);

/** Hash routes. Unknown paths fall back to Home; ids are URI-decoded and never interpreted further. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [head, ...rest] = h.split("/");
  const id = rest.length ? decodeSafe(rest.join("/")) : "";
  switch (head) {
    case "situations": return { view: "situations" };
    case "situation": return id ? { view: "situation", id } : { view: "situations" };
    case "documents": return { view: "documents" };
    case "document": return id ? { view: "document", id } : { view: "documents" };
    case "tasks": return { view: "tasks" };
    case "task": return id ? { view: "task", id } : { view: "tasks" };
    case "map": return { view: "map" };
    case "activity": return { view: "activity" };
    case "assistant": return id ? { view: "assistant", id } : { view: "assistant" };
    default: return { view: "dashboard" };
  }
}
function decodeSafe(v: string): string { try { return decodeURIComponent(v); } catch { return ""; } }
export function routeHash(r: Route): string {
  switch (r.view) {
    case "situation": return `#/situation/${encodeURIComponent(r.id)}`;
    case "document": return `#/document/${encodeURIComponent(r.id)}`;
    case "task": return `#/task/${encodeURIComponent(r.id)}`;
    case "assistant": return r.id ? `#/assistant/${encodeURIComponent(r.id)}` : "#/assistant";
    case "dashboard": return "#/";
    default: return `#/${r.view}`;
  }
}

const STEP_LABEL: Record<string, string> = {
  get_situation: "Checked the situation", list_open_situations: "Looked at open situations", list_tasks: "Read the tasks",
  get_workload_summary: "Checked what needs attention", set_constraints: "Saved your availability", update_situation: "Saved the new time",
  create_situation: "Created the situation", simulate_delivery_event: "Opened the simulated delivery", propose_plan: "Prepared a proposal",
  approve_plan: "Applied the approved plan", reject_plan: "Recorded the rejection", add_task: "Added a task", reschedule_task: "Rescheduled a task",
  update_task_status: "Updated a task", resolve_situation: "Resolved the situation", get_activity_log: "Read the history",
  search_documents: "Searched documents", list_documents: "Listed documents", get_document: "Opened the document", get_document_text: "Read the extracted text",
  link_document_to_situation: "Attached the document", unlink_document_from_situation: "Detached the document",
  update_document_metadata: "Updated document details", search_household: "Searched your records", get_connections: "Looked up what is connected", get_task: "Opened the task",
  update_task: "Edited a task", reopen_task: "Reopened a task", link_document_to_task: "Attached the document to a task", unlink_document_from_task: "Detached the document from a task",
};
/** What the agent actually did, in order, from the recorded MCP calls. Nothing is shown that did not happen. */
export function operationSteps(trace: TraceEntry[] | undefined): { id: string; label: string; ok: boolean; detail: string }[] {
  return (trace ?? []).map((t) => ({ id: t.id, label: STEP_LABEL[t.tool] ?? t.tool, ok: t.ok, detail: t.result_summary }));
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const safe = (): StorageLike | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function loadThreads(storage: StorageLike | null = safe()): Threads {
  if (!storage) return {};
  try {
    storage.removeItem(LEGACY_KEY);
    const v = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Threads = {};
    for (const [k, msgs] of Object.entries(v)) if (Array.isArray(msgs)) out[k] = (msgs as ChatMsg[]).slice(-MAX_PER_THREAD);
    return out;
  } catch { return {}; }
}

export function saveThreads(t: Threads, storage: StorageLike | null = safe()): void {
  if (!storage) return;
  try {
    const trimmed: Threads = {};
    for (const [k, v] of Object.entries(t)) if (v.length) trimmed[k] = v.slice(-MAX_PER_THREAD);
    storage.setItem(KEY, JSON.stringify(trimmed));
  } catch { /* storage unavailable or full: the conversation just will not survive a reload */ }
}

export function appendMessages(t: Threads, key: string, ...msgs: ChatMsg[]): Threads {
  return { ...t, [key]: [...(t[key] ?? []), ...msgs].slice(-MAX_PER_THREAD) };
}

/** Moves the given messages from one thread to another (used when a chat from home creates a situation). */
export function rehome(t: Threads, from: string, to: string, ids: string[]): Threads {
  if (from === to) return t;
  const moving = (t[from] ?? []).filter((m) => ids.includes(m.id));
  if (!moving.length) return t;
  return { ...t, [from]: (t[from] ?? []).filter((m) => !ids.includes(m.id)), [to]: [...(t[to] ?? []), ...moving].slice(-MAX_PER_THREAD) };
}

/** Keeps only threads for situations that still exist (plus home). */
export function pruneThreads(t: Threads, existingIds: Iterable<string>): Threads {
  const keep = new Set([HOME, ...existingIds]);
  return Object.fromEntries(Object.entries(t).filter(([k]) => keep.has(k)));
}

/** Refreshes a stored proposal snapshot wherever it appears, after an approve/reject. */
export function syncProposal(t: Threads, p: Proposal): Threads {
  return Object.fromEntries(Object.entries(t).map(([k, ms]) => [k, ms.map((m) => (m.proposal?.id === p.id ? { ...m, proposal: p } : m))]));
}

/** True when a chat made from the home view created a new situation, so its messages belong in that situation's thread. */
export function createdSituation(res: Pick<ChatResponse, "trace" | "situationId">): string | null {
  const created = res.trace.some((t) => t.ok && (t.tool === "create_situation" || (t.tool === "simulate_delivery_event" && !/existing/.test(t.result_summary))));
  return created ? res.situationId : null;
}

/** The situation that most deserves the user's attention right now. Derived only from persisted fields. */
export function pickFeatured(data: DashboardResponse | null): SituationSummary | null {
  if (!data) return null;
  const open = data.situations.filter((s) => s.status !== "resolved");
  if (!open.length) return null;
  const overdue = new Set(data.summary.overdue.map((t) => t.situation_id));
  const score = (s: SituationSummary) =>
    (s.pending_proposal_id ? 40 : 0) + (overdue.has(s.id) ? 30 : 0) + (s.can_resolve ? 20 : 0) + (s.priority === "high" ? 5 : 0);
  return [...open].sort((a, b) => score(b) - score(a) || (a.next_due_at ?? a.expected_at ?? "9").localeCompare(b.next_due_at ?? b.expected_at ?? "9"))[0];
}

/** A few relevant prompts for the current state. Nothing is suggested that the state cannot support. */
export function suggestionsFor(detail: SituationDetail | null, ctx: { documentOpen?: boolean; taskOpen?: boolean } = {}): string[] {
  if (ctx.documentOpen) return ["What does this document say?", "Show me everything connected to this"];
  if (ctx.taskOpen) return ["Show me everything connected to this", "Which tasks are blocked?", "What happened recently?"];
  if (!detail) return ["What is on my plate today?", "Which tasks are blocked?", "Find my receipts"];
  const { situation: s, tasks, proposals, workflow } = detail;
  if (s.status === "resolved") return ["What is still pending?"];
  if (proposals.some((p) => p.status === "proposed")) return ["What is still pending?"];
  const open = tasks.some((t) => ["pending", "in_progress", "blocked"].includes(t.status));
  if (s.category === "delivery") {
    if (!s.constraints.available_from) return ["I'm working until 6 PM and nobody else is home. Help me manage it."];
    return open ? ["My meeting has been extended until 7 PM", "I collected the package", "Which documents are attached to this situation?"] : ["Help me plan this", "What is still pending?"];
  }
  if (s.category === "maintenance") {
    return open ? ["Find the warranty", "Which documents are attached to this situation?", "The repair is done"] : ["Help me plan this", "Find the warranty"];
  }
  if (s.category === "family_visit") return open ? ["What is still pending?", "What needs attention today?"] : ["Help me prepare"];
  return workflow.can_resolve ? ["What is still pending?"] : ["Help me plan this", "What is still pending?"];
}

export function greetingFor(date: Date): string {
  const h = date.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Sequence guard: only the latest request for a key may apply its result. */
export function makeSequencer() {
  const latest = new Map<string, number>();
  return {
    next(key: string): number { const n = (latest.get(key) ?? 0) + 1; latest.set(key, n); return n; },
    isLatest(key: string, n: number): boolean { return latest.get(key) === n; },
  };
}
