import { useEffect, useRef } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

export interface ToastItem { id: number; kind: "success" | "error" | "info"; text: string; leaving?: boolean }

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;
/** Errors stay long enough to read and can be dismissed; successes are brief. */
const LIFETIME = { success: 4500, info: 5000, error: 9000 } as const;

function Toast({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => { const h = setTimeout(() => onDismiss(t.id), LIFETIME[t.kind]); return () => clearTimeout(h); }, [t.id, t.kind, onDismiss]);
  const Icon = ICON[t.kind];
  return (
    <li className={`toast ${t.kind} ${t.leaving ? "leaving" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden />
      <span>{t.text}</span>
      <button className="icon-btn" onClick={() => onDismiss(t.id)} aria-label="Dismiss message"><X size={14} /></button>
    </li>
  );
}

type PopoverEl = HTMLUListElement & { showPopover?: () => void; hidePopover?: () => void };

/**
 * A native modal <dialog> (the assistant drawer, the new-situation sheet) lives in the browser's top layer, above any z-index.
 * The toast region is therefore a manual popover, which is also top layer, and is re-shown whenever a toast arrives so it
 * stacks above an open dialog. Without this, a "saved" message would be hidden behind a full-screen drawer on a phone.
 */
export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  const ref = useRef<PopoverEl>(null);
  const newest = items.length ? items[items.length - 1].id : 0;
  useEffect(() => {
    const el = ref.current;
    if (!el?.showPopover) return;
    try {
      if (el.matches(":popover-open")) el.hidePopover?.();
      if (items.length) el.showPopover();
    } catch { /* popover unsupported or already in the requested state: the fixed-position fallback still shows toasts */ }
  }, [newest, items.length]);
  return <ul ref={ref} popover="manual" className="toast-region" aria-label="Notifications">{items.map((t) => <Toast key={t.id} t={t} onDismiss={onDismiss} />)}</ul>;
}
