import { ArrowUpRight, Link2 } from "lucide-react";
import type { DocumentHit } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import { DocIcon, Snippet, formatBytes } from "../ui";

interface Props { hits: DocumentHit[]; onOpen: (id: string) => void; compact?: boolean; label?: string }

/** Real stored documents, with the matched excerpt and page when the search found one. */
export function DocResults({ hits, onOpen, compact, label = "Documents" }: Props) {
  if (!hits.length) return null;
  return (
    <ul className={`doc-results ${compact ? "compact" : ""}`} aria-label={label}>
      {hits.map((h) => (
        <li key={h.document.id}>
          <button className={`doc-hit kind-${h.document.kind}`} onClick={() => onOpen(h.document.id)} aria-label={`Open document: ${h.document.title}`}>
            <DocIcon kind={h.document.kind} />
            <span className="dh-body">
              <span className="dh-title">{h.document.title}</span>
              <span className="dh-meta">
                {DOCUMENT_CATEGORY_LABEL[h.document.category]} · {formatBytes(h.document.size_bytes)}
                {h.page ? <> · page {h.page}</> : null}
                {h.document.linked_situations.length > 0 && <> · <Link2 size={12} aria-hidden /> {h.document.linked_situations.length}</>}
              </span>
              {h.snippet && <span className="dh-snip"><Snippet text={h.snippet} /></span>}
              {!compact && h.matched.length > 0 && <span className="dh-why">Matched in {h.matched.join(" and ")}</span>}
            </span>
            <ArrowUpRight size={16} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
