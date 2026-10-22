import type { ActivityEvent, SituationDetail, Task } from "@homerelay/shared";
import { formatLocal } from "@homerelay/shared";

export const MAX_EXPORT_ROWS = 1000;
/** get_activity_log accepts at most 500 events per call. */
export const MAX_ACTIVITY_EXPORT = 500;

/**
 * Neutralise spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) is prefixed with an apostrophe
 * so Excel/Sheets treat it as text. Then CSV-quote the value.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface TaskRow { situation: string; task: Task }

export function tasksToCsv(rows: TaskRow[], tz: string): string {
  const header = ["situation", "task", "status", "kind", "due_local", "due_utc", "depends_on_task_id", "created_at"];
  const lines = rows.slice(0, MAX_EXPORT_ROWS).map(({ situation, task }) =>
    [situation, task.title, task.status, task.kind, task.due_at ? formatLocal(task.due_at, tz) : "", task.due_at ?? "", task.depends_on_task_id ?? "", task.created_at].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

/** Escape Markdown control characters in user-supplied text so a title cannot inject formatting or links. */
const md = (s: string) => s.replace(/[\\`*_{}\[\]<>#|~]/g, "\\$&").replace(/\r?\n/g, " ");

export function situationReport(d: SituationDetail, events: ActivityEvent[], tz: string, exportedAt: Date): string {
  const s = d.situation; const t = (iso: string | null) => (iso ? formatLocal(iso, tz) : "not set");
  const out: string[] = [
    `# ${md(s.title)}`, "",
    `- Type: ${d.workflow.scenario}${s.source === "demo" ? " (simulated)" : ""}`,
    `- Status: ${s.status}`,
    `- Expected: ${t(s.expected_at)}${s.constraints.window_end ? ` to ${t(s.constraints.window_end)}` : ""}`,
    `- You are available from: ${t(s.constraints.available_from ?? null)}`,
    `- Next: ${md(d.workflow.next_action)}`,
    `- Exported: ${formatLocal(exportedAt.toISOString(), tz)} (${tz})`, "",
    "## Tasks", "",
  ];
  if (!d.tasks.length) out.push("No tasks.");
  for (const k of d.tasks) out.push(`- [${k.status === "completed" ? "x" : " "}] ${md(k.title)} — ${k.status}${k.due_at ? `, due ${t(k.due_at)}` : ""}`);
  out.push("", "## Activity", "");
  for (const e of events.slice(0, MAX_ACTIVITY_EXPORT)) out.push(`- ${t(e.created_at)} · ${e.actor} · ${e.event_type.replace(/_/g, " ")}: ${md(e.description)}`);
  out.push("", "_Generated from HomeRelay's stored records. Task completion reflects what you confirmed; HomeRelay did not verify real-world events._", "");
  return out.join("\n");
}
