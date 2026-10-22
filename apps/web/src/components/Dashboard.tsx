import { useMemo, useState } from "react";
import { ArrowRight, CircleCheck, Clock, FolderOpen, Play, Plus, RotateCcw, Send } from "lucide-react";
import type { DashboardResponse, DocumentSummary, TaskWithContext } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import { greetingFor, parseRoute, pickFeatured } from "../logic";
import type { Route } from "../types";
import { CategoryIcon, DocIcon, StatusBadge, categoryLabel, formatBytes, relative, useClock } from "../ui";
import { HomeIllustration } from "./HomeIllustration";
import { Progress } from "./SituationCard";
import { Pulse } from "./Pulse";
import { Timeline } from "./Timeline";

/** Entrance choreography plays once per page load, not on every navigation or refresh. */
let entrancePlayed = false;

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" | "ok" }) {
  return (
    <div className={`stat ${value > 0 && tone ? tone : ""} ${value === 0 ? "zero" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface Props {
  data: DashboardResponse | null;
  recentDocs: DocumentSummary[];
  loading: boolean;
  busy: boolean;
  onSimulate: () => void;
  onReset: () => void;
  onOpen: (id: string) => void;
  onNav: (r: Route) => void;
  onNew: () => void;
  onAsk: (prompt?: string) => void;
}

export function Dashboard({ data, recentDocs, loading, busy, onSimulate, onReset, onOpen, onNav, onNew, onAsk }: Props) {
  const clock = useClock();
  const [confirmReset, setConfirmReset] = useState(false);
  const [ask, setAsk] = useState("");
  const [played] = useState(entrancePlayed);
  entrancePlayed = true;

  const all = data?.situations ?? [];
  const s = data?.summary;
  const featured = useMemo(() => pickFeatured(data), [data]);
  const needYou = (s?.waiting_approval.length ?? 0) + (s?.overdue.length ?? 0) + (s?.due_today.length ?? 0) + (s?.can_resolve.length ?? 0);
  const rv = played ? "" : "reveal";
  const headline = loading && !data ? "Loading your household…"
    : !s || s.open_situations === 0 ? "All quiet at home."
    : needYou > 0 ? `${needYou} thing${needYou === 1 ? "" : "s"} could use you.` : "Everything is on track.";
  const sub = loading && !data ? "" : !s || s.open_situations === 0
    ? "Nothing is open. Tell HomeRelay what is happening and it will plan it with you."
    : `${s.open_situations} situation${s.open_situations === 1 ? "" : "s"} in progress, ${s.open_tasks} open task${s.open_tasks === 1 ? "" : "s"}.`;
  const submitAsk = (e: React.FormEvent) => { e.preventDefault(); const v = ask.trim(); if (v) { setAsk(""); onAsk(v); } };

  return (
    <div className="page dash">
      <section className={`hero compact ${rv}`} style={{ ["--i" as string]: 0 }}>
        <div className="hero-in">
          <p className="eyebrow on-dark">{greetingFor(new Date())}</p>
          <h1>{headline}</h1>
          <p className="hero-sub">{sub}</p>
          <form className="askbar" onSubmit={submitAsk} role="search" aria-label="Ask HomeRelay">
            <label htmlFor="askbar-input" className="sr-only">Ask HomeRelay</label>
            <input id="askbar-input" value={ask} onChange={(e) => setAsk(e.target.value)} maxLength={1000} placeholder="Ask HomeRelay anything…" autoComplete="off" />
            <button type="submit" className="btn go" disabled={!ask.trim()} aria-label="Send to HomeRelay"><Send size={16} aria-hidden /></button>
          </form>
          {s && (
            <dl className="workload strip" aria-label="Workload summary">
              <Stat label="Open situations" value={s.open_situations} />
              <Stat label="Due today" value={s.due_today.length} tone="warn" />
              <Stat label="Overdue" value={s.overdue.length} tone="bad" />
              <Stat label="Awaiting approval" value={s.waiting_approval.length} tone="warn" />
              <Stat label="Ready to resolve" value={s.can_resolve.length} tone="ok" />
            </dl>
          )}
          <div className="hero-actions">
            <button className="btn on-dark" onClick={onSimulate} disabled={busy} aria-busy={busy}>
              {busy ? <span className="spinner" aria-hidden /> : <Play size={15} aria-hidden />} Simulate delivery event
            </button>
            {!confirmReset ? (
              <button className="btn text-dark" onClick={() => setConfirmReset(true)} disabled={busy}><RotateCcw size={14} aria-hidden /> Reset demo</button>
            ) : (
              <span className="confirm on-dark" role="group" aria-label="Confirm demo reset">
                <span>Remove simulated situations only. Your own data and documents are kept.</span>
                <button className="btn small danger" onClick={() => { setConfirmReset(false); onReset(); }}>Reset demo data</button>
                <button className="btn small on-dark" onClick={() => setConfirmReset(false)}>Cancel</button>
              </span>
            )}
          </div>
        </div>
      </section>

      {loading && !data && (
        <div className="home-grid skeleton-board" aria-busy="true" aria-label="Loading"><div className="sk sk-feature" /><div className="sk sk-stats" /></div>
      )}

      {data && all.length === 0 && !s?.open_tasks && !recentDocs.length && (
        <section className={`empty ${rv}`} style={{ ["--i" as string]: 1 }}>
          <HomeIllustration />
          <div className="empty-copy">
            <h2>Tell HomeRelay what is happening</h2>
            <p>A delivery while you are in a meeting, a technician’s window, family arriving: HomeRelay turns each into a plan you approve, tasks it tracks, the documents that belong to it, and a record of what happened.</p>
            <div className="empty-actions">
              <button className="btn primary" onClick={onSimulate} disabled={busy}><Play size={16} aria-hidden /> Start with a simulated delivery</button>
              <button className="btn" onClick={onNew}><Plus size={16} aria-hidden /> Add your own</button>
            </div>
            <p className="fine">The simulated event is clearly labelled and goes through the same tools as a real one.</p>
          </div>
        </section>
      )}

      {data && s && (all.length > 0 || s.open_tasks > 0 || recentDocs.length > 0) && (
        <div className={`home-grid ${rv}`} style={{ ["--i" as string]: 1 }}>
          <div className="home-main">
            <Pulse data={data} onNav={onNav} />
          </div>
          <aside className="home-side">
            <section className="featured" aria-label="Right now">
              <h2 className="relay-title"><span className="relay-mark" aria-hidden /> Next up</h2>
              {featured ? (
                <button className={`feat-card next-up cat-${featured.category}`} onClick={() => onOpen(featured.id)} aria-label={`Open situation: ${featured.title}`}>
                  <span className="feat-top"><CategoryIcon category={featured.category} size={18} /><span className="scard-cat">{categoryLabel(featured.category)}</span>
                    {featured.source === "demo" && <span className="badge sim">Simulated</span>}<span className="spacer" /><StatusBadge status={featured.status} /></span>
                  <span className="feat-title">{featured.title}</span>
                  <span className="scard-meta"><Clock size={14} aria-hidden /> {featured.expected_at ? `${clock(featured.expected_at)}${featured.constraints.window_end ? `–${clock(featured.constraints.window_end)}` : ""}` : "No time set"}<span className="sep" aria-hidden>·</span>{featured.open_task_count} open task{featured.open_task_count === 1 ? "" : "s"}</span>
                  <Progress s={featured} />
                  <span className="feat-next"><span className="eyebrow">{featured.pending_proposal_id ? "Needs you" : "Next"}</span><span className="feat-next-text">{featured.next_action}</span><ArrowRight size={16} aria-hidden /></span>
                </button>
              ) : <p className="calm"><CircleCheck size={18} aria-hidden /> No situation is open. Household tasks are in Pulse.</p>}
            </section>

            {all.filter((x) => x.status !== "resolved" && x.id !== featured?.id).length > 0 && (
              <section className="panel quiet" aria-label="Active situations">
                <h2>Also in progress <button className="link small-link" onClick={() => onNav({ view: "situations" })}>All situations</button></h2>
                <ul className="mini-list">
                  {all.filter((x) => x.status !== "resolved" && x.id !== featured?.id).slice(0, 4).map((x) => (
                    <li key={x.id}><button className={`mini-row cat-${x.category}`} onClick={() => onOpen(x.id)} aria-label={`Open situation: ${x.title}`}>
                      <CategoryIcon category={x.category} size={15} /><span className="mr-main"><strong>{x.title}</strong><span className="muted">{x.next_action}</span></span><StatusBadge status={x.status} />
                    </button></li>
                  ))}
                </ul>
              </section>
            )}

            <section className="panel quiet" aria-label="Recent documents">
              <h2>Recent documents <button className="link small-link" onClick={() => onNav({ view: "documents" })}>All documents</button></h2>
              {recentDocs.length === 0 ? (
                <p className="muted small"><FolderOpen size={15} aria-hidden /> No documents yet. Keep receipts, warranties and manuals with the situations they belong to.</p>
              ) : (
                <ul className="mini-list">
                  {recentDocs.slice(0, 3).map((d) => (
                    <li key={d.id}>
                      <button className={`doc-mini kind-${d.kind}`} onClick={() => onNav({ view: "document", id: d.id })} aria-label={`Open document: ${d.title}`}>
                        <DocIcon kind={d.kind} />
                        <span><strong>{d.title}</strong><span className="muted">{DOCUMENT_CATEGORY_LABEL[d.category]} · {formatBytes(d.size_bytes)} · {relative(d.created_at)}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel quiet" aria-label="Recent activity">
              <h2>Recent activity <button className="link small-link" onClick={() => onNav({ view: "activity" })}>All activity</button></h2>
              {s.recent_activity.length === 0 ? <p className="muted">Nothing recorded yet.</p> : <Timeline events={[...s.recent_activity].reverse()} newestFirst onOpenRecord={(r) => onNav(parseRoute(r))} max={5} compact />}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
