import { useEffect, useRef, useState, type ReactNode } from "react";

const ANIM_MS = 260;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let locks = 0;
function lockScroll(on: boolean) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  document.documentElement.classList.toggle("scroll-locked", locks > 0);
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** "drawer" slides in from the right (full screen on phones); "sheet" is a centred panel (full screen on phones). */
  variant: "drawer" | "sheet" | "palette" | "bottom";
  label: string;
  children: ReactNode;
}

/**
 * One accessible overlay for the whole app, built on the native <dialog>: focus is trapped, the page behind is inert,
 * Escape closes, and focus returns to whatever opened it. Children mount only while open, so closed overlays leave
 * nothing in the page. Motion is a short transform/opacity transition (instant under reduced motion).
 *
 * Closing order matters: play the exit transition, call dialog.close() (which restores focus to the opener), THEN unmount.
 */
export function Overlay({ open, onClose, variant, label, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  const release = () => {
    const d = ref.current;
    if (d?.open) d.close();
    if (locked.current) { locked.current = false; lockScroll(false); }
  };

  // open -> mount, showModal, then animate in on the next frame
  useEffect(() => {
    if (!open) return;
    setMounted(true);
    const d = ref.current;
    if (d && !d.open) { d.showModal(); if (!locked.current) { locked.current = true; lockScroll(true); } }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open, mounted]);

  // close -> animate out, close the dialog (focus returns), then unmount
  useEffect(() => {
    if (open || !mounted) return;
    setShown(false);
    const t = setTimeout(() => { release(); setMounted(false); }, reducedMotion() ? 0 : ANIM_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => () => { if (locked.current) { locked.current = false; lockScroll(false); } }, []);

  if (!mounted) return null;
  return (
    <dialog
      ref={ref}
      className={`overlay ${variant} ${shown ? "is-open" : ""}`}
      aria-label={label}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {children}
    </dialog>
  );
}
