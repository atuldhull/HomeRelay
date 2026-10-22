import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Ellipsis, FolderOpen, History, House, LayoutList, ListChecks, MessageCircle, MessagesSquare, Plus, Search, Share2, X } from "lucide-react";
import type { Health } from "../api";
import type { Route } from "../types";
import { Overlay } from "./Overlay";

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#0e3b31" />
      <path d="M7.5 15.5 16 8l8.5 7.5V24a1 1 0 0 1-1 1h-4.5v-6h-6v6H8.5a1 1 0 0 1-1-1z" fill="#fcfaf4" />
      <circle cx="24" cy="8.5" r="3.2" fill="#e08a45" />
    </svg>
  );
}

type View = Route["view"];
interface NavItem { view: View; label: string; Icon: typeof House; also?: View[]; group: "Household" | "Explore" | "Assist"; phone: boolean }
const NAV: NavItem[] = [
  { view: "dashboard", label: "Home", Icon: House, group: "Household", phone: true },
  { view: "situations", label: "Situations", Icon: LayoutList, also: ["situation"], group: "Household", phone: false },
  { view: "tasks", label: "Tasks", Icon: ListChecks, also: ["task"], group: "Household", phone: true },
  { view: "documents", label: "Documents", Icon: FolderOpen, also: ["document"], group: "Household", phone: true },
  { view: "map", label: "Map", Icon: Share2, group: "Explore", phone: false },
  { view: "activity", label: "Activity", Icon: History, group: "Explore", phone: false },
  { view: "assistant", label: "Assistant", Icon: MessagesSquare, group: "Assist", phone: true },
];

export interface Crumb { label: string; route?: Route }

interface Props {
  route: Route;
  health: Health | null;
  badges: Partial<Record<View, number>>;
  crumbs: Crumb[];
  onNav: (r: Route) => void;
  onAsk: () => void;
  onNew: () => void;
  onNewTask: () => void;
  onSearch: () => void;
  children: ReactNode;
}

/** Application frame: a grouped rail (desktop), icon rail (tablet) or bottom bar + More sheet (phone), and a slim top bar. */
export function AppShell({ route, health, badges, crumbs, onNav, onAsk, onNew, onNewTask, onSearch, children }: Props) {
  const up = health?.mcp === "up";
  const [more, setMore] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const active = (n: NavItem) => route.view === n.view || (n.also ?? []).includes(route.view);
  const statusText = health ? (up ? "Tools connected" : "Tools offline") : "Checking";
  const statusTip = health
    ? `${up ? "The MCP tool server is reachable" : "The MCP tool server is not reachable; changes will fail until it is back"} · ${health.mode === "llm" ? "LLM agent" : "rules agent (no API key)"}`
    : "Checking the tool server";
  const go = (r: Route) => { setMore(false); onNav(r); };
  const navButton = (n: NavItem, cls = "") => (
    <button className={`${active(n) ? "active" : ""} ${cls}`} aria-current={active(n) ? "page" : undefined} onClick={() => go({ view: n.view } as Route)} aria-label={n.label}>
      <n.Icon size={18} aria-hidden /><span className="lbl">{n.label}</span>
      {!!badges[n.view] && <span className="count-dot" aria-label={`${badges[n.view]} need attention`}>{badges[n.view]}</span>}
    </button>
  );
  const moreActive = NAV.some((n) => !n.phone && active(n));

  return (
    <div className="app">
      <nav className="rail" aria-label="Primary">
        <button className="brand" onClick={() => onNav({ view: "dashboard" })} aria-label="HomeRelay home"><Logo /><span className="brand-name">HomeRelay</span></button>
        {(["Household", "Explore", "Assist"] as const).map((g) => (
          <div key={g} className="rail-group">
            <span className="rail-group-label lbl" aria-hidden>{g === "Assist" ? "Assistant" : g}</span>
            <ul className="rail-nav">
              {NAV.filter((n) => n.group === g).map((n) => <li key={n.view} className={n.phone ? "on-phone" : "off-phone"}>{navButton(n)}</li>)}
              {g === "Assist" && (
                <li className="phone-only">
                  <button className={moreActive ? "active" : ""} onClick={() => setMore(true)} aria-label="More" aria-haspopup="dialog" aria-expanded={more}>
                    <Ellipsis size={18} aria-hidden /><span className="lbl">More</span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        ))}
        <div className="rail-foot">
          <button className="rail-create" onClick={onNew} aria-label="New situation"><Plus size={16} aria-hidden /><span className="lbl">New situation</span></button>
          <button className="rail-create" onClick={onNewTask} aria-label="New household task"><Plus size={16} aria-hidden /><span className="lbl">New task</span></button>
          <span className={`sys ${health ? (up ? "up" : "down") : ""}`} role="status" title={statusTip} tabIndex={0} aria-label={`${statusText}. ${statusTip}`}>
            <i aria-hidden /><span className="lbl">{statusText}</span>
          </span>
        </div>
      </nav>

      <div className="app-main">
        <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <button className="topbar-brand" onClick={() => onNav({ view: "dashboard" })} aria-label="HomeRelay home"><Logo size={26} /></button>
          <nav className="crumbs" aria-label="Breadcrumb">
            <ol>
              {crumbs.map((c, i) => (
                <li key={`${c.label}-${i}`}>
                  {i > 0 && <ChevronRight size={14} aria-hidden />}
                  {c.route && i < crumbs.length - 1
                    ? <button className="crumb" onClick={() => onNav(c.route!)}>{c.label}</button>
                    : <span className="crumb current" aria-current="page">{c.label}</span>}
                </li>
              ))}
            </ol>
          </nav>
          <div className="topbar-actions">
            <button className="tb-search" onClick={onSearch} aria-label="Search and commands" title="Search and commands (Ctrl+K)">
              <Search size={16} aria-hidden /><span className="lbl">Search</span><kbd className="lbl">Ctrl K</kbd>
            </button>
            {route.view !== "assistant" && (
              <button className="btn primary small tb-ask" onClick={onAsk} aria-label="Ask HomeRelay" title="Ask HomeRelay">
                <MessageCircle size={15} aria-hidden /><span className="lbl">Ask</span>
              </button>
            )}
          </div>
        </header>
        {children}
      </div>

      <Overlay open={more} onClose={() => setMore(false)} variant="bottom" label="More">
        <div className="more-sheet">
          <header><strong>More</strong><button className="icon-btn" onClick={() => setMore(false)} aria-label="Close"><X size={18} /></button></header>
          <ul>
            {NAV.filter((n) => !n.phone).map((n) => <li key={n.view}>{navButton(n, "more-item")}</li>)}
            <li><button className="more-item" onClick={() => { setMore(false); onSearch(); }}><Search size={18} aria-hidden /><span>Search everything</span></button></li>
            <li><button className="more-item" onClick={() => { setMore(false); onNewTask(); }}><Plus size={18} aria-hidden /><span>New task</span></button></li>
            <li><button className="more-item" onClick={() => { setMore(false); onNew(); }}><Plus size={18} aria-hidden /><span>New situation</span></button></li>
          </ul>
          <p className={`sys-line ${up ? "up" : "down"}`}>{statusText} · {health?.mode === "llm" ? "LLM agent" : "Rules agent"}</p>
        </div>
      </Overlay>
    </div>
  );
}
