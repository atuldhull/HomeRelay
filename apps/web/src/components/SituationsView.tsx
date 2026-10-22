import { useMemo, useState } from "react";
import { Download, Play, Plus, Search } from "lucide-react";
import type { Category, DashboardResponse, SituationStatus } from "@homerelay/shared";
import { exportUrl } from "../api";
import { SituationCard } from "./SituationCard";

interface Props {
  data: DashboardResponse | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSimulate: () => void;
}

/** Every situation, filterable. Home shows what needs you; this is where you browse them all. */
export function SituationsView({ data, busy, onOpen, onNew, onSimulate }: Props) {
  const [q, setQ] = useState(""); const [status, setStatus] = useState<"all" | SituationStatus>("all"); const [type, setType] = useState<"all" | Category>("all");
  const all = data?.situations ?? [];
  const filtered = useMemo(() => all.filter((x) =>
    (status === "all" || x.status === status) && (type === "all" || x.category === type) && (!q.trim() || x.title.toLowerCase().includes(q.trim().toLowerCase()))), [all, q, status, type]);
  const open = filtered.filter((x) => x.status !== "resolved");
  const resolved = filtered.filter((x) => x.status === "resolved");
  const filtering = q.trim() !== "" || status !== "all" || type !== "all";

  return (
    <div className="page ws">
      <header className="ws-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Situations</h1>
          <p className="lede">{data ? `${data.openCount} open · ${all.length - data.openCount} recently resolved` : "Loading…"}</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={onSimulate} disabled={busy}><Play size={15} aria-hidden /> Simulate delivery event</button>
          <button className="btn primary" onClick={onNew}><Plus size={16} aria-hidden /> New situation</button>
        </div>
      </header>

      <form className="filters bar" role="search" aria-label="Filter situations" onSubmit={(e) => e.preventDefault()}>
        <div className="search"><Search size={15} aria-hidden /><label htmlFor="f-q" className="sr-only">Search by title</label><input id="f-q" type="search" placeholder="Search situations" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="sel"><span className="sr-only">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="all">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="resolved">Resolved</option></select></label>
        <label className="sel"><span className="sr-only">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}><option value="all">All types</option><option value="delivery">Delivery</option><option value="maintenance">Maintenance</option><option value="family_visit">Family visit</option><option value="general">Other</option></select></label>
        {filtering && <button type="button" className="btn ghost small" onClick={() => { setQ(""); setStatus("all"); setType("all"); }}>Clear</button>}
        <span className="spacer" />
        <a className="btn ghost small" href={exportUrl.tasksCsv} download><Download size={14} aria-hidden /> Open tasks (CSV)</a>
      </form>

      {data && all.length === 0 && <p className="empty-line">No situations yet. Create one, or start with the simulated delivery.</p>}
      {all.length > 0 && filtered.length === 0 && <p className="muted" role="status">No situations match these filters.</p>}
      {open.length > 0 && <ul className="grid" aria-label="Open situations">{open.map((x) => <SituationCard key={x.id} s={x} onOpen={() => onOpen(x.id)} />)}</ul>}
      {resolved.length > 0 && (
        <>
          <h2 className="section-title">{filtering ? "Resolved" : "Recently resolved"}</h2>
          <ul className="grid" aria-label="Resolved situations">{resolved.map((x) => <SituationCard key={x.id} s={x} onOpen={() => onOpen(x.id)} />)}</ul>
        </>
      )}
    </div>
  );
}
