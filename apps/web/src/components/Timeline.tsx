import { CalendarClock, CheckCheck, CircleCheck, CirclePlus, ClipboardList, FilePen, FilePlus2, FileX2, Flag, Hourglass, Link2, PencilLine, RotateCcw, ThumbsDown, ThumbsUp, Timer, Unlink, type LucideIcon } from "lucide-react";
import type { ActivityEvent } from "@homerelay/shared";
import { relative, useClock, useLocal } from "../ui";

interface Meta { label: string; Icon: LucideIcon; tone: "neutral" | "jade" | "copper" | "good" | "bad" }
const META: Record<string, Meta> = {
  situation_created: { label: "Created", Icon: Flag, tone: "neutral" },
  situation_updated: { label: "Changed", Icon: PencilLine, tone: "copper" },
  constraints_updated: { label: "Availability", Icon: Timer, tone: "copper" },
  plan_proposed: { label: "Proposed", Icon: ClipboardList, tone: "jade" },
  plan_approved: { label: "Approved", Icon: ThumbsUp, tone: "good" },
  plan_rejected: { label: "Rejected", Icon: ThumbsDown, tone: "bad" },
  plan_superseded: { label: "Replaced", Icon: RotateCcw, tone: "neutral" },
  task_created: { label: "Task added", Icon: CirclePlus, tone: "jade" },
  task_rescheduled: { label: "Rescheduled", Icon: CalendarClock, tone: "copper" },
  task_completed: { label: "Completed", Icon: CircleCheck, tone: "good" },
  task_status_changed: { label: "Status", Icon: Hourglass, tone: "neutral" },
  situation_resolved: { label: "Resolved", Icon: CheckCheck, tone: "good" },
  demo_reset: { label: "Reset", Icon: RotateCcw, tone: "neutral" },
  document_added: { label: "Document added", Icon: FilePlus2, tone: "jade" },
  document_linked: { label: "Document attached", Icon: Link2, tone: "jade" },
  document_unlinked: { label: "Document detached", Icon: Unlink, tone: "neutral" },
  document_updated: { label: "Document edited", Icon: FilePen, tone: "neutral" },
  document_deleted: { label: "Document deleted", Icon: FileX2, tone: "bad" },
};
const FALLBACK: Meta = { label: "Event", Icon: Flag, tone: "neutral" };
export const eventMeta = (type: string): Meta => META[type] ?? { ...FALLBACK, label: type.replace(/_/g, " ") };

/** Who actually did it, without implying more than the record shows. Nothing here is ever an external service. */
export function actorLabel(e: ActivityEvent): string {
  if (e.actor === "user") return "You";
  if (e.actor === "system") return "System";
  if (e.event_type === "plan_proposed") return "Agent proposal";
  if (e.metadata && typeof e.metadata === "object" && "proposal_id" in e.metadata) return "Applied from your approved plan";
  return "Agent";
}

/** The record an event is about, by id. Deleted records are not linked (their page no longer exists). */
export function eventTarget(e: ActivityEvent): { kind: "task" | "document" | "situation"; id: string; route: string } | null {
  const docId = typeof e.metadata?.document_id === "string" ? e.metadata.document_id : null;
  if (docId && e.event_type !== "document_deleted" && !/^Document deleted/.test(e.description)) return { kind: "document", id: docId, route: `#/document/${docId}` };
  if (e.task_id && e.event_type !== "task_deleted") return { kind: "task", id: e.task_id, route: `#/task/${e.task_id}` };
  if (e.situation_id) return { kind: "situation", id: e.situation_id, route: `#/situation/${e.situation_id}` };
  return null;
}
const OPEN_LABEL = { task: "Open task", document: "Open document", situation: "Open situation" } as const;

interface Props {
  events: ActivityEvent[];
  /** Newest first (activity page) or chronological (situation page). */
  newestFirst?: boolean;
  onOpenSituation?: (id: string) => void;
  /** Opens the affected record (task, document or situation) by route; preferred over onOpenSituation. */
  onOpenRecord?: (route: string) => void;
  max?: number;
  compact?: boolean;
}

/** A history of real recorded decisions and actions, in stored order. */
export function Timeline({ events, newestFirst, onOpenSituation, onOpenRecord, max, compact }: Props) {
  const clock = useClock(); const local = useLocal();
  const rows = (newestFirst ? [...events].reverse() : events).slice(0, max ?? events.length);
  return (
    <ol className={`timeline ${compact ? "compact" : ""}`}>
      {rows.map((e) => {
        const { label, Icon, tone } = eventMeta(e.event_type);
        const target = eventTarget(e);
        const open = onOpenRecord && target ? () => onOpenRecord(target.route) : onOpenSituation && e.situation_id ? () => onOpenSituation(e.situation_id!) : null;
        return (
          <li key={e.id} className={`tl tone-${tone} actor-${e.actor}`}>
            <span className="tl-dot" aria-hidden><Icon size={14} /></span>
            <div className="tl-body">
              <div className="tl-top">
                <span className="tl-label">{label}</span>
                <time dateTime={e.created_at} title={local(e.created_at)}>{clock(e.created_at)}</time>
              </div>
              <p className="tl-desc">{e.description}</p>
              <p className="tl-who"><span className={`actor actor-${e.actor}`}>{actorLabel(e)}</span> · {relative(e.created_at)}
                {open && <> · <button className="link" onClick={open}>{onOpenRecord && target ? OPEN_LABEL[target.kind] : "Open"}</button></>}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
