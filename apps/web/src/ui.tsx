import { createContext, useContext, type ReactNode } from "react";
import { CircleCheck, FileImage, FileText, FileType2, Home, Package, Users, Wrench } from "lucide-react";
import { formatClock, formatLocal } from "@homerelay/shared";
import type { Category, DocumentKind, SituationStatus, TaskStatus } from "@homerelay/shared";

export const TzContext = createContext("Asia/Kolkata");
export const useTz = () => useContext(TzContext);
export const useClock = () => { const tz = useTz(); return (iso?: string | null) => formatClock(iso, tz); };
export const useLocal = () => { const tz = useTz(); return (iso?: string | null) => formatLocal(iso, tz); };

const CAT: Record<Category, { label: string; Icon: typeof Home }> = {
  delivery: { label: "Delivery", Icon: Package },
  maintenance: { label: "Maintenance", Icon: Wrench },
  family_visit: { label: "Family visit", Icon: Users },
  general: { label: "General", Icon: Home },
};
export function CategoryIcon({ category, size = 18 }: { category: Category; size?: number }) {
  const { Icon, label } = CAT[category];
  return <span className="cat-icon" title={label}><Icon size={size} aria-hidden /><span className="sr-only">{label}</span></span>;
}
export const categoryLabel = (c: Category) => CAT[c].label;

const S_LABEL: Record<SituationStatus | TaskStatus, string> = {
  open: "Open", in_progress: "In progress", blocked: "Blocked", resolved: "Resolved",
  pending: "Pending", completed: "Completed", cancelled: "Cancelled",
};
export function StatusBadge({ status }: { status: SituationStatus | TaskStatus }) {
  return <span className={`badge st-${status}`}>{status === "resolved" || status === "completed" ? <CircleCheck size={12} aria-hidden /> : <i className="dot" aria-hidden />}{S_LABEL[status]}</span>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Banner({ kind = "error", children, onRetry }: { kind?: "error" | "info"; children: ReactNode; onRetry?: () => void }) {
  return (
    <div className={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onRetry && <button className="btn small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function relative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------- documents ----------

export function DocIcon({ kind, size = 18 }: { kind: DocumentKind; size?: number }) {
  const Icon = kind === "pdf" ? FileType2 : kind === "image" ? FileImage : FileText;
  return <span className={`doc-icon kind-${kind}`} aria-hidden><Icon size={size} /></span>;
}
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** Renders a stored snippet, highlighting the «matched» parts. Text only: never parsed as HTML. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <span className="snippet">{parts.map((p, i) => (p.startsWith("«") && p.endsWith("»") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</span>;
}
