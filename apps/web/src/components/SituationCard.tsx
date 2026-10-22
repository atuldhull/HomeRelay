import { ArrowRight, Clock } from "lucide-react";
import type { SituationSummary } from "@homerelay/shared";
import { CategoryIcon, StatusBadge, categoryLabel, useClock } from "../ui";

export function Progress({ s }: { s: SituationSummary }) {
  if (s.total_task_count === 0) return null;
  const done = s.total_task_count - s.open_task_count;
  return (
    <div className="progress" role="img" aria-label={`${done} of ${s.total_task_count} tasks done`}>
      <span style={{ width: `${Math.round((done / s.total_task_count) * 100)}%` }} />
    </div>
  );
}

/** One situation, styled by its real state: needs a decision, ready to resolve, resolved, or in motion. */
export function SituationCard({ s, onOpen }: { s: SituationSummary; onOpen: () => void }) {
  const clock = useClock();
  const resolved = s.status === "resolved";
  const state = resolved ? "is-resolved" : s.pending_proposal_id ? "is-attn" : s.can_resolve ? "is-ready" : "";
  return (
    <li>
      <button className={`scard cat-${s.category} ${state}`} onClick={onOpen} aria-label={`Open situation: ${s.title}`}>
        <span className="scard-top">
          <CategoryIcon category={s.category} />
          <span className="scard-cat">{categoryLabel(s.category)}</span>
          {s.source === "demo" && <span className="badge sim" title="Created by the demo button, not a real event">Simulated</span>}
          <span className="spacer" />
          <StatusBadge status={s.status} />
        </span>
        <h3>{s.title}</h3>
        <span className="scard-meta">
          <Clock size={14} aria-hidden />
          {s.expected_at ? `${clock(s.expected_at)}${s.constraints.window_end ? `–${clock(s.constraints.window_end)}` : ""}` : "No time set"}
          <span className="sep" aria-hidden>·</span>
          {s.open_task_count} open task{s.open_task_count === 1 ? "" : "s"}
        </span>
        <Progress s={s} />
        <span className="scard-next">
          <span className="eyebrow">{resolved ? "Outcome" : s.pending_proposal_id ? "Needs you" : "Next"}</span>
          <span className="scard-next-text">{s.next_action}</span>
          {!resolved && <ArrowRight size={16} aria-hidden />}
        </span>
      </button>
    </li>
  );
}
