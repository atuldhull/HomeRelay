import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Ban, Check, Circle, CircleCheck, CircleDot, CircleX, Clock, Download, Ellipsis, FileText, Lightbulb, Lock, MessageCircle, XCircle, Plus } from "lucide-react";
import type { ActivityEvent, DocumentSummary, SituationDetail, Task, TaskWithContext } from "@homerelay/shared";
import { exportUrl } from "../api";
import { CategoryIcon, StatusBadge, categoryLabel, useClock, useLocal } from "../ui";
import { ProposalCard } from "./ProposalCard";
import { SituationDocuments } from "./SituationDocuments";
import { Timeline } from "./Timeline";

interface Props {
  detail: SituationDetail;
  events: ActivityEvent[];
  busy: boolean;
  onBack: () => void;
  onAsk: () => void;
  onApprove: (proposalId: string, ids: string[]) => void;
  onReject: (proposalId: string) => void;
  onTaskStatus: (taskId: string, status: Task["status"], confirmed: boolean) => void;
  onResolve: (closeOutstanding: boolean) => void;
  documents: DocumentSummary[];
  onOpenDocument: (id: string) => void;
  run: (fn: () => Promise<string | void>) => Promise<void>;
  onOpenTask: (id: string) => void;
  onAddTask: () => void;
  onOpenRoute: (route: string) => void;
}

const OPEN = ["pending", "in_progress", "blocked"];
const STATE_ICON = { pending: Circle, in_progress: CircleDot, blocked: Lock, completed: CircleCheck, cancelled: CircleX } as const;

/** Task ids that just moved to completed. The caller only passes tasks that came back from a successful server response. */
function useJustCompleted(tasks: Task[]): string[] {
  const prev = useRef<Map<string, string> | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const before = prev.current;
    prev.current = new Map(tasks.map((t) => [t.id, t.status]));
    if (!before) return;
    const fresh = tasks.filter((t) => t.status === "completed" && before.get(t.id) && before.get(t.id) !== "completed").map((t) => t.id);
    if (!fresh.length) return;
    setIds(fresh);
    const h = setTimeout(() => setIds([]), 1600);
    return () => clearTimeout(h);
  }, [tasks]);
  return ids;
}

function TaskRow({ t, all, busy, justDone, onStatus, onOpen }: { t: Task; all: Task[]; busy: boolean; justDone: boolean; onStatus: Props["onTaskStatus"]; onOpen: (id: string) => void }) {
  const clock = useClock();
  const [confirming, setConfirming] = useState(false);
  const dep = t.depends_on_task_id ? all.find((x) => x.id === t.depends_on_task_id) : null;
  const open = OPEN.includes(t.status);
  // The server's own answer (waiting_on) also covers prerequisites outside this situation, such as a household task.
  const waitingOn = (t as Partial<TaskWithContext>).waiting_on ?? (dep && !["completed", "cancelled"].includes(dep.status) ? dep.title : null);
  const waiting = !!waitingOn;
  const pastDue = open && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const Icon = STATE_ICON[t.status];
  return (
    <li className={`task ${t.status} ${justDone ? "just-done" : ""} ${waiting ? "is-waiting" : ""}`}>
      <span className="task-state" aria-hidden><Icon size={20} /></span>
      <div className="task-main">
        <button className="task-title link-title" onClick={() => onOpen(t.id)} aria-label={`Open task: ${t.title}`}>{t.title}</button>
        <span className="task-meta">
          <StatusBadge status={t.status} />
          {t.due_at && <span className="due"><Clock size={12} aria-hidden /> Due {clock(t.due_at)}</span>}
          {pastDue && <span className="tag late" title="Past its due time. HomeRelay does not know whether you did it.">Overdue</span>}
          {open && !waiting && !pastDue && <span className="tag ready">Ready</span>}
          {(dep || waitingOn) && <span className={`dep ${waiting ? "wait" : ""}`}>{waiting ? "Waiting for" : "After"}: {waitingOn ?? dep?.title}</span>}
        </span>
        {t.description && <span className="task-desc">{t.description}</span>}
      </div>
      {open && !confirming && (
        <div className="task-actions">
          <button className="btn small" disabled={busy || waiting} title={waiting ? `Waiting for: ${waitingOn}` : undefined} onClick={() => setConfirming(true)}><Check size={14} aria-hidden /> Mark done</button>
          <button className="btn small ghost" disabled={busy} onClick={() => onStatus(t.id, "cancelled", false)}>Cancel</button>
        </div>
      )}
      {open && confirming && (
        <div className="task-actions confirm" role="group" aria-label="Confirm completion">
          <span>Did you actually do this?</span>
          <button className="btn small primary" disabled={busy} onClick={() => { setConfirming(false); onStatus(t.id, "completed", true); }}>Yes, it is done</button>
          <button className="btn small" onClick={() => setConfirming(false)}>Not yet</button>
        </div>
      )}
    </li>
  );
}

function ActionMenu({ id, disabled, onClose }: { id: string; disabled: boolean; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu" ref={box}>
      <button className="btn icon" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen((o) => !o)}><Ellipsis size={18} aria-hidden /></button>
      {open && (
        <ul className="menu-list" role="menu">
          <li role="none"><a role="menuitem" href={exportUrl.report(id)} download onClick={() => setOpen(false)}><FileText size={15} aria-hidden /> Download report</a></li>
          <li role="none"><a role="menuitem" href={exportUrl.json(id)} download onClick={() => setOpen(false)}><Download size={15} aria-hidden /> Download JSON</a></li>
          <li role="none"><button role="menuitem" disabled={disabled} onClick={() => { setOpen(false); onClose(); }}><XCircle size={15} aria-hidden /> Close this situation…</button></li>
        </ul>
      )}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      {value ? <dd>{value}</dd> : <dd className="unknown"><span>Unknown</span>{hint && <em>{hint}</em>}</dd>}
    </div>
  );
}

export function SituationView({ detail, events, busy, onBack, onAsk, onApprove, onReject, onTaskStatus, onResolve, documents, onOpenDocument, run, onOpenTask, onAddTask, onOpenRoute }: Props) {
  const clock = useClock(); const local = useLocal();
  const { situation: s, tasks, proposals, preferences, workflow } = detail;
  const [closing, setClosing] = useState(false);
  const justDone = useJustCompleted(tasks);
  const pending = proposals.find((p) => p.status === "proposed");
  const history = proposals.filter((p) => p !== pending).slice(0, 2);
  const openTasks = tasks.filter((t) => OPEN.includes(t.status));
  const closedTasks = tasks.filter((t) => !OPEN.includes(t.status));
  const resolved = s.status === "resolved";
  const when = s.expected_at ? `${clock(s.expected_at)}${s.constraints.window_end ? `–${clock(s.constraints.window_end)}` : ""}` : null;

  return (
    <div className="page detail">
      <button className="btn ghost small back" onClick={onBack}><ArrowLeft size={14} aria-hidden /> All situations</button>

      <header className={`d-head cat-${s.category}`}>
        <CategoryIcon category={s.category} size={24} />
        <div className="d-title">
          <p className="eyebrow">{categoryLabel(s.category)}{s.source === "demo" && <span className="badge sim">Simulated</span>}</p>
          <h1>{s.title}</h1>
          <p className="d-meta"><StatusBadge status={s.status} />{when && <span><Clock size={14} aria-hidden /> {when}</span>}{documents.length > 0 && <span>{documents.length} document{documents.length === 1 ? "" : "s"}</span>}</p>
          {s.description && <p className="d-desc">{s.description}</p>}
        </div>
        <div className="d-actions">
          <button className="btn primary" onClick={onAsk}><MessageCircle size={16} aria-hidden /> Ask about this situation</button>
          <ActionMenu id={s.id} disabled={busy || resolved} onClose={() => setClosing(true)} />
        </div>
      </header>

      {closing && !resolved && (
        <div className="confirm bar" role="group" aria-label="Confirm closing">
          <span>{openTasks.length ? `This cancels ${openTasks.length} open task(s) and marks the situation resolved.` : "Mark this situation resolved?"}</span>
          <button className="btn small primary" disabled={busy} onClick={() => { setClosing(false); onResolve(openTasks.length > 0); }}>Close it</button>
          <button className="btn small" onClick={() => setClosing(false)}>Keep open</button>
        </div>
      )}

      <section className={`next-card relay-next ${workflow.can_resolve ? "ready" : ""}`} aria-label="Next recommended action">
        <span className="next-ico" aria-hidden>{workflow.can_resolve ? <CircleCheck size={22} /> : resolved ? <Ban size={22} /> : <Lightbulb size={22} />}</span>
        <div>
          <p className="eyebrow">Next recommended action</p>
          <p className="next-big">{workflow.next_action}</p>
          <p className="fine">{workflow.scenario}. {workflow.resolution}</p>
        </div>
        {workflow.can_resolve && !resolved && (
          <button className="btn primary" disabled={busy} onClick={() => onResolve(false)}><CircleCheck size={16} aria-hidden /> Resolve</button>
        )}
      </section>

      <div className="detail-grid">
        <div className="main-col">
          {pending && (
            <ProposalCard key={pending.id} proposal={pending} busy={busy} onApprove={(ids) => onApprove(pending.id, ids)} onReject={() => onReject(pending.id)} />
          )}

          <section className="panel" aria-label="Tasks">
            <h2>Tasks <span className="count">{openTasks.length} open · {closedTasks.filter((t) => t.status === "completed").length} done</span>
              {!resolved && <button className="btn small add-task" onClick={onAddTask}><Plus size={14} aria-hidden /> Add task</button>}</h2>
            {tasks.length === 0 ? <p className="muted">No tasks yet. Ask HomeRelay to plan this, then approve the proposal.</p> : (
              <>
                {openTasks.length > 0 && <ul className="tasks" aria-label="To do">{openTasks.map((t) => <TaskRow key={t.id} t={t} all={tasks} busy={busy} justDone={false} onStatus={onTaskStatus} onOpen={onOpenTask} />)}</ul>}
                {closedTasks.length > 0 && (
                  <>
                    <h3 className="subhead">Finished</h3>
                    <ul className="tasks" aria-label="Finished">{closedTasks.map((t) => <TaskRow key={t.id} t={t} all={tasks} busy={busy} justDone={justDone.includes(t.id)} onStatus={onTaskStatus} onOpen={onOpenTask} />)}</ul>
                  </>
                )}
              </>
            )}
            {resolved && <p className="resolved-note"><CircleCheck size={16} aria-hidden /> Resolved {s.resolved_at ? local(s.resolved_at) : ""}, based on your confirmation. Not independently verified.</p>}
          </section>

          {history.map((p) => <ProposalCard key={p.id} proposal={p} busy={busy} onApprove={() => undefined} onReject={() => undefined} />)}
        </div>

        <aside className="side-col">
          <section className="panel" aria-label="Constraints">
            <h2>What HomeRelay knows</h2>
            <dl className="facts">
              <Fact label={s.category === "maintenance" ? "Window" : s.category === "family_visit" ? "Arrival" : "Expected"} value={when} hint="Not set" />
              <Fact label={s.category === "maintenance" ? "You are home from" : "You are free from"} value={s.constraints.available_from ? clock(s.constraints.available_from) : null} hint="Tell HomeRelay" />
              {s.category === "delivery" && <Fact label="Someone else home" value={s.constraints.nobody_else_home ? "No" : null} hint="Not stated" />}
              {preferences.map((p) => <Fact key={p.key} label={p.key.replace(/_/g, " ")} value={p.value} />)}
            </dl>
          </section>

          <SituationDocuments situationId={s.id} documents={documents} busy={busy} resolved={resolved} onOpen={onOpenDocument} run={run} />

          <section className="panel" aria-label="Activity timeline">
            <h2>Activity <span className="count">{events.length} recorded</span></h2>
            <Timeline events={events} onOpenRecord={onOpenRoute} />
          </section>
        </aside>
      </div>
    </div>
  );
}
