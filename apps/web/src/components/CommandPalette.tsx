import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarClock, CircleDot, FileText, FolderOpen, History, House, LayoutList, ListChecks, MessageCircle, MessagesSquare, Plus, Search, Share2 } from "lucide-react";
import type { EntityType, SearchResult } from "@homerelay/shared";
import { ApiError, api } from "../api";
import { makeSequencer, parseRoute } from "../logic";
import type { Route } from "../types";
import { Overlay } from "./Overlay";

interface Props {
  open: boolean;
  onClose: () => void;
  onNav: (r: Route) => void;
  onNewTask: () => void;
  onNewSituation: () => void;
  onAsk: (prompt?: string) => void;
}

interface Item { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void; keywords?: string }

const TYPE_ICON: Record<EntityType, ReactNode> = { situation: <CircleDot size={16} aria-hidden />, task: <ListChecks size={16} aria-hidden />, document: <FileText size={16} aria-hidden /> };
const TYPE_GROUP: Record<EntityType, string> = { situation: "Situations", task: "Tasks", document: "Documents" };

export function CommandPalette(p: Props) {
  return (
    <Overlay open={p.open} onClose={p.onClose} variant="palette" label="Search and commands">
      <Palette {...p} />
    </Overlay>
  );
}

/** One keyboard-first entry point: real records from /api/search plus the app's actions. Nothing here is a placeholder. */
function Palette({ onClose, onNav, onNewTask, onNewSituation, onAsk }: Omit<Props, "open">) {
  const [q, setQ] = useState(""); const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(makeSequencer()); const listRef = useRef<HTMLUListElement>(null);
  const go = (fn: () => void) => () => { onClose(); fn(); };

  const actions: Item[] = useMemo(() => [
    { id: "a-task", group: "Actions", label: "New task", hint: "Create a household task", icon: <Plus size={16} aria-hidden />, run: go(onNewTask), keywords: "add create todo reminder" },
    { id: "a-sit", group: "Actions", label: "New situation", hint: "A delivery, appointment or visit", icon: <Plus size={16} aria-hidden />, run: go(onNewSituation), keywords: "add create event" },
    { id: "a-ask", group: "Actions", label: "Ask HomeRelay", hint: "Open the assistant", icon: <MessageCircle size={16} aria-hidden />, run: go(() => onAsk()), keywords: "assistant chat question" },
    { id: "a-today", group: "Actions", label: "Today's priorities", hint: "HomeRelay Pulse on Home", icon: <CalendarClock size={16} aria-hidden />, run: go(() => onNav({ view: "dashboard" })), keywords: "pulse today attention due overdue" },
    { id: "a-map", group: "Go to", label: "Relay Map", hint: "Household knowledge map", icon: <Share2 size={16} aria-hidden />, run: go(() => onNav({ view: "map" })), keywords: "graph connections knowledge" },
    { id: "a-home", group: "Go to", label: "Home", icon: <House size={16} aria-hidden />, run: go(() => onNav({ view: "dashboard" })) },
    { id: "a-sits", group: "Go to", label: "Situations", icon: <LayoutList size={16} aria-hidden />, run: go(() => onNav({ view: "situations" })) },
    { id: "a-docs", group: "Go to", label: "Documents", icon: <FolderOpen size={16} aria-hidden />, run: go(() => onNav({ view: "documents" })), keywords: "upload files receipts warranty" },
    { id: "a-tasks", group: "Go to", label: "Tasks", icon: <ListChecks size={16} aria-hidden />, run: go(() => onNav({ view: "tasks" })) },
    { id: "a-act", group: "Go to", label: "Activity", icon: <History size={16} aria-hidden />, run: go(() => onNav({ view: "activity" })), keywords: "history log timeline" },
    { id: "a-asst", group: "Go to", label: "Assistant workspace", icon: <MessagesSquare size={16} aria-hidden />, run: go(() => onNav({ view: "assistant" })) },
  ], []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const text = q.trim();
    if (!text) { setResults([]); setLoading(false); setError(null); return; }
    setLoading(true);
    const h = setTimeout(async () => {
      const n = seq.current.next("search");
      try { const r = await api.search(text); if (seq.current.isLatest("search", n)) { setResults(r.results); setError(null); } }
      catch (e) { if (seq.current.isLatest("search", n)) { setResults([]); setError(e instanceof ApiError ? e.message : "Search failed."); } }
      finally { if (seq.current.isLatest("search", n)) setLoading(false); }
    }, 140);
    return () => clearTimeout(h);
  }, [q]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const actionHits = actions.filter((a) => !words.length || words.every((w) => `${a.label} ${a.hint ?? ""} ${a.keywords ?? ""}`.toLowerCase().includes(w)));
  const recordItems: Item[] = results.map((r) => ({
    id: r.key, group: TYPE_GROUP[r.type], label: r.title, hint: r.subtitle, icon: TYPE_ICON[r.type],
    run: go(() => onNav(parseRoute(r.route))),
  }));
  // records first when searching; actions first when empty
  const items = words.length ? [...recordItems, ...actionHits] : actionHits;
  useEffect(() => { setActive(0); }, [q, results.length]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
  };
  let lastGroup = "";
  const askText = q.trim();
  return (
    <div className="palette">
      <div className="palette-input">
        <Search size={18} aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search situations, tasks and documents, or run a command"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[active] ? `pal-${active}` : undefined} aria-label="Search and commands" aria-autocomplete="list" />
        {loading && <span className="spinner" role="status" aria-label="Searching" />}
        <kbd>Esc</kbd>
      </div>
      <ul id="palette-list" ref={listRef} className="palette-list" role="listbox" aria-label="Results">
        {items.map((it, i) => {
          const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
          return [
            head && <li key={`h-${head}`} className="palette-group" role="presentation">{head}</li>,
            <li key={it.id} id={`pal-${i}`} data-i={i} role="option" aria-selected={i === active} className={`palette-item ${i === active ? "on" : ""}`}
              onMouseMove={() => setActive(i)} onClick={it.run}>
              <span className="pi-icon">{it.icon}</span>
              <span className="pi-main"><span className="pi-label">{it.label}</span>{it.hint && <span className="pi-hint">{it.hint}</span>}</span>
            </li>,
          ];
        })}
        {words.length > 0 && !loading && !error && results.length === 0 && (
          <li className="palette-empty" role="presentation">No situations, tasks or documents match “{askText}”.</li>
        )}
        {error && <li className="palette-empty" role="alert">{error}</li>}
      </ul>
      <footer className="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open</span>
        {askText && <button className="link" onClick={go(() => onAsk(askText))}>Ask HomeRelay: “{askText.length > 40 ? `${askText.slice(0, 40)}…` : askText}”</button>}
      </footer>
    </div>
  );
}
