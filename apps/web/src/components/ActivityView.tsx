import { useMemo, useState } from "react";
import type { ActivityEvent } from "@homerelay/shared";
import { localYmd } from "@homerelay/shared";
import { useTz } from "../ui";
import { Timeline } from "./Timeline";

type Filter = "all" | "you" | "plans" | "tasks" | "documents" | "situations";
const FILTERS: { key: Filter; label: string; test: (e: ActivityEvent) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "you", label: "Your actions", test: (e) => e.actor === "user" },
  { key: "plans", label: "Plans & approvals", test: (e) => e.event_type.startsWith("plan_") },
  { key: "tasks", label: "Tasks", test: (e) => e.event_type.startsWith("task_") },
  { key: "documents", label: "Documents", test: (e) => e.event_type.startsWith("document_") },
  { key: "situations", label: "Situations", test: (e) => e.event_type.startsWith("situation_") || e.event_type === "constraints_updated" || e.event_type === "demo_reset" },
];

/** The recorded history, newest first, grouped by local day. Filters only narrow what is shown; nothing is summarised. */
export function ActivityView({ events, loading, onOpen }: { events: ActivityEvent[]; loading: boolean; onOpen: (route: string) => void }) {
  const tz = useTz();
  const [filter, setFilter] = useState<Filter>("all");
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const days = useMemo(() => {
    const groups: { key: string; label: string; items: ActivityEvent[] }[] = [];
    const ymd = (iso: string) => { const d = localYmd(iso, tz); return `${d.y}-${d.mo}-${d.d}`; };
    const today = ymd(new Date().toISOString()); const yesterday = ymd(new Date(Date.now() - 86_400_000).toISOString());
    for (const e of [...events].reverse().filter(test)) {
      const key = ymd(e.created_at);
      let g = groups.find((x) => x.key === key);
      if (!g) {
        const label = key === today ? "Today" : key === yesterday ? "Yesterday" : new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(e.created_at));
        g = { key, label, items: [] }; groups.push(g);
      }
      g.items.push(e);
    }
    return groups;
  }, [events, test, tz]);

  return (
    <div className="page ws">
      <header className="ws-head">
        <div><p className="eyebrow">History</p><h1>Activity</h1>
          <p className="lede">Every change HomeRelay has recorded, newest first. Real saved events, not a summary written afterwards. A confirmation you gave is recorded as yours, not as something HomeRelay verified.</p></div>
      </header>
      <div className="chips" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => <button key={f.key} className={`chip-btn ${filter === f.key ? "on" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} <span className="count">{events.filter(f.test).length}</span></button>)}
      </div>
      {!loading && events.length === 0 && <p className="empty-line">Nothing recorded yet. Changes appear here as soon as they are saved.</p>}
      {events.length > 0 && days.length === 0 && <p className="empty-line">No recorded events match this filter.</p>}
      <section className="activity-days" aria-label="All activity">
        {days.map((d) => (
          <div key={d.key} className="day-group">
            <h2 className="day-label">{d.label} <span className="count">{d.items.length}</span></h2>
            <div className="panel quiet"><Timeline events={d.items} onOpenRecord={onOpen} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}
