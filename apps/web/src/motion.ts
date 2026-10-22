import { useEffect } from "react";

/**
 * Scroll reveal: elements with .reveal-on-scroll fade up once when they first enter the viewport.
 * One IntersectionObserver per page, disconnected on navigation; nothing runs under reduced motion
 * (the CSS shows them immediately), and content is never hidden if the observer is unavailable.
 */
export function useRevealOnScroll(dep: unknown) {
  useEffect(() => {
    const els = () => [...document.querySelectorAll<HTMLElement>(".reveal-on-scroll:not(.in)")];
    if (typeof IntersectionObserver === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      els().forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    // pages render their sections after data arrives: watch for new ones until the next navigation
    const scan = () => els().forEach((e) => { if (!e.dataset.observed) { e.dataset.observed = "1"; io.observe(e); } });
    scan();
    const mo = new MutationObserver(scan);
    const main = document.getElementById("main");
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, [dep]);
}
