import { useState } from "react";
import { Check, ChevronDown, Clock, X } from "lucide-react";
import type { Proposal } from "@homerelay/shared";
import { useClock } from "../ui";

interface Props {
  proposal: Proposal;
  busy: boolean;
  onApprove: (selectedActionIds: string[]) => void;
  onReject: () => void;
}

const STATE: Record<Proposal["status"], string> = {
  proposed: "Awaiting your decision",
  approved: "Approved and saved",
  rejected: "Rejected, nothing was created",
  superseded: "Replaced by a newer plan",
};

/** A plan is visibly a PROPOSAL until the user approves it. Approval runs through the backend's user-action endpoint. */
export function ProposalCard({ proposal, busy, onApprove, onReject }: Props) {
  const clock = useClock();
  const actions = proposal.plan.actions;
  const [sel, setSel] = useState<Set<string>>(() => new Set(actions.map((a) => a.id)));
  const live = proposal.status === "proposed";
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <section className={`proposal ${proposal.status}`} aria-label="Proposed plan">
      <header>
        <span className="eyebrow">Proposed plan</span>
        <span className={`pstate ${proposal.status}`}>{STATE[proposal.status]}</span>
      </header>
      <p className="p-summary">{proposal.plan.summary}</p>
      {proposal.plan.conflicts.length > 0 && (
        <ul className="conflicts">{proposal.plan.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
      )}
      <ul className="actions">
        {actions.map((a) => {
          const applied = proposal.applied_action_ids.includes(a.id);
          return (
            <li key={a.id} className={applied ? "applied" : ""}>
              <label>
                <input type="checkbox" checked={live ? sel.has(a.id) : applied} disabled={!live} onChange={() => toggle(a.id)} />
                <span className="a-body">
                  <span className="a-title">
                    {a.type === "reschedule_task" ? "Reschedule: " : "Add task: "}{a.title}
                  </span>
                  <span className="a-meta">
                    <Clock size={12} aria-hidden />
                    {a.type === "reschedule_task" ? `${clock(a.old_due_at)} → ${clock(a.new_due_at)}` : a.due_at ? `Due ${clock(a.due_at)}` : "No due time"}
                  </span>
                  <span className="a-why">{a.rationale}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {(proposal.plan.constraints_used?.length || proposal.plan.outstanding_tasks?.length) ? (
        <details className="assume why" open={live}>
          <summary><ChevronDown size={14} aria-hidden /> Why this plan</summary>
          <p className="fine">Computed from your saved situation, not written by a language model.</p>
          {proposal.plan.scenario && <p><strong>Scenario:</strong> {proposal.plan.scenario}</p>}
          {proposal.plan.constraints_used?.length ? (<><p><strong>Constraints used</strong></p><ul>{proposal.plan.constraints_used.map((c) => <li key={c}>{c}</li>)}</ul></>) : null}
          {proposal.plan.outstanding_tasks?.length ? (<><p><strong>Already outstanding</strong></p><ul>{proposal.plan.outstanding_tasks.map((c) => <li key={c}>{c}</li>)}</ul></>) : null}
        </details>
      ) : null}
      <details className="assume">
        <summary><ChevronDown size={14} aria-hidden /> Assumptions</summary>
        <ul>{proposal.plan.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </details>
      {live ? (
        <footer>
          <button className="btn primary" disabled={busy || sel.size === 0} onClick={() => onApprove([...sel])}>
            <Check size={16} aria-hidden /> Approve {sel.size === actions.length ? "plan" : `${sel.size} selected`}
          </button>
          <button className="btn" disabled={busy} onClick={onReject}><X size={16} aria-hidden /> Reject</button>
        </footer>
      ) : null}
    </section>
  );
}
