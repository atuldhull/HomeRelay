import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Expand, FileText, List, ListChecks, Map as MapIcon, Minus, Plus, Search, Share2, TriangleAlert } from "lucide-react";
import type { Connections, EntityType, GraphEdge, GraphNode, HouseholdGraph, TaskStatus } from "@homerelay/shared";
import { ApiError, api } from "../api";
import { makeSequencer, parseRoute } from "../logic";
import type { Route } from "../types";
import { StatusBadge, useClock } from "../ui";

/**
 * Relay Map: the household knowledge map. Nodes and edges come from /api/map, which reads the stored relationships
 * (task -> situation, task -> prerequisite, document -> situation, document -> task). The layout is deterministic
 * (no physics simulation, nothing animating while idle): each situation is a hub with its tasks and documents around it.
 */

interface P { x: number; y: number }
interface Placed extends GraphNode { x: number; y: number; cluster: string }
interface Cluster { key: string; label: string; x: number; y: number; r: number }

const TYPE_LABEL: Record<EntityType, string> = { situation: "Situation", task: "Task", document: "Document" };
const REL_LABEL: Record<GraphEdge["relation"], string> = { part_of: "part of", depends_on: "depends on", attached_to: "attached to" };
const REL_SENTENCE: Record<GraphEdge["relation"], (a: string, b: string) => string> = {
  part_of: (a, b) => `"${a}" is a task in "${b}"`,
  depends_on: (a, b) => `"${a}" must happen after "${b}"`,
  attached_to: (a, b) => `"${a}" is attached to "${b}"`,
};
const REL_WHY: Record<GraphEdge["relation"], string> = {
  part_of: "Stored on the task (its situation). Completing the situation's tasks moves the situation towards resolution.",
  depends_on: "Stored as the task's prerequisite. The first task cannot be marked done until the second is finished or cancelled.",
  attached_to: "Stored as a document link. Detach it from either record's page; neither record is deleted.",
};
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Places every node. Pure: the same graph always gives the same picture. */
export function layout(g: HouseholdGraph): { nodes: Placed[]; clusters: Cluster[] } {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]));
  const owner = new Map<string, string>(); // node key -> cluster key
  const hubs = g.nodes.filter((n) => n.type === "situation");
  for (const h of hubs) owner.set(h.key, h.key);
  for (const e of g.edges) if (e.relation === "part_of") owner.set(e.source, e.target);
  // documents join the cluster of the first situation or task they are attached to
  for (const e of g.edges) {
    if (e.relation !== "attached_to" || owner.has(e.source)) continue;
    const t = byKey.get(e.target); if (!t) continue;
    const c = t.type === "situation" ? t.key : owner.get(t.key);
    if (c) owner.set(e.source, c);
  }
  for (const n of g.nodes) if (!owner.has(n.key)) owner.set(n.key, n.type === "task" ? "_household" : n.type === "document" ? "_docs" : n.key);

  const groups = new Map<string, GraphNode[]>();
  for (const n of g.nodes) { const k = owner.get(n.key)!; (groups.get(k) ?? groups.set(k, []).get(k)!).push(n); }
  const order = [...hubs.map((h) => h.key), "_household", "_docs"].filter((k) => groups.has(k));
  const sizes = order.map((k) => {
    const members = groups.get(k)!.filter((n) => n.key !== k).length;
    return members <= 8 ? 150 : members <= 20 ? 230 : 300;
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
  const cell = Math.max(...sizes, 150) * 2 + 60;
  const clusters: Cluster[] = []; const placed: Placed[] = [];
  order.forEach((k, i) => {
    const cx = (i % cols) * cell + cell / 2; const cy = Math.floor(i / cols) * cell + cell / 2;
    const hub = byKey.get(k);
    const label = hub ? hub.title : k === "_household" ? "Household tasks" : "Unfiled documents";
    clusters.push({ key: k, label, x: cx, y: cy, r: sizes[i] });
    if (hub) placed.push({ ...hub, x: cx, y: cy, cluster: k });
    const sats = groups.get(k)!.filter((n) => n.key !== k).sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title) : a.type === "task" ? -1 : 1));
    // concentric rings, more nodes on outer rings; a virtual cluster starts on the first ring too
    let ring = 0; let idx = 0;
    while (idx < sats.length) {
      const radius = 110 + ring * 80; const cap = Math.max(6, Math.floor((2 * Math.PI * radius) / 70));
      const slice = sats.slice(idx, idx + cap);
      slice.forEach((n, j) => {
        const a = (j / slice.length) * Math.PI * 2 - Math.PI / 2 + ring * 0.35;
        placed.push({ ...n, x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, cluster: k });
      });
      idx += cap; ring++;
    }
  });
  return { nodes: placed, clusters };
}

function bounds(ns: P[], clusters: Cluster[] = []) {
  if (!ns.length) return { x: 0, y: 0, w: 800, h: 600 };
  const pts = [...ns, ...clusters.flatMap((c) => [{ x: c.x - c.r, y: c.y - c.r }, { x: c.x + c.r, y: c.y + c.r }])];
  const xs = pts.map((n) => n.x); const ys = pts.map((n) => n.y);
  const pad = 40;
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

interface Props { version: number; onNav: (r: Route) => void; focusKey?: string | null }

export function RelayMap({ version, onNav, focusKey }: Props) {
  const clock = useClock();
  const [graph, setGraph] = useState<HouseholdGraph | null>(null); const [error, setError] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState(false); const [includeResolved, setIncludeResolved] = useState(false);
  const [types, setTypes] = useState<Record<EntityType, boolean>>({ situation: true, task: true, document: true });
  const [q, setQ] = useState(""); const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(focusKey ?? null);
  const [edge, setEdge] = useState<string | null>(null);
  const [conn, setConn] = useState<Connections | null>(null); const [connErr, setConnErr] = useState<string | null>(null);
  const [listView, setListView] = useState(false);
  const [vb, setVb] = useState({ x: 0, y: 0, w: 800, h: 600 });
  const svgRef = useRef<SVGSVGElement>(null); const detailRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; vb: typeof vb; moved: boolean } | null>(null);
  const anim = useRef<number | null>(null);
  const seq = useRef(makeSequencer());
  const vbRef = useRef(vb); vbRef.current = vb;

  const load = useCallback(async () => {
    const n = seq.current.next("map");
    try { const g = await api.map({ includeDone, includeResolved }); if (seq.current.isLatest("map", n)) { setGraph(g); setError(null); } }
    catch (e) { if (seq.current.isLatest("map", n)) setError(e instanceof ApiError ? e.message : "Could not load the map."); }
  }, [includeDone, includeResolved]);
  useEffect(() => { void load(); }, [load, version]);

  // visible subgraph: type filters only remove nodes; edges need both ends visible
  const view = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes.filter((n) => types[n.type]);
    const keys = new Set(nodes.map((n) => n.key));
    return { ...graph, nodes, edges: graph.edges.filter((e) => keys.has(e.source) && keys.has(e.target)) };
  }, [graph, types]);
  const placed = useMemo(() => (view ? layout(view) : null), [view]);
  const pos = useMemo(() => new Map((placed?.nodes ?? []).map((n) => [n.key, n])), [placed]);
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of view?.edges ?? []) { (m.get(e.source) ?? m.set(e.source, new Set()).get(e.source)!).add(e.target); (m.get(e.target) ?? m.set(e.target, new Set()).get(e.target)!).add(e.source); }
    return m;
  }, [view]);

  const animateTo = useCallback((target: typeof vb) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    if (reduced()) { setVb(target); return; }
    const from = { ...vbRef.current }; const t0 = performance.now(); const dur = 260;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
      setVb({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (k < 1) anim.current = requestAnimationFrame(step); else anim.current = null;
    };
    anim.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => { if (anim.current) cancelAnimationFrame(anim.current); }, []);
  const fit = useCallback(() => { if (placed) animateTo(bounds(placed.nodes, placed.clusters)); }, [placed, animateTo]);
  const fitted = useRef(false);
  useEffect(() => { if (placed && !fitted.current) { setVb(bounds(placed.nodes, placed.clusters)); fitted.current = true; } }, [placed]);

  // selected node -> its stored connections
  useEffect(() => {
    if (!selected) { setConn(null); return; }
    const [type, id] = [selected.split(":")[0] as EntityType, selected.slice(selected.indexOf(":") + 1)];
    const n = seq.current.next("conn"); setConnErr(null);
    api.connections(type, id).then((c) => { if (seq.current.isLatest("conn", n)) setConn(c); })
      .catch((e) => { if (seq.current.isLatest("conn", n)) { setConn(null); setConnErr(e instanceof ApiError ? e.message : "Could not load its connections."); } });
  }, [selected, version]);
  // a record that disappeared (deleted, finished and filtered out) is deselected rather than left dangling
  useEffect(() => { if (selected && graph && !graph.nodes.some((n) => n.key === selected)) setSelected(null); }, [graph, selected]);

  const select = (key: string, center = false) => {
    setEdge(null);
    setSelected(key);
    const p = pos.get(key);
    if (center && p) animateTo({ x: p.x - vbRef.current.w / 2, y: p.y - vbRef.current.h / 2, w: vbRef.current.w, h: vbRef.current.h });
    if (window.matchMedia?.("(max-width: 1100px)").matches) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "nearest" }), 60);
  };
  const open = (n: { route: string }) => onNav(parseRoute(n.route));

  // zoom / pan
  const zoom = (factor: number, at?: P) => {
    const c = at ?? { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
    const w = Math.min(Math.max(vb.w * factor, 200), 12000); const h = (vb.h / vb.w) * w;
    const target = { x: c.x - ((c.x - vb.x) / vb.w) * w, y: c.y - ((c.y - vb.y) / vb.h) * h, w, h };
    if (at) setVb(target); else animateTo(target);
  };
  const toSvg = (cx: number, cy: number): P => {
    const r = svgRef.current!.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height);
    const ox = (r.width * s - vb.w) / 2; const oy = (r.height * s - vb.h) / 2;
    return { x: vb.x - ox + (cx - r.left) * s, y: vb.y - oy + (cy - r.top) * s };
  };
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, toSvg(e.clientX, e.clientY)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const query = q.trim().toLowerCase();
  const matches = useMemo(() => new Set(query ? (view?.nodes ?? []).filter((n) => n.title.toLowerCase().includes(query)).map((n) => n.key) : []), [query, view]);
  const focus = hover ?? selected;
  const lit = focus ? new Set([focus, ...(neighbours.get(focus) ?? [])]) : null;
  const dim = (k: string) => (query ? !matches.has(k) : lit ? !lit.has(k) : false);
  const counts = { situation: graph?.nodes.filter((n) => n.type === "situation").length ?? 0, task: graph?.nodes.filter((n) => n.type === "task").length ?? 0, document: graph?.nodes.filter((n) => n.type === "document").length ?? 0 };
  const sel = selected ? pos.get(selected) ?? graph?.nodes.find((n) => n.key === selected) : null;
  const selEdge = (() => {
    const e = edge ? view?.edges.find((x) => x.id === edge) : undefined;
    const a = e ? pos.get(e.source) : undefined; const b = e ? pos.get(e.target) : undefined;
    return e && a && b ? { e, a, b } : null;
  })();

  return (
    <div className="page ws map-page">
      <header className="ws-head">
        <div><p className="eyebrow">Relay Map</p><h1>Your household knowledge map</h1>
          <p className="lede">Every situation, task and document, and how they are connected. The lines are the links you stored: tasks in a situation, prerequisites, and attached documents.</p></div>
        <div className="head-actions">
          <button className={`btn ${listView ? "primary" : ""}`} onClick={() => setListView((v) => !v)} aria-pressed={listView}>{listView ? <MapIcon size={16} aria-hidden /> : <List size={16} aria-hidden />} {listView ? "Map view" : "List view"}</button>
        </div>
      </header>

      <div className="filters bar map-filters" role="group" aria-label="Map filters">
        <label className="search"><Search size={16} aria-hidden /><span className="sr-only">Find on the map</span>
          <input type="search" placeholder="Find on the map" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches.size) { e.preventDefault(); select([...matches][0], true); } }} /></label>
        {(["situation", "task", "document"] as EntityType[]).map((t) => (
          <button key={t} type="button" className={`chip-btn type-${t} ${types[t] ? "on" : ""}`} aria-pressed={types[t]} onClick={() => setTypes((x) => ({ ...x, [t]: !x[t] }))}>
            <span className={`dot type-${t}`} aria-hidden /> {TYPE_LABEL[t]}s <span className="count">{counts[t]}</span>
          </button>
        ))}
        <label className="check"><input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} /> Finished tasks</label>
        <label className="check"><input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} /> Resolved situations</label>
        {query && <span className="result-count" role="status">{matches.size} match{matches.size === 1 ? "" : "es"}{matches.size ? " · Enter to select" : ""}</span>}
      </div>

      {error && <p className="banner error" role="alert">{error} <button className="link" onClick={() => void load()}>Retry</button></p>}
      {graph?.truncated && <p className="note"><TriangleAlert size={16} aria-hidden /> Showing the {graph.nodes.length} most connected records. Use the filters to narrow the map.</p>}
      {graph && graph.nodes.length === 0 && (
        <div className="empty map-empty">
          <Share2 size={36} aria-hidden />
          <div className="empty-copy">
            <h2>Nothing to map yet</h2>
            <p>The map fills in from real records: add a situation, a task or a document, then connect them (attach a receipt to a repair, make one task wait for another). Nothing here is sample data.</p>
            <div className="empty-actions"><button className="btn primary" onClick={() => onNav({ view: "tasks" })}><ListChecks size={16} aria-hidden /> Go to Tasks</button><button className="btn" onClick={() => onNav({ view: "documents" })}><FileText size={16} aria-hidden /> Go to Documents</button></div>
          </div>
        </div>
      )}

      {graph && graph.nodes.length > 0 && placed && (
        <div className="map-layout">
          {!listView ? (
            <div className="map-canvas">
              <div className="map-tools" role="group" aria-label="Zoom">
                <button className="icon-btn" onClick={() => zoom(1 / 1.3)} aria-label="Zoom in"><Plus size={16} /></button>
                <button className="icon-btn" onClick={() => zoom(1.3)} aria-label="Zoom out"><Minus size={16} /></button>
                <button className="icon-btn" onClick={fit} aria-label="Fit to screen"><Expand size={16} /></button>
              </div>
              <svg ref={svgRef} className={`relay-map ${focus || query ? "has-focus" : ""}`} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="group" aria-label={`Knowledge map with ${view!.nodes.length} records and ${view!.edges.length} connections`}
                onPointerDown={(e) => { if ((e.target as Element).closest(".node")) return; drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
                onPointerMove={(e) => {
                  const d = drag.current; if (!d) return;
                  const r = svgRef.current!.getBoundingClientRect(); const s = Math.max(d.vb.w / r.width, d.vb.h / r.height);
                  if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
                  setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.x) * s, y: d.vb.y - (e.clientY - d.y) * s });
                }}
                onPointerUp={() => { if (drag.current && !drag.current.moved) { setSelected(null); setEdge(null); } drag.current = null; }}>
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" className="arrow-head" /></marker>
                </defs>
                {placed.clusters.map((c) => (
                  <g key={c.key} className={`cluster ${c.key.startsWith("_") ? "virtual" : ""}`} aria-hidden>
                    <circle cx={c.x} cy={c.y} r={c.r} />
                    {c.key.startsWith("_") && <text x={c.x} y={c.y - c.r + 26} textAnchor="middle">{c.label}</text>}
                  </g>
                ))}
                {view!.edges.map((e) => {
                  const a = pos.get(e.source); const b = pos.get(e.target); if (!a || !b) return null;
                  const on = !!focus && (e.source === focus || e.target === focus);
                  const bend = a.cluster === b.cluster ? 0 : 0.18;
                  const mx = (a.x + b.x) / 2 - (b.y - a.y) * bend; const my = (a.y + b.y) / 2 + (b.x - a.x) * bend;
                  const d = `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
                  return (
                    <g key={e.id} className="edge-g" onClick={(ev) => { ev.stopPropagation(); setEdge(e.id); setSelected(null); }}>
                      <path d={d} className={`edge rel-${e.relation} ${on || edge === e.id ? "on" : ""} ${(dim(e.source) || dim(e.target)) && !on && edge !== e.id ? "dim" : ""}`}
                        markerEnd={e.relation === "depends_on" ? "url(#arrow)" : undefined} />
                      <path d={d} className="edge-hit"><title>{`${a.title} ${REL_LABEL[e.relation]} ${b.title}`}</title></path>
                    </g>
                  );
                })}
                {placed.nodes.map((n) => {
                  const r = n.type === "situation" ? 30 : n.type === "task" ? 15 : 14;
                  return (
                    <g key={n.key} className={`node type-${n.type} st-${n.status} ${selected === n.key ? "sel" : ""} ${dim(n.key) ? "dim" : ""} ${matches.has(n.key) ? "match" : ""}`}
                      transform={`translate(${n.x} ${n.y})`} role="button" tabIndex={0}
                      aria-label={`${TYPE_LABEL[n.type]}: ${n.title}, ${n.status.replace("_", " ")}, ${n.degree} connection${n.degree === 1 ? "" : "s"}`}
                      aria-pressed={selected === n.key}
                      onClick={() => select(n.key)} onDoubleClick={() => open(n)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.key); } }}
                      onPointerEnter={() => setHover(n.key)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(n.key)} onBlur={() => setHover(null)}>
                      {n.type === "document"
                        ? <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={5} className="shape" />
                        : <circle r={r} className="shape" />}
                      {n.type === "situation" && <circle r={r + 7} className="halo" />}
                      <text y={r + 16} textAnchor="middle" className="label">{short(n.title, n.type === "situation" ? 28 : 22)}</text>
                    </g>
                  );
                })}
              </svg>
              <p className="map-legend fine"><span className="dot type-situation" /> Situation <span className="dot type-task" /> Task <span className="dot type-document" /> Document · <span className="legend-line dep" /> must happen after · Scroll to zoom, drag to pan, click to inspect, double-click to open.</p>
            </div>
          ) : (
            <div className="panel map-list" aria-label="Map as a list">
              <table>
                <caption className="sr-only">Every record on the map and what it is connected to</caption>
                <thead><tr><th scope="col">Record</th><th scope="col">Type</th><th scope="col">Connected to</th></tr></thead>
                <tbody>{view!.nodes.map((n) => (
                  <tr key={n.key} className={selected === n.key ? "sel" : ""}>
                    <td><button className="link" onClick={() => select(n.key)}>{n.title}</button></td>
                    <td>{TYPE_LABEL[n.type]}</td>
                    <td>{view!.edges.filter((e) => e.source === n.key || e.target === n.key).map((e) => {
                      const other = e.source === n.key ? e.target : e.source; const o = pos.get(other);
                      return o ? <span key={e.id} className="rel-chip">{e.source === n.key ? REL_LABEL[e.relation] : `has (${REL_LABEL[e.relation]})`} {o.title}</span> : null;
                    })}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}

          <aside ref={detailRef} className="panel map-detail" aria-label="Selected record" aria-live="polite">
            {!sel && selEdge ? (
              <div className="edge-detail">
                <p className="eyebrow">Connection</p>
                <h2>{REL_SENTENCE[selEdge.e.relation](selEdge.a.title, selEdge.b.title)}</h2>
                <p className="small">{REL_WHY[selEdge.e.relation]}</p>
                <ul className="conn-list">
                  {[selEdge.a, selEdge.b].map((n) => (
                    <li key={n.key}><button className={`conn type-${n.type}`} onClick={() => select(n.key, true)}>
                      <span className={`dot type-${n.type}`} aria-hidden /><span className="conn-main"><strong>{n.title}</strong><span className="muted">{TYPE_LABEL[n.type]}</span></span></button></li>
                  ))}
                </ul>
              </div>
            ) : !sel ? (
              <div className="map-hint"><Share2 size={22} aria-hidden /><p><strong>Select a record</strong> to see everything stored as connected to it, and what is missing.</p>
                <p className="fine">{view!.nodes.length} records · {view!.edges.length} connections</p></div>
            ) : (
              <>
                <p className="eyebrow"><span className={`dot type-${sel.type}`} aria-hidden /> {TYPE_LABEL[sel.type]}</p>
                <h2>{sel.title}</h2>
                <p className="d-meta">{sel.type !== "document" && <StatusBadge status={sel.status as TaskStatus} />}<span className="muted">{sel.subtitle}</span></p>
                <button className="btn primary" onClick={() => open(sel)}>Open {TYPE_LABEL[sel.type].toLowerCase()} <ArrowRight size={14} aria-hidden /></button>
                {connErr && <p className="banner error" role="alert">{connErr}</p>}
                {!conn && !connErr && <span className="spinner" role="status" aria-label="Loading connections" />}
                {conn && conn.center.key === selected && (
                  <>
                    <h3 className="section-title">Connected ({conn.related.length})</h3>
                    {conn.related.length ? (
                      <ul className="conn-list">{conn.related.map((r) => (
                        <li key={r.key}>
                          <button className={`conn type-${r.type}`} onClick={() => (pos.has(r.key) ? select(r.key, true) : open(r))}>
                            <span className={`dot type-${r.type}`} aria-hidden /><span className="conn-main"><strong>{r.title}</strong><span className="muted">{r.relation}{r.via ? ` · via ${r.via}` : ""}</span></span>
                          </button>
                        </li>
                      ))}</ul>
                    ) : <p className="muted small">Nothing is connected yet.</p>}
                    {conn.gaps.length > 0 && <><h3 className="section-title">Worth knowing</h3><ul className="gaps">{conn.gaps.map((g) => <li key={g}><TriangleAlert size={13} aria-hidden /> {g}</li>)}</ul></>}
                    {conn.recent_activity.length > 0 && <><h3 className="section-title">Recent activity</h3>
                      <ul className="mini-log">{[...conn.recent_activity].reverse().slice(0, 4).map((e) => <li key={e.id}><time dateTime={e.created_at}>{clock(e.created_at)}</time> {e.description}</li>)}</ul></>}
                  </>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
