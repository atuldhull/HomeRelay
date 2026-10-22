import { useState } from "react";
import { ArrowRight, CircleCheck, FileText, Lightbulb, Lock } from "lucide-react";
import type { DashboardResponse, TaskWithContext } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL, type DocumentCategory } from "@homerelay/shared";
import type { Route } from "../types";
import { relative, useClock, useLocal } from "../ui";

type Period = "today" | "week";

/**
 * HomeRelay Pulse: a short briefing built only from the stored workload summary (tasks, plans, documents, activity).
 * No score, no estimate: if HomeRelay has not been told something, it is not here.
 */
export function Pulse({ data, onNav }: { data: DashboardResponse; onNav: (r: Route) => void }) {
  const clock = useClock(); const local = useLocal();
  const [period, setPeriod] = useState<Period>("today");
  const s = data.summary;
  const blocked = s.blocked.filter((t) => !s.overdue.some((o) => o.id === t.id) && !s.due_today.some((o) => o.id === t.id));
  const recentDocs = s.recent_documents.filter((d) => Date.now() - new Date(d.created_at).getTime() < 7 * 86_400_000).slice(0, 3);

  // suggested next actions: each one points at a real record and says why
  const next: { key: string; text: string; route: Route }[] = [];
  for (const a of s.waiting_approval) next.push({ key: `ap-${a.proposal_id}`, text: `Review the proposed plan for "${a.situation_title}"`, route: { view: "situation", id: a.situation_id } });
  for (const t of s.overdue) next.push({ key: `od-${t.id}`, text: `Complete or reschedule "${t.title}"`, route: { view: "task", id: t.id } });
  for (const t of s.blocked) if (t.waiting_on && t.depends_on_task_id) next.push({ key: `bl-${t.id}`, text: `Finish "${t.waiting_on}" so "${t.title}" can go ahead`, route: { view: "task", id: t.depends_on_task_id } });
  for (const r of s.can_resolve) next.push({ key: `rs-${r.situation_id}`, text: `Confirm "${r.situation_title}" is done`, route: { view: "situation", id: r.situation_id } });

  const row = (t: TaskWithContext, tag: string, tone: string, when: string) => (
    <li key={`${tag}-${t.id}`}>
      <button className="att" onClick={() => onNav({ view: "task", id: t.id })} aria-label={`${tag}: ${t.title}`}>
        <span className={`tag ${tone}`}>{tag}</span>
        <span className="att-main"><strong>{t.title}</strong><span className="muted"> · {t.situation_title ?? "Household task"}</span></span>
        <span className="att-when">{t.waiting_on ? <><Lock size={12} aria-hidden /> {t.waiting_on}</> : when}</span>
      </button>
    </li>
  );
  const shown = new Set<string>();
  const once = (list: TaskWithContext[]) => list.filter((t) => !shown.has(t.id) && shown.add(t.id));
  const items = [
    ...once(s.overdue).map((t) => row(t, "Overdue", "late", `was ${clock(t.due_at)}`)),
    ...once(s.due_today).map((t) => row(t, "Today", "warn", clock(t.due_at))),
    ...once(blocked).map((t) => row(t, "Blocked", "muted", "")),
    ...(period === "week" ? once(s.upcoming).map((t) => row(t, "This week", "info", local(t.due_at))) : []),
    ...s.waiting_approval.map((a) => (
      <li key={`ap-${a.proposal_id}`}><button className="att" onClick={() => onNav({ view: "situation", id: a.situation_id })}>
        <span className="tag info">Proposed</span><span className="att-main"><strong>Plan waiting for your decision</strong><span className="muted"> · {a.situation_title}</span></span>
        <span className="att-when">Not created yet</span></button></li>
    )),
  ];
  const nothing = !items.length && !s.can_resolve.length;
  const empty = s.open_situations === 0 && s.open_tasks === 0 && !s.recent_documents.length;

  return (
    <section className="panel pulse" aria-label="HomeRelay Pulse">
      <div className="pulse-head">
        <h2><span className="pulse-dot" aria-hidden /> HomeRelay Pulse</h2>
        <div className="seg" role="group" aria-label="Period">
          {(["today", "week"] as Period[]).map((p) => <button key={p} className={period === p ? "on" : ""} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === "today" ? "Today" : "This week"}</button>)}
        </div>
      </div>
      {empty ? (
        <p className="muted">HomeRelay has no situations, tasks or documents yet, so there is nothing to brief you on.</p>
      ) : (
        <>
          <p className="pulse-line" role="status">
            {s.overdue.length ? <strong>{s.overdue.length} overdue</strong> : "Nothing overdue"} · {s.due_today.length} due today
            {period === "week" && ` · ${s.upcoming.length} later this week`} · {s.blocked.length} blocked · {s.waiting_approval.length} plan{s.waiting_approval.length === 1 ? "" : "s"} to approve
          </p>
          {nothing ? <p className="calm"><CircleCheck size={18} aria-hidden /> Nothing is overdue, due {period === "today" ? "today" : "this week"}, blocked or waiting on you.</p>
            : <ul className="att-list">{items.slice(0, 7)}</ul>}
          {items.length > 7 && <button className="link small" onClick={() => onNav({ view: "tasks" })}>See all {items.length} in Tasks</button>}
          {next.length > 0 && (
            <div className="pulse-next">
              <h3 className="section-title"><Lightbulb size={13} aria-hidden /> Suggested next</h3>
              <ul>{next.slice(0, 4).map((n) => <li key={n.key}><button className="link-row" onClick={() => onNav(n.route)}>{n.text} <ArrowRight size={13} aria-hidden /></button></li>)}</ul>
            </div>
          )}
          {recentDocs.length > 0 && (
            <div className="pulse-docs">
              <h3 className="section-title"><FileText size={13} aria-hidden /> New this week</h3>
              <ul>{recentDocs.map((d) => <li key={d.id}><button className="link-row" onClick={() => onNav({ view: "document", id: d.id })}>{d.title} <span className="muted">· {DOCUMENT_CATEGORY_LABEL[d.category as DocumentCategory] ?? d.category} · {relative(d.created_at)}</span></button></li>)}</ul>
            </div>
          )}
          <p className="fine">Built from your stored records just now. Overdue means past its due time, not that anything failed.</p>
        </>
      )}
    </section>
  );
}
