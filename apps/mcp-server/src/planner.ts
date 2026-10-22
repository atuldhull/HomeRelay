import type { Plan, PlanAction, Situation, Task } from "@homerelay/shared";
import { formatClock } from "@homerelay/shared";
import { SCENARIOS, type PlanContext, type Scenario, type TaskTemplate } from "./scenarios";

const OPEN = new Set(["pending", "in_progress", "blocked"]);
const MIN = 60_000;
const text = (v: string | ((c: PlanContext) => string), c: PlanContext) => (typeof v === "function" ? v(c) : v);

/** Absolute instant a template wants to be due, or null when its anchor is unknown. */
function dueFor(tpl: TaskTemplate, c: PlanContext): number | null {
  const k = c.situation.constraints;
  const anchor = tpl.anchor === "expected" ? c.situation.expected_at : tpl.anchor === "available" ? k.available_from : k.window_end;
  return anchor ? new Date(anchor).getTime() + tpl.offsetMin * MIN : null;
}

/** The existing task a template produced (by template_key, or by title for tasks created before templates existed). */
function existingFor(tpl: TaskTemplate, c: PlanContext): Task | undefined {
  const title = text(tpl.title, c);
  return c.tasks.find((t) => t.template_key === tpl.key) ?? c.tasks.find((t) => t.template_key === null && t.title === title);
}

/**
 * Deterministic planning. Pure function of (situation, tasks, now) -> Plan; executes nothing.
 *
 * For each applicable template: no task yet -> propose adding it; an open task whose due time no longer matches the
 * constraints -> propose rescheduling THAT task (never a duplicate); a completed or cancelled task -> leave alone.
 * Missing required information produces a question instead of a guess.
 */
export function buildPlan(situation: Situation, tasks: Task[], tz: string, now: Date = new Date()): Plan {
  const scenario: Scenario = SCENARIOS[situation.category];
  const c: PlanContext = { situation, tasks, tz, now };
  const k = situation.constraints;

  const constraintsUsed: string[] = [];
  if (situation.expected_at) constraintsUsed.push(`Expected/starts at ${formatClock(situation.expected_at, tz)}`);
  if (k.window_end) constraintsUsed.push(`Window ends at ${formatClock(k.window_end, tz)}`);
  if (k.available_from) constraintsUsed.push(`You are available from ${formatClock(k.available_from, tz)}`);
  if (k.nobody_else_home) constraintsUsed.push("No one else is home");
  const outstanding = tasks.filter((t) => OPEN.has(t.status)).map((t) => t.title);
  const base = { scenario: scenario.label, situation_title: situation.title, constraints_used: constraintsUsed, outstanding_tasks: outstanding, assumptions: [...scenario.assumptions] };

  const missing = scenario.required.filter((r) => !r.known(c)).map((r) => r.question);
  if (missing.length) {
    return { ...base, summary: `I need a bit more information before I can plan: ${missing[0]}`, conflicts: [], missing_info: missing, actions: [] };
  }

  const conflicts = scenario.conflicts(c);
  const actions: PlanAction[] = [];
  const ids = { a: 0, r: 0 };
  const addedIdByKey = new Map<string, string>();
  const adjusted: string[] = [];
  let reschedules = 0;

  for (const tpl of scenario.templates) {
    const dueMs = dueFor(tpl, c);
    const title = text(tpl.title, c);
    const existing = existingFor(tpl, c);

    if (!existing) {
      if (tpl.when && !tpl.when(c, conflicts)) continue; // conditions gate ADDING a task; existing open tasks always follow time changes
      let due = dueMs;
      if (due !== null && due < now.getTime()) {
        // Never schedule a brand-new task in the past: use the next few minutes and say so.
        due = Math.ceil((now.getTime() + 5 * MIN) / MIN) * MIN;
        adjusted.push(title);
      }
      const dep = tpl.dependsOn;
      const depTask = dep ? c.tasks.find((t) => t.template_key === dep && t.status !== "cancelled") : undefined;
      actions.push({
        id: `a${++ids.a}`, type: "add_task", kind: tpl.kind, template_key: tpl.key, title,
        description: text(tpl.description, c), due_at: due === null ? null : new Date(due).toISOString(),
        ...(dep && addedIdByKey.has(dep) ? { depends_on_ref: addedIdByKey.get(dep) } : depTask ? { depends_on_task_id: depTask.id } : {}),
        rationale: tpl.rationale(c),
      });
      addedIdByKey.set(tpl.key, `a${ids.a}`);
      continue;
    }

    // Replan: only open tasks move, only to a time that is still in the future, and only if it actually differs.
    if (!OPEN.has(existing.status) || dueMs === null) continue;
    const current = existing.due_at ? new Date(existing.due_at).getTime() : null;
    if (current === dueMs || dueMs < now.getTime()) continue;
    reschedules++;
    actions.push({
      id: `r${++ids.r}`, type: "reschedule_task", task_id: existing.id, title: existing.title,
      new_due_at: new Date(dueMs).toISOString(), old_due_at: existing.due_at,
      rationale: `Your constraints changed (${constraintsUsed.join("; ")}), so this task's due time no longer fits.`,
    });
  }

  if (adjusted.length) base.assumptions.push(`These would already be due, so they are scheduled for the next few minutes: ${adjusted.join("; ")}.`);

  const summary = actions.length === 0
    ? "Your existing tasks already fit what I know. No changes needed."
    : reschedules > 0 && !actions.some((a) => a.type === "add_task")
      ? "Your circumstances changed, so I propose rescheduling the affected tasks. Nothing changes until you approve."
      : `Here is a plan for "${situation.title}". Nothing is saved until you approve.`;
  return { ...base, summary, conflicts, missing_info: [], actions };
}
