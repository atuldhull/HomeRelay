import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ActivityEvent, DashboardResponse, DocumentSummary, DocumentText, SituationDetail, Task, TraceEntry } from "@homerelay/shared";
import { api, ApiError, type Health, type NewSituationInput } from "./api";
import { ActivityView } from "./components/ActivityView";
import { AppShell, type Crumb } from "./components/AppShell";
import { AssistantDrawer } from "./components/AssistantDrawer";
import { AssistantView } from "./components/AssistantView";
import { CommandPalette } from "./components/CommandPalette";
import { Dashboard } from "./components/Dashboard";
import { DocumentsView } from "./components/DocumentsView";
import { DocumentView } from "./components/DocumentView";
import { NewSituationSheet } from "./components/NewSituationSheet";
import { RelayMap } from "./components/RelayMap";
import { SituationsView } from "./components/SituationsView";
import { SituationView } from "./components/SituationView";
import { TaskSheet } from "./components/TaskSheet";
import { TasksView } from "./components/TasksView";
import { TaskView } from "./components/TaskView";
import { useRevealOnScroll } from "./motion";
import { Toasts, type ToastItem } from "./components/Toasts";
import {
  HOME, activeDocumentFor, activeSituationFor, activeTaskFor, appendMessages, createdSituation, loadThreads, makeSequencer, parseRoute, pruneThreads,
  rehome, routeHash, saveThreads, suggestionsFor, syncProposal, threadKeyFor, type Threads,
} from "./logic";
import type { ChatMsg, Route } from "./types";
import { Banner, TzContext } from "./ui";

const uid = () => Math.random().toString(36).slice(2, 10);
const msgOf = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : "Something unexpected went wrong.");
const TITLES: Record<Route["view"], string> = { dashboard: "Home", situations: "Situations", situation: "Situation", documents: "Documents", document: "Document", tasks: "Tasks", task: "Task", map: "Relay Map", activity: "Activity", assistant: "Assistant" };
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
type VT = { startViewTransition?: (cb: () => void) => unknown };

export default function App() {
  const [route, setRouteState] = useState<Route>(() => parseRoute(window.location.hash));
  const [health, setHealth] = useState<Health | null>(null);
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [detail, setDetail] = useState<SituationDetail | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [sitDocs, setSitDocs] = useState<DocumentSummary[]>([]);
  const [doc, setDoc] = useState<{ doc: DocumentSummary; text: DocumentText | null } | null>(null);
  const [recentDocs, setRecentDocs] = useState<DocumentSummary[]>([]);
  const [allEvents, setAllEvents] = useState<ActivityEvent[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [threads, setThreads] = useState<Threads>(loadThreads);
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskSheet, setTaskSheet] = useState<{ open: boolean; situationId: string | null }>({ open: false, situationId: null });
  const [taskCtx, setTaskCtx] = useState<{ id: string; title: string } | null>(null);
  const [arrived, setArrived] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const routeRef = useRef(route); routeRef.current = route;
  const seq = useRef(makeSequencer());
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);

  // ---------- notifications ----------
  const toastId = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 220);
  }, []);
  const notify = useCallback((kind: ToastItem["kind"], text: string) => { setToasts((ts) => [...ts.slice(-2), { id: ++toastId.current, kind, text }]); }, []);

  // ---------- routing ----------
  /** flash: briefly highlight the record we land on (after a search, the map or an assistant link). */
  const navigate = useCallback((r: Route, o: { flash?: boolean } = {}) => {
    if (o.flash) { setArrived(true); setTimeout(() => setArrived(false), 1400); }
    window.location.hash = routeHash(r);
  }, []);
  useEffect(() => {
    // The hash changes before React re-renders, so the old page is still on screen when the transition snapshots it.
    const apply = () => flushSync(() => { setRouteState(parseRoute(window.location.hash)); setDetail(null); setEvents([]); setSitDocs([]); setDoc(null); setTaskCtx(null); });
    const on = () => {
      const d = document as Document & VT;
      if (!d.startViewTransition || reducedMotion()) { apply(); return; }
      // a quick second navigation skips the first transition; its promises then reject, which is expected, not an error
      const t = d.startViewTransition(apply) as { ready?: Promise<unknown>; finished?: Promise<unknown>; updateCallbackDone?: Promise<unknown> } | undefined;
      for (const p of [t?.ready, t?.finished, t?.updateCallbackDone]) p?.catch(() => undefined);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("vt", !!(document as Document & VT).startViewTransition); }, []);
  useEffect(() => { saveThreads(threads); }, [threads]);
  useEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [route]);
  // Ctrl+K (Cmd+K on a Mac) opens search and commands anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setAssistantOpen(false); setPaletteOpen((o) => !o); } };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, []);
  useRevealOnScroll(route);

  // ---------- data (always re-read from the server; stale responses are dropped) ----------
  const refresh = useCallback(async () => {
    const r = routeRef.current;
    const n = seq.current.next("dash");
    try {
      const [h, d, t, rd] = await Promise.all([api.health(), api.dashboard(), api.trace(), api.documents({ limit: 4 })]);
      if (seq.current.isLatest("dash", n)) { setHealth(h); setDash(d); setTrace(t.trace); setRecentDocs(rd.results.map((x) => x.document)); }
      const sitId = r.view === "situation" ? r.id : r.view === "assistant" && r.id ? r.id : null;
      if (sitId) {
        const key = `detail:${sitId}`; const m = seq.current.next(key);
        const [s, a, sd] = await Promise.all([api.situation(sitId), api.activity(sitId), api.situationDocuments(sitId)]);
        const cur = routeRef.current; const curId = cur.view === "situation" ? cur.id : cur.view === "assistant" ? cur.id : null;
        if (seq.current.isLatest(key, m) && curId === sitId) { setDetail(s); setEvents(a.events); setSitDocs(sd.documents); }
      } else if (r.view === "document") {
        const key = `doc:${r.id}`; const m = seq.current.next(key);
        const { document } = await api.document(r.id);
        const text = document.kind === "image" ? null : await api.documentText(r.id);
        const cur = routeRef.current;
        if (seq.current.isLatest(key, m) && cur.view === "document" && cur.id === r.id) setDoc({ doc: document, text });
      } else if (r.view === "task") {
        const key = `task:${r.id}`; const m = seq.current.next(key);
        const t = await api.task(r.id);
        const cur = routeRef.current;
        if (seq.current.isLatest(key, m) && cur.view === "task" && cur.id === r.id) setTaskCtx({ id: t.task.id, title: t.task.title });
      } else if (r.view === "activity") {
        const a = await api.allActivity();
        if (routeRef.current.view === "activity") setAllEvents(a.events);
      }
      setError(null);
    } catch (e) {
      const nf = e instanceof ApiError && e.code === "NOT_FOUND";
      setError(nf && r.view === "situation" ? "That situation no longer exists (it may have been reset)." : nf && r.view === "document" ? "That document no longer exists." : nf && r.view === "task" ? "That task no longer exists." : msgOf(e));
    } finally { setDashLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [route, refresh]);
  useEffect(() => { const on = () => void refresh(); window.addEventListener("focus", on); return () => window.removeEventListener("focus", on); }, [refresh]);
  const here = (route.view === "situation" || (route.view === "assistant" && route.id)) && detail?.situation.id === (route as { id?: string }).id ? detail : null;
  useEffect(() => {
    const t = route.view === "situation" && here ? here.situation.title : route.view === "document" && doc ? doc.doc.title : route.view === "task" && taskCtx ? taskCtx.title : TITLES[route.view];
    document.title = `${t} · HomeRelay`;
  }, [route, here, doc, taskCtx]);

  /** Runs a user action, refreshes from persisted state, and reports the real outcome. Success is announced only after the server says so. */
  const act = useCallback(async (fn: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const note = await fn();
      await refresh();
      setTasksVersion((v) => v + 1);
      if (note) notify("success", note);
    } catch (e) {
      notify("error", msgOf(e));
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }, [busy, refresh, notify]);

  const onSimulate = () => act(async () => {
    const r = await api.simulateDelivery();
    navigate({ view: "situation", id: r.situation.id });
    return r.already_exists ? "A simulated delivery is already active, so it was opened instead of duplicated." : "Simulated delivery saved.";
  });
  const onReset = () => act(async () => {
    const r = await api.resetDemo();
    const d = await api.dashboard();
    setThreads((t) => pruneThreads(t, d.situations.map((s) => s.id)));
    navigate({ view: "dashboard" });
    return `Demo data reset (${r.situations_removed} simulated situation${r.situations_removed === 1 ? "" : "s"} removed).`;
  });
  const onApprove = (id: string, ids: string[]) => act(async () => {
    const r = await api.approve(id, ids); setThreads((t) => syncProposal(t, r.proposal));
    return r.already_applied ? "That plan was already applied. Nothing was duplicated." : `Saved: ${r.created_tasks.length} task(s) created, ${r.rescheduled_tasks.length} rescheduled.`;
  });
  const onReject = (id: string) => act(async () => { const r = await api.reject(id); setThreads((t) => syncProposal(t, r.proposal)); return "Plan rejected. Nothing was created."; });
  const onTaskStatus = (id: string, status: Task["status"], confirmed: boolean) => act(async () => {
    await api.setTaskStatus(id, status, confirmed);
    return status === "completed" ? "Marked done, based on your confirmation." : "Task cancelled.";
  });
  const onResolve = (close: boolean) => act(async () => {
    const r = routeRef.current;
    if (r.view !== "situation") return;
    await api.resolve(r.id, close);
    return "Situation resolved, based on your confirmation.";
  });
  /** Throws on failure so the sheet can show the server message and stay open. */
  const onCreate = async (b: NewSituationInput) => {
    const r = await api.createSituation(b);
    notify("success", "Situation created.");
    navigate({ view: "situation", id: r.situation.id });
    await refresh();
  };

  // ---------- assistant (one thread per situation / document / household) ----------
  const onSend = async (text: string) => {
    const sendRoute = routeRef.current;
    const key = threadKeyFor(sendRoute);
    const userMsg: ChatMsg = { id: uid(), role: "user", text, at: new Date().toISOString(), situationId: activeSituationFor(sendRoute) };
    setThreads((t) => appendMessages(t, key, userMsg));
    setSendingKey(key);
    try {
      const r = await api.chat(text, activeSituationFor(sendRoute), activeDocumentFor(sendRoute), activeTaskFor(sendRoute));
      const agentMsg: ChatMsg = { id: uid(), role: "agent", text: r.reply, at: new Date().toISOString(), proposal: r.proposal, trace: r.trace, stateChanged: r.stateChanged, mode: r.mode, situationId: r.situationId, documents: r.documents, entities: r.entities, clarification: r.clarification };
      // A chat from the household view that creates a situation belongs to THAT situation's thread from now on.
      const created = key === HOME ? createdSituation(r) : null;
      setThreads((t) => { const n = appendMessages(t, key, agentMsg); return created ? rehome(n, HOME, created, [userMsg.id, agentMsg.id]) : n; });
      if (created && threadKeyFor(routeRef.current) === HOME) navigate(routeRef.current.view === "assistant" ? { view: "assistant", id: created } : { view: "situation", id: created });
      setSendingKey(null); // the answer is here; the refresh below only updates the other views
      await refresh();
      if (r.stateChanged) setTasksVersion((v) => v + 1);
    } catch (e) {
      setThreads((t) => appendMessages(t, key, { id: uid(), role: "agent", text: `${msgOf(e)} Nothing was changed.`, at: new Date().toISOString(), error: true, retryText: text }));
    } finally { setSendingKey(null); }
  };
  const onAsk = (prompt?: string) => { setAssistantOpen(true); if (prompt) void onSend(prompt); };

  const threadKey = threadKeyFor(route);
  const liveProposals = useMemo(() => new Map((here?.proposals ?? []).map((p) => [p.id, p])), [here]);
  const s = dash?.summary;
  const attention = s ? s.waiting_approval.length + s.overdue.length + s.due_today.length + s.can_resolve.length : 0;
  const mode = health?.mode ?? dash?.mode ?? "deterministic";
  const docOpen = route.view === "document" && doc?.doc.id === route.id ? doc.doc : null;
  const taskOpen = route.view === "task" && taskCtx?.id === route.id ? taskCtx : null;
  const panel = {
    threadKey, messages: threads[threadKey] ?? [], sending: sendingKey === threadKey, busy, mode, trace, liveProposals,
    contextTitle: docOpen?.title ?? taskOpen?.title ?? here?.situation.title ?? null,
    contextKind: (docOpen ? "document" : taskOpen ? "task" : here ? "situation" : "home") as "document" | "situation" | "home" | "task",
    suggestions: suggestionsFor(here, { documentOpen: !!docOpen, taskOpen: !!taskOpen }),
    onSend, onApprove, onReject,
    onOpenSituation: (id: string) => navigate({ view: "situation", id }),
    onOpenDocument: (id: string) => { setAssistantOpen(false); navigate({ view: "document", id }, { flash: true }); },
    onOpenRoute: (r: string) => { setAssistantOpen(false); navigate(parseRoute(r), { flash: true }); },
  };
  const openTaskSheet = (situationId: string | null = null) => setTaskSheet({ open: true, situationId });
  const crumbs: Crumb[] = (() => {
    const t = (x?: string | null) => x ?? "…";
    switch (route.view) {
      case "situation": return [{ label: "Situations", route: { view: "situations" } }, { label: t(here?.situation.title) }];
      case "task": return [{ label: "Tasks", route: { view: "tasks" } }, { label: t(taskOpen?.title) }];
      case "document": return [{ label: "Documents", route: { view: "documents" } }, { label: t(docOpen?.title) }];
      case "assistant": return route.id ? [{ label: "Assistant", route: { view: "assistant" } }, { label: t(here?.situation.title) }] : [{ label: "Assistant" }];
      default: return [{ label: TITLES[route.view] }];
    }
  })();
  const onTaskCreated = (t: { id: string; title: string }) => { notify("success", `Saved "${t.title}".`); setTasksVersion((v) => v + 1); void refresh(); navigate({ view: "task", id: t.id }, { flash: true }); };
  const missing = useCallback((m: string) => setError(m), []);

  return (
    <TzContext.Provider value={health?.tz ?? "Asia/Kolkata"}>
      <a className="skip" href="#main">Skip to content</a>
      <AppShell route={route} health={health} badges={{ dashboard: attention, tasks: s ? s.overdue.length + s.due_today.length : 0 }} crumbs={crumbs} onNav={(r) => navigate(r)} onAsk={() => onAsk()} onNew={() => setNewOpen(true)} onNewTask={() => openTaskSheet()} onSearch={() => setPaletteOpen(true)}>
        <main id="main" ref={mainRef} tabIndex={-1} key={route.view} className={arrived ? "arrived" : undefined}>
          {error && <Banner onRetry={() => void refresh()}>{error}</Banner>}
          {route.view === "dashboard" && (
            <Dashboard data={dash} recentDocs={recentDocs} loading={dashLoading} busy={busy} onSimulate={onSimulate} onReset={onReset} onOpen={(id) => navigate({ view: "situation", id })} onNav={(r) => navigate(r)} onNew={() => setNewOpen(true)} onAsk={onAsk} />
          )}
          {route.view === "situations" && <SituationsView data={dash} busy={busy} onOpen={(id) => navigate({ view: "situation", id })} onNew={() => setNewOpen(true)} onSimulate={onSimulate} />}
          {route.view === "documents" && <DocumentsView onOpen={(id) => navigate({ view: "document", id })} onStored={() => void refresh()} maxMb={health?.documentMaxMb ?? 10} />}
          {route.view === "document" && (docOpen
            ? <DocumentView key={docOpen.id} doc={docOpen} text={doc!.text} situations={dash?.situations ?? []} busy={busy} onBack={() => navigate({ view: "documents" })} onAsk={() => onAsk()}
                onOpenSituation={(id) => navigate({ view: "situation", id })} onOpenTask={(id) => navigate({ view: "task", id })} run={act} onDeleted={() => navigate({ view: "documents" })} />
            : !error && <div className="page center"><span className="spinner big" role="status" aria-label="Loading document" /></div>)}
          {route.view === "tasks" && <TasksView version={tasksVersion} summary={dash?.summary ?? null} situations={dash?.situations ?? []} onOpen={(id) => navigate({ view: "task", id })}
            onOpenSituation={(id) => navigate({ view: "situation", id })} onNew={() => openTaskSheet()} notify={notify} onChanged={() => { setTasksVersion((v) => v + 1); void refresh(); }} />}
          {route.view === "task" && <TaskView key={route.id} id={route.id} version={tasksVersion} situations={dash?.situations ?? []} busy={busy} run={act} onNav={(r) => navigate(r)} onAsk={() => onAsk()} onMissing={missing} />}
          {route.view === "map" && <RelayMap version={tasksVersion} onNav={(r) => navigate(r, { flash: true })} />}
          {route.view === "activity" && <ActivityView events={allEvents} loading={dashLoading} onOpen={(r) => navigate(parseRoute(r), { flash: true })} />}
          {route.view === "assistant" && (
            <AssistantView {...panel} situationId={route.id ?? null} situations={dash?.situations ?? []} detail={here} onNav={navigate} />
          )}
          {route.view === "situation" && (here
            ? <SituationView key={here.situation.id} detail={here} events={events} busy={busy} onBack={() => navigate({ view: "situations" })} onAsk={() => onAsk()}
                onApprove={onApprove} onReject={onReject} onTaskStatus={onTaskStatus} onResolve={onResolve}
                documents={sitDocs} onOpenDocument={(id) => navigate({ view: "document", id })} run={act}
                onOpenTask={(id) => navigate({ view: "task", id })} onAddTask={() => openTaskSheet(here.situation.id)} onOpenRoute={(r) => navigate(parseRoute(r))} />
            : !error && <div className="page center"><span className="spinner big" role="status" aria-label="Loading situation" /></div>)}
        </main>
      </AppShell>

      <AssistantDrawer open={assistantOpen && route.view !== "assistant"} onClose={() => setAssistantOpen(false)} {...panel} />
      <NewSituationSheet open={newOpen} onClose={() => setNewOpen(false)} onSubmit={onCreate} />
      <TaskSheet open={taskSheet.open} situationId={taskSheet.situationId} situations={dash?.situations ?? []} onClose={() => setTaskSheet((t) => ({ ...t, open: false }))} onCreated={onTaskCreated} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNav={(r) => navigate(r, { flash: true })} onNewTask={() => openTaskSheet()} onNewSituation={() => setNewOpen(true)} onAsk={onAsk} />
      <Toasts items={toasts} onDismiss={dismiss} />
    </TzContext.Provider>
  );
}
