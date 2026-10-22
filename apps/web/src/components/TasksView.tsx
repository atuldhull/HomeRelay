import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Circle, CircleCheck, CircleDot, CircleX, Clock, Lock, Paperclip, Plus, Repeat, Search } from "lucide-react";
import type { DocumentHit, SituationSummary, TaskCategory, TaskWithContext, WorkloadSummary } from "@homerelay/shared";
import { PRIORITIES, TASK_CATEGORIES, TASK_CATEGORY_LABEL } from "@homerelay/shared";
import { ApiError, api, type TaskFilter } from "../api";
import { makeSequencer } from "../logic";
import { StatusBadge, useLocal } from "../ui";

type View = TaskFilter | "approval";
const VIEWS: { key: View; label: string }[] = [
  { key: "open", label: "All open" }, { key: "today", label: "Today" }, { key: "overdue", label: "Overdue" }, { key: "upcoming", label: "Upcoming" },
  { key: "blocked", label: "Blocked" }, { key: "standalone", label: "Household" }, { key: "approval", label: "Awaiting approval" }, { key: "done", label: "Done" },
];
const ICON = { pending: Circle, in_progress: CircleDot, blocked: Lock, completed: CircleCheck, cancelled: CircleX } as const;

interface RowProps { t: TaskWithContext; settled: boolean; working: boolean; onOpen: (id: string) => void; onOpenSituation: (id: string) => void; onComplete: (t: TaskWithContext) => void }

/** One task. "Done" is shown only after the server accepted it (settled), never on click. */
export function TaskRow({ t, settled, working, onOpen, onOpenSituation, onComplete }: RowProps) {
  const local = useLocal();
  const [confirming, setConfirming] = useState(false);
  const status = settled ? "completed" : t.status;
  const open = ["pending", "in_progress", "blocked"].includes(status);
  const Icon = ICON[status];
  return (
    <li className={`task ${status} ${t.waiting_on ? "is-waiting" : ""} ${settled ? "just-done" : ""} prio-${t.priority}`}>
      <span className="task-state" aria-hidden><Icon size={20} /></span>
      <div className="task-main">
        <button className="task-title link-title" onClick={() => onOpen(t.id)} aria-label={`Open task: ${t.title}`}>{t.title}</button>
        <span className="task-meta">
          <StatusBadge status={status} />
          {t.priority === "high" && <span className="tag late">High</span>}
          {t.due_at && <span className="due"><Clock size={12} aria-hidden /> {local(t.due_at)}</span>}
          {t.overdue && !settled && <span className="tag late">Overdue</span>}
          {t.waiting_on && !settled && <span className="dep wait"><Lock size={11} aria-hidden /> Waiting for: {t.waiting_on}</span>}
          {t.recurrence !== "none" && <span className="chip-meta" title={`Repeats ${t.recurrence}`}><Repeat size={11} aria-hidden /> {t.recurrence}</span>}
          {t.document_count > 0 && <span className="chip-meta" title="Attached documents"><Paperclip size={11} aria-hidden /> {t.document_count}</span>}
          <span className="chip-meta">{TASK_CATEGORY_LABEL[t.category]}</span>
          {t.situation_id
            ? <button className="link" onClick={() => onOpenSituation(t.situation_id!)}>{t.situation_title}</button>
            : <span className="muted">Household task</span>}
        </span>
      </div>
      {open && !confirming && (
        <div className="task-actions">
          <button className="btn small" disabled={working || !!t.waiting_on} title={t.waiting_on ? `Waiting for: ${t.waiting_on}` : undefined} onClick={() => setConfirming(true)}>
            {working ? <span className="spinner" aria-hidden /> : <Check size={14} aria-hidden />} Mark done
          </button>
        </div>
      )}
      {open && confirming && (
        <div className="task-actions confirm" role="group" aria-label="Confirm completion">
          <span>Did you actually do this?</span>
          <button className="btn small primary" disabled={working} onClick={() => { setConfirming(false); onComplete(t); }}>Yes, it is done</button>
          <button className="btn small" onClick={() => setConfirming(false)}>Not yet</button>
        </div>
      )}
    </li>
  );
}

interface Props {
  version: number;
  summary: WorkloadSummary | null;
  situations: SituationSummary[];
  onOpen: (taskId: string) => void;
  onOpenSituation: (id: string) => void;
  onNew: () => void;
  /** Called after a change the server accepted, so every workspace re-reads stored state. */
  onChanged: () => void;
  notify: (kind: "success" | "error", text: string) => void;
}

/** Every household task in one place: situation tasks and standalone ones. Filters run on the server against stored state. */
export function TasksView({ version, summary, situations, onOpen, onOpenSituation, onNew, onChanged, notify }: Props) {
  const [view, setView] = useState<View>("open");
  const [q, setQ] = useState(""); const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<TaskCategory | "">(""); const [priority, setPriority] = useState<"" | (typeof PRIORITIES)[number]>("");
  const [situationId, setSituationId] = useState(""); const [documentId, setDocumentId] = useState("");
  const [docs, setDocs] = useState<DocumentHit[]>([]);
  const [tasks, setTasks] = useState<TaskWithContext[] | null>(null); const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null); const [settled, setSettled] = useState<Set<string>>(new Set());
  const seq = useRef(makeSequencer());

  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(h); }, [q]);
  useEffect(() => { api.documents({ limit: 100, sort: "name" }).then((r) => setDocs(r.results)).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    if (view === "approval") { setTasks([]); return; }
    const n = seq.current.next("tasks");
    try {
      const r = await api.tasks({ filter: view, q: debounced, category, priority, situationId, documentId });
      if (seq.current.isLatest("tasks", n)) { setTasks(r.tasks); setError(null); setSettled(new Set()); }
    } catch (e) { if (seq.current.isLatest("tasks", n)) { setTasks([]); setError(e instanceof ApiError ? e.message : "Could not load tasks."); } }
  }, [view, debounced, category, priority, situationId, documentId]);
  useEffect(() => { void load(); }, [load, version]);

  const complete = async (t: TaskWithContext) => {
    setWorking(t.id);
    try {
      await api.setTaskStatus(t.id, "completed", true);
      setSettled((s) => new Set(s).add(t.id)); // shown as done only now that the server accepted it
      notify("success", t.recurrence !== "none" ? "Marked done. The next occurrence was saved." : "Marked done, based on your confirmation.");
      setTimeout(onChanged, 900);
    } catch (e) {
      notify("error", e instanceof ApiError ? e.message : "Could not update the task. Nothing changed.");
    } finally { setWorking(null); }
  };

  const counts: Partial<Record<View, number>> = summary ? {
    open: summary.open_tasks, today: summary.due_today.length, overdue: summary.overdue.length, blocked: summary.blocked.length,
    standalone: summary.standalone_open, approval: summary.waiting_approval.length,
  } : {};
  const filtered = !!(debounced || category || priority || situationId || documentId);
  const clear = () => { setQ(""); setCategory(""); setPriority(""); setSituationId(""); setDocumentId(""); };

  return (
    <div className="page ws">
      <header className="ws-head">
        <div><p className="eyebrow">Workspace</p><h1>Tasks</h1>
          <p className="lede">Household tasks and the tasks of each situation. Overdue means past its due time; HomeRelay only knows something happened when you tell it.</p></div>
        <div className="head-actions"><button className="btn primary" onClick={onNew}><Plus size={16} aria-hidden /> New task</button></div>
      </header>

      <div className="tabs" role="tablist" aria-label="Task view">
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? "on" : ""} onClick={() => setView(v.key)}>
            {v.label}{counts[v.key] !== undefined && <span key={counts[v.key]} className={`tab-count bump ${counts[v.key] ? "" : "zero"}`}>{counts[v.key]}</span>}
          </button>
        ))}
      </div>

      {view !== "approval" && (
        <form className="filters bar" role="search" aria-label="Filter tasks" onSubmit={(e) => e.preventDefault()}>
          <label className="search wide"><Search size={16} aria-hidden /><span className="sr-only">Search tasks</span>
            <input type="search" placeholder="Search titles, notes, tags and situations" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <label><span className="sr-only">Category</span><select value={category} onChange={(e) => setCategory(e.target.value as TaskCategory | "")} aria-label="Category">
            <option value="">Any category</option>{TASK_CATEGORIES.map((c) => <option key={c} value={c}>{TASK_CATEGORY_LABEL[c]}</option>)}</select></label>
          <label><span className="sr-only">Priority</span><select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} aria-label="Priority">
            <option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></label>
          <label><span className="sr-only">Situation</span><select value={situationId} onChange={(e) => setSituationId(e.target.value)} aria-label="Situation">
            <option value="">Any situation</option>{situations.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <label><span className="sr-only">Attached document</span><select value={documentId} onChange={(e) => setDocumentId(e.target.value)} aria-label="Attached document">
            <option value="">Any document</option>{docs.map((d) => <option key={d.document.id} value={d.document.id}>{d.document.title}</option>)}</select></label>
          {filtered && <button type="button" className="btn small ghost" onClick={clear}>Clear</button>}
        </form>
      )}

      {view === "approval" ? (
        <section className="panel" aria-label="Plans awaiting approval">
          <p className="fine">These tasks are only proposed. Nothing is created until you approve the plan on its situation.</p>
          {!summary?.waiting_approval.length ? <p className="empty-line">No plans are waiting for your approval.</p> : (
            <ul className="att-list">{summary.waiting_approval.map((a) => (
              <li key={a.proposal_id}><button className="att" onClick={() => onOpenSituation(a.situation_id)}>
                <span className="tag info">Proposed</span><span className="att-main"><strong>{a.situation_title}</strong><span className="muted"> · {a.summary}</span></span>
                <span className="att-when">Review <ArrowRight size={14} aria-hidden /></span></button></li>
            ))}</ul>
          )}
        </section>
      ) : (
        <>
          <p className="result-count" role="status" aria-live="polite">{tasks === null ? "Loading tasks…" : error ? "" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}${filtered ? " match" : ""}`}</p>
          {error && <p className="banner error" role="alert">{error} <button className="link" onClick={() => void load()}>Retry</button></p>}
          {tasks && tasks.length === 0 && !error && (
            <div className="empty-line">
              {filtered ? "No tasks match these filters." : view === "open" ? <>No open tasks. <button className="link" onClick={onNew}>Add a household task</button>, or approve a plan on a situation.</> : "No tasks in this view."}
            </div>
          )}
          {tasks && tasks.length > 0 && (
            <section className="panel" aria-label="Task list">
              <ul className="tasks">{tasks.map((t) => <TaskRow key={t.id} t={t} settled={settled.has(t.id)} working={working === t.id} onOpen={onOpen} onOpenSituation={onOpenSituation} onComplete={complete} />)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
