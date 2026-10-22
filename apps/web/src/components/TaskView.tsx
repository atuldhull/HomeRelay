import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Clock, FileText, Link2, Lock, MessageCircle, Repeat, RotateCcw, Trash2, Unlink, X } from "lucide-react";
import type { DocumentHit, SituationSummary, TaskCategory, TaskDetail, TaskWithContext } from "@homerelay/shared";
import { PRIORITIES, RECURRENCES, TASK_CATEGORIES, TASK_CATEGORY_LABEL, shiftLocal } from "@homerelay/shared";
import { ApiError, api } from "../api";
import { makeSequencer, parseRoute } from "../logic";
import type { Route } from "../types";
import { StatusBadge, useLocal, useTz } from "../ui";
import { Timeline } from "./Timeline";

/** ISO instant -> "YYYY-MM-DDTHH:mm" in the app time zone, for a datetime-local input. */
function toLocalInput(iso: string | null, tz: string): string {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

interface Props {
  id: string;
  version: number;
  situations: SituationSummary[];
  busy: boolean;
  run: (fn: () => Promise<string | void>) => Promise<void>;
  onNav: (r: Route) => void;
  onAsk: () => void;
  onMissing: (message: string) => void;
}

export function TaskView({ id, version, situations, busy, run, onNav, onAsk, onMissing }: Props) {
  const tz = useTz(); const local = useLocal(); const uid = useId(); const fid = (n: string) => `${uid}-${n}`;
  const [d, setD] = useState<TaskDetail | null>(null);
  const [openTasks, setOpenTasks] = useState<TaskWithContext[]>([]);
  const [confirm, setConfirm] = useState<"done" | "delete" | null>(null);
  const [docQ, setDocQ] = useState(""); const [docHits, setDocHits] = useState<DocumentHit[]>([]); const [picking, setPicking] = useState(false);
  const seq = useRef(makeSequencer());

  useEffect(() => {
    const n = seq.current.next("task");
    api.task(id).then((r) => { if (seq.current.isLatest("task", n)) setD(r); })
      .catch((e) => { if (seq.current.isLatest("task", n)) onMissing(e instanceof ApiError && e.code === "NOT_FOUND" ? "That task no longer exists." : e instanceof Error ? e.message : "Could not load the task."); });
    api.tasks({ filter: "open" }).then((r) => setOpenTasks(r.tasks)).catch(() => undefined);
  }, [id, version, onMissing]);
  useEffect(() => {
    if (!picking) return;
    const h = setTimeout(() => api.documents({ q: docQ.trim() || undefined, limit: 8 }).then((r) => setDocHits(r.results)).catch(() => undefined), 200);
    return () => clearTimeout(h);
  }, [docQ, picking]);

  // ---- editable details (only changed fields are sent) ----
  const t = d?.task;
  const initial = useMemo(() => t ? { title: t.title, description: t.description, due: toLocalInput(t.due_at, tz), priority: t.priority, category: t.category, tags: t.tags.join(", "), recurrence: t.recurrence } : null, [t, tz]);
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  if (!d || !t || !form || !initial) return <div className="page center"><span className="spinner big" role="status" aria-label="Loading task" /></div>;

  const open = ["pending", "in_progress", "blocked"].includes(t.status);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const save = () => run(async () => {
    const tagList = form.tags.split(",").map((x) => x.trim()).filter(Boolean);
    await api.updateTask(t.id, {
      ...(form.title !== initial.title ? { title: form.title } : {}), ...(form.description !== initial.description ? { description: form.description } : {}),
      ...(form.due !== initial.due ? { dueLocal: form.due || null } : {}), ...(form.priority !== initial.priority ? { priority: form.priority } : {}),
      ...(form.category !== initial.category ? { category: form.category } : {}), ...(form.tags !== initial.tags ? { tags: tagList } : {}),
      ...(form.recurrence !== initial.recurrence ? { recurrence: form.recurrence } : {}),
    });
    return "Task saved.";
  });
  const depChoices = openTasks.filter((x) => x.id !== t.id && (!x.situation_id || !t.situation_id || x.situation_id === t.situation_id));

  return (
    <div className="page ws task-page">
      <button className="btn ghost small back" onClick={() => onNav({ view: "tasks" })}><ArrowLeft size={14} aria-hidden /> All tasks</button>

      <header className={`d-head task-head prio-${t.priority}`}>
        <div className="d-title">
          <p className="eyebrow">{TASK_CATEGORY_LABEL[t.category]} · {t.situation_id ? "Situation task" : "Household task"}</p>
          <h1>{t.title}</h1>
          <p className="d-meta">
            <StatusBadge status={t.status} />
            {t.priority !== "normal" && <span className={`tag ${t.priority === "high" ? "late" : "muted"}`}>{t.priority} priority</span>}
            <span><Clock size={14} aria-hidden /> {t.due_at ? local(t.due_at) : "No due time"}</span>
            {t.overdue && <span className="tag late">Overdue</span>}
            {t.recurrence !== "none" && <span className="chip-meta"><Repeat size={12} aria-hidden /> Repeats {t.recurrence}</span>}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={onAsk}><MessageCircle size={16} aria-hidden /> Ask about this task</button>
        </div>
      </header>

      {d.blocked_reason && <p className="note" role="note"><Lock size={16} aria-hidden /> Cannot be completed yet: {d.blocked_reason}.</p>}

      <div className="actions-bar" role="group" aria-label="Task actions">
        {open && confirm !== "done" && <button className="btn" disabled={busy || !!d.blocked_reason} onClick={() => setConfirm("done")}><Check size={16} aria-hidden /> Mark done</button>}
        {open && confirm === "done" && (
          <span className="confirm" role="group" aria-label="Confirm completion">Did you actually do this?
            <button className="btn small primary" disabled={busy} onClick={() => { setConfirm(null); void run(async () => { await api.setTaskStatus(t.id, "completed", true); return t.recurrence !== "none" ? "Marked done. The next occurrence was saved." : "Marked done, based on your confirmation."; }); }}>Yes, it is done</button>
            <button className="btn small" onClick={() => setConfirm(null)}>Not yet</button></span>
        )}
        {open && t.status !== "in_progress" && <button className="btn ghost" disabled={busy || !!d.blocked_reason} onClick={() => run(async () => { await api.setTaskStatus(t.id, "in_progress"); return "Marked in progress."; })}>Start</button>}
        {open && <button className="btn ghost" disabled={busy} onClick={() => run(async () => { await api.setTaskStatus(t.id, "cancelled"); return "Task cancelled."; })}><X size={16} aria-hidden /> Cancel task</button>}
        {!open && <button className="btn" disabled={busy} onClick={() => run(async () => { await api.reopenTask(t.id); return "Task reopened."; })}><RotateCcw size={16} aria-hidden /> Reopen</button>}
        <span className="spacer" />
        {confirm !== "delete"
          ? <button className="btn ghost small" disabled={busy} onClick={() => setConfirm("delete")}><Trash2 size={14} aria-hidden /> Delete…</button>
          : <span className="confirm" role="group" aria-label="Confirm deletion">Delete permanently? Its history stays in the activity log.
              <button className="btn small danger" disabled={busy} onClick={() => run(async () => { await api.deleteTask(t.id); onNav({ view: "tasks" }); return "Task deleted."; })}>Delete permanently</button>
              <button className="btn small" onClick={() => setConfirm(null)}>Keep it</button></span>}
      </div>

      <div className="detail-grid">
        <div className="main-col">
          <section className="panel reveal-on-scroll" aria-label="Details">
            <h2>Details</h2>
            <form className="meta-form" onSubmit={(e) => { e.preventDefault(); if (dirty && open) void save(); }}>
              <fieldset disabled={!open} className="bare">
                <div className="field"><label htmlFor={fid("title")}>Title</label><input id={fid("title")} value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
                <div className="field"><label htmlFor={fid("desc")}>Notes</label><textarea id={fid("desc")} rows={3} value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                <div className="row3">
                  <div className="field"><label htmlFor={fid("due")}>Due</label><input id={fid("due")} type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></div>
                  <div className="field"><label htmlFor={fid("prio")}>Priority</label><select id={fid("prio")} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as typeof form.priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></div>
                  <div className="field"><label htmlFor={fid("cat")}>Category</label><select id={fid("cat")} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TaskCategory })}>{TASK_CATEGORIES.map((c) => <option key={c} value={c}>{TASK_CATEGORY_LABEL[c]}</option>)}</select></div>
                </div>
                <div className="row2">
                  <div className="field"><label htmlFor={fid("tags")}>Tags</label><input id={fid("tags")} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="comma, separated" /></div>
                  <div className="field"><label htmlFor={fid("rec")}>Repeats</label><select id={fid("rec")} value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as typeof form.recurrence })}>{RECURRENCES.map((r) => <option key={r} value={r}>{r === "none" ? "Does not repeat" : r === "weekly" ? "Every week" : "Every month"}</option>)}</select></div>
                </div>
                <button type="submit" className="btn primary" disabled={!dirty || busy}>Save changes</button>
              </fieldset>
              {!open && <p className="fine">Reopen the task to edit it.</p>}
            </form>
          </section>

          <section className="panel reveal-on-scroll" aria-label="Task activity">
            <h2>Activity <span className="count">{d.activity.length} recorded</span></h2>
            {d.activity.length ? <Timeline events={d.activity} onOpenRecord={(r) => onNav(parseRoute(r))} /> : <p className="muted">Nothing recorded yet.</p>}
          </section>
        </div>

        <aside className="side-col">
          <section className="panel reveal-on-scroll" aria-label="Task connections">
            <h2>Connections</h2>
            <div className="field">
              <label htmlFor={fid("sit")}>Situation</label>
              <select id={fid("sit")} value={t.situation_id ?? ""} disabled={!open || busy} onChange={(e) => { const v = e.target.value || null; void run(async () => { await api.updateTask(t.id, { situationId: v }); return v ? "Moved to the situation." : "Now a household task."; }); }}>
                <option value="">None (household task)</option>
                {situations.filter((s) => s.status !== "resolved" || s.id === t.situation_id).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
              {d.situation && <button className="link small" onClick={() => onNav({ view: "situation", id: d.situation!.id })}>Open “{d.situation.title}”</button>}
            </div>
            <div className="field">
              <label htmlFor={fid("dep")}>Must happen after</label>
              <select id={fid("dep")} value={t.depends_on_task_id ?? ""} disabled={!open || busy} onChange={(e) => { const v = e.target.value || null; void run(async () => { await api.updateTask(t.id, { dependsOnTaskId: v }); return v ? "Prerequisite saved." : "Prerequisite removed."; }); }}>
                <option value="">Nothing</option>
                {d.depends_on && !depChoices.some((x) => x.id === d.depends_on!.id) && <option value={d.depends_on.id}>{d.depends_on.title} ({d.depends_on.status})</option>}
                {depChoices.map((x) => <option key={x.id} value={x.id}>{x.title}{x.situation_title ? ` · ${x.situation_title}` : ""}</option>)}
              </select>
              {d.depends_on && <button className="link small" onClick={() => onNav({ view: "task", id: d.depends_on!.id })}>Open “{d.depends_on.title}” ({d.depends_on.status.replace("_", " ")})</button>}
            </div>
            <div>
              <h3 className="section-title">Waiting on this task</h3>
              {d.dependents.length ? (
                <ul className="links">{d.dependents.map((x) => <li key={x.id}><button className="link" onClick={() => onNav({ view: "task", id: x.id })}>{x.title}</button> <StatusBadge status={x.status} /></li>)}</ul>
              ) : <p className="muted small">No other task depends on this one.</p>}
            </div>
          </section>

          {(t.recurrence !== "none" || d.previous_occurrence) && (
            <section className="panel reveal-on-scroll recur-panel" aria-label="Repeats">
              <h2><Repeat size={17} aria-hidden /> Repeats</h2>
              {t.recurrence !== "none" ? (
                <p className="small">Every {t.recurrence === "weekly" ? "week" : "month"}. {open
                  ? <>When you mark this one done, HomeRelay saves the next one{t.due_at ? <>, due {local(shiftLocal(t.due_at, t.recurrence === "weekly" ? { days: 7 } : { months: 1 }, tz))} (or the first matching date after today)</> : ""}. Nothing is sent as a reminder.</>
                  : "This occurrence is finished."}</p>
              ) : <p className="small">This occurrence no longer repeats.</p>}
              <ul className="occ-list">
                {d.previous_occurrence && <li><span className="muted">Previous</span><button className="link" onClick={() => onNav({ view: "task", id: d.previous_occurrence!.id })}>{d.previous_occurrence.due_at ? local(d.previous_occurrence.due_at) : d.previous_occurrence.title}</button><StatusBadge status={d.previous_occurrence.status} /></li>}
                <li className="current"><span className="muted">This one</span><span>{t.due_at ? local(t.due_at) : "No due time"}</span><StatusBadge status={t.status} /></li>
                {d.next_occurrence && <li><span className="muted">Next</span><button className="link" onClick={() => onNav({ view: "task", id: d.next_occurrence!.id })}>{d.next_occurrence.due_at ? local(d.next_occurrence.due_at) : d.next_occurrence.title}</button><StatusBadge status={d.next_occurrence.status} /></li>}
              </ul>
            </section>
          )}

          <section className="panel reveal-on-scroll" aria-label="Task documents">
            <h2>Documents <span className="count">{d.documents.length}</span></h2>
            {d.documents.length ? (
              <ul className="att-docs">{d.documents.map((x) => (
                <li key={x.id}>
                  <button className="doc-mini" onClick={() => onNav({ view: "document", id: x.id })} aria-label={`Open document: ${x.title}`}><FileText size={16} aria-hidden /><span><strong>{x.title}</strong><span className="muted">{x.category.replace("_", " ")}</span></span></button>
                  <button className="icon-btn" disabled={busy} aria-label={`Detach ${x.title}`} title="Detach (the document is kept)" onClick={() => run(async () => { await api.unlinkTaskDocument(t.id, x.id); return `Detached ${x.title}.`; })}><Unlink size={15} /></button>
                </li>
              ))}</ul>
            ) : <p className="muted small">No documents attached.</p>}
            <button className="btn small" onClick={() => { setPicking((p) => !p); setDocQ(""); }} aria-expanded={picking}><Link2 size={14} aria-hidden /> Attach a document</button>
            {picking && (
              <div className="picker">
                <label className="sr-only" htmlFor={fid("pick")}>Find a document</label>
                <input id={fid("pick")} type="search" autoFocus placeholder="Find a document…" value={docQ} onChange={(e) => setDocQ(e.target.value)} />
                <ul>{docHits.filter((h) => !d.documents.some((x) => x.id === h.document.id)).map((h) => (
                  <li key={h.document.id}><span>{h.document.title}</span>
                    <button className="btn small" disabled={busy} onClick={() => run(async () => { await api.linkTaskDocument(t.id, h.document.id); setPicking(false); return `Attached ${h.document.title}.`; })}><Link2 size={13} aria-hidden /> Attach</button></li>
                ))}{!docHits.length && <li className="muted">No documents match.</li>}</ul>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
