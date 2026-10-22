import { CircleAlert, CircleCheck, House, LayoutList } from "lucide-react";
import type { SituationDetail, SituationSummary, TraceEntry } from "@homerelay/shared";
import { operationSteps } from "../logic";
import type { ChatMsg, Route } from "../types";
import { CategoryIcon, StatusBadge } from "../ui";
import { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";
import { TraceRows } from "./TracePanel";

interface Props extends Omit<AssistantPanelProps, "variant" | "onClose"> {
  situationId: string | null;
  situations: SituationSummary[];
  detail: SituationDetail | null;
  onNav: (r: Route) => void;
}

/** The full assistant workspace: pick the context on the left, talk in the middle, see what actually ran on the right. */
export function AssistantView(p: Props) {
  const { situationId, situations, detail, onNav, messages, trace } = p;
  const lastAgent = [...messages].reverse().find((m: ChatMsg) => m.role === "agent" && m.trace?.length);
  const steps = operationSteps(lastAgent?.trace);
  const open = situations.filter((s) => s.status !== "resolved");
  return (
    <div className="page ws assistant-ws">
      <header className="ws-head"><div><p className="eyebrow">Workspace</p><h1>Assistant</h1>
        <p className="lede">Each situation has its own conversation. Choose what to work on; the assistant reads its real state before answering.</p></div></header>
      <div className="aw-grid">
        <nav className="panel aw-contexts" aria-label="Conversation context">
          <h2>Context</h2>
          <ul>
            <li><button className={!situationId ? "on" : ""} aria-current={!situationId ? "true" : undefined} onClick={() => onNav({ view: "assistant" })}><House size={16} aria-hidden /> Household</button></li>
            {open.map((s) => (
              <li key={s.id}><button className={situationId === s.id ? "on" : ""} aria-current={situationId === s.id ? "true" : undefined} onClick={() => onNav({ view: "assistant", id: s.id })}>
                <CategoryIcon category={s.category} size={14} /><span>{s.title}</span></button></li>
            ))}
          </ul>
          {open.length === 0 && <p className="fine">No open situations.</p>}
        </nav>

        <section className="aw-chat" aria-label="Assistant conversation"><AssistantPanel {...p} variant="page" /></section>

        <aside className="aw-side">
          {detail && (
            <section className="panel" aria-label="Situation summary">
              <h2>{detail.situation.title}</h2>
              <p><StatusBadge status={detail.situation.status} /></p>
              <p className="fine">Next: {detail.workflow.next_action}</p>
              <button className="btn small" onClick={() => onNav({ view: "situation", id: detail.situation.id })}><LayoutList size={14} aria-hidden /> Open situation</button>
            </section>
          )}
          <section className="panel" aria-label="Last operations">
            <h2>What ran last</h2>
            {steps.length === 0 ? <p className="muted">No tool calls in this conversation yet.</p> : (
              <ol className="steps vertical">{steps.map((s) => <li key={s.id} className={s.ok ? "ok" : "err"}>{s.ok ? <CircleCheck size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}<span><strong>{s.label}</strong><span className="muted"> · {s.detail}</span></span></li>)}</ol>
            )}
          </section>
          <details className="panel trace-panel">
            <summary>Developer activity: MCP tool calls <span className="count">{trace.length}</span></summary>
            {trace.length === 0 ? <p className="muted small">No tool calls yet.</p> : <TraceRows entries={[...(trace as TraceEntry[])].reverse().slice(0, 20)} />}
            <p className="fine">Real calls from the backend's MCP client to the HomeRelay MCP server. Credentials are redacted.</p>
          </details>
        </aside>
      </div>
    </div>
  );
}
