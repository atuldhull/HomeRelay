import { ArrowUpRight, CircleDot, FileText, ListChecks } from "lucide-react";
import type { EntityRef } from "@homerelay/shared";

const ICON = { situation: CircleDot, task: ListChecks, document: FileText } as const;

/** The stored records an assistant reply refers to. Each opens the real record by its id-based route. */
export function EntityResults({ items, onOpen }: { items: EntityRef[]; onOpen: (route: string) => void }) {
  return (
    <ul className="entity-results" aria-label="Records in this answer">
      {items.map((e) => {
        const Icon = ICON[e.type];
        return (
          <li key={e.key}>
            <button className={`entity type-${e.type}`} onClick={() => onOpen(e.route)} aria-label={`Open ${e.type}: ${e.title}`}>
              <Icon size={15} aria-hidden />
              <span className="ent-main"><strong>{e.title}</strong><span className="muted">{e.subtitle}</span></span>
              <ArrowUpRight size={14} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
