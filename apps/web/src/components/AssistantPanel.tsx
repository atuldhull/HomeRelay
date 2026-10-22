import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, Send, Sparkles, X } from "lucide-react";
import type { Proposal, TraceEntry } from "@homerelay/shared";
import { HOME, operationSteps } from "../logic";
import { useClock } from "../ui";
import type { ChatMsg } from "../types";
import { DocResults } from "./DocResults";
import { EntityResults } from "./EntityResults";
import { ProposalCard } from "./ProposalCard";
import { TracePanel, TraceRows } from "./TracePanel";
import { Logo } from "./AppShell";

/** What the tool trace says was actually saved. Only successful state-changing calls are listed, in their own words. */
const CHANGE_LABEL: Record<string, string> = {
  create_situation: "Situation created", simulate_delivery_event: "Simulated delivery", set_constraints: "Availability saved",
  update_situation: "Time updated", propose_plan: "Plan drafted", approve_plan: "Plan applied", reject_plan: "Plan rejected",
  add_task: "Task added", reschedule_task: "Task rescheduled", update_task_status: "Task updated", resolve_situation: "Situation resolved",
  link_document_to_situation: "Document attached", unlink_document_from_situation: "Document detached", update_document_metadata: "Document updated",
  update_task: "Task edited", reopen_task: "Task reopened", link_document_to_task: "Document attached to task", unlink_document_from_task: "Document detached from task",
};
function changesOf(trace: TraceEntry[] | undefined) {
  return (trace ?? [])
    .filter((t) => t.ok && CHANGE_LABEL[t.tool] && !(t.tool === "propose_plan" && !/plan saved/.test(t.result_summary)) && !/existing|already/.test(t.result_summary))
    .map((t) => ({ id: t.id, label: CHANGE_LABEL[t.tool], detail: t.result_summary }));
}

export interface AssistantPanelProps {
  variant: "drawer" | "page";
  onClose?: () => void;
  threadKey: string;
  contextTitle: string | null;
  contextKind: "home" | "situation" | "document" | "task";
  messages: ChatMsg[];
  sending: boolean;
  busy: boolean;
  mode: "deterministic" | "llm";
  trace: TraceEntry[];
  liveProposals: Map<string, Proposal>;
  suggestions: string[];
  onSend: (text: string) => void;
  onApprove: (proposalId: string, ids: string[]) => void;
  onReject: (proposalId: string) => void;
  onOpenSituation: (id: string) => void;
  onOpenDocument: (id: string) => void;
  /** Opens any record the reply referred to, by its route (e.g. "#/task/<id>"). */
  onOpenRoute: (route: string) => void;
}

/** Shown only while a request is actually in flight; it reports elapsed time, not invented steps. */
function Working() {
  const [secs, setSecs] = useState(0);
  useEffect(() => { const t = setInterval(() => setSecs((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="msg agent working" role="status">
      <span className="dots" aria-hidden><i /><i /><i /></span>
      <span>{secs < 3 ? "HomeRelay is working on it" : `Still working (${secs} s): the tools are running`}</span>
    </div>
  );
}

export function AssistantPanel(p: AssistantPanelProps) {
  const { variant, onClose, threadKey, contextTitle, contextKind, messages, sending, busy, mode, trace, liveProposals, suggestions, onSend, onApprove, onReject, onOpenSituation, onOpenDocument, onOpenRoute } = p;
  const [text, setText] = useState("");
  const clock = useClock();
  const endRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (variant === "drawer") { const id = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(id); } }, [variant]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, sending]);

  const submit = (t = text) => { const v = t.trim(); if (!v || sending) return; setText(""); onSend(v); };
  const ctxLine = contextTitle
    ? <>Working on{contextKind === "document" ? " document" : contextKind === "task" ? " task" : ""}: <strong>{contextTitle}</strong></>
    : "Working across your household";

  return (
    <div className={`assistant-panel ${variant}`}>
      <header className="drawer-head">
        <Logo size={26} />
        <div className="dh-title-wrap">
          {variant === "drawer" ? <h2>Ask HomeRelay</h2> : <h2 className="sr-only">Conversation</h2>}
          <p className="dh-ctx" aria-live="polite">{ctxLine}</p>
        </div>
        <span className="chip" title={mode === "llm" ? "Language-model agent using MCP tools" : "Rule-based agent for the supported requests. No API key needed."}>{mode === "llm" ? "LLM agent" : "Rules agent"}</span>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close assistant"><X size={18} /></button>}
      </header>

      <div className="chat" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="chat-empty">
            <Sparkles size={20} aria-hidden />
            <p>{contextKind === "document"
              ? "Ask what this document says. I quote the text HomeRelay extracted and tell you when there is none."
              : threadKey === HOME
                ? "Ask about your household, search your documents, or describe something new in plain language. I save it, propose a plan, and wait for your approval before anything is created."
                : "Tell me what changed, ask what is pending, find related documents, or confirm something is done. I work on this situation using real tools and show you what was saved."}</p>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === "user") return <div key={m.id} className="msg user"><p>{m.text}</p><time className="msg-time" dateTime={m.at}>{clock(m.at)}</time></div>;
          const live = m.proposal ? liveProposals.get(m.proposal.id) ?? m.proposal : null;
          const changes = m.error ? [] : changesOf(m.trace);
          const steps = operationSteps(m.trace);
          return (
            <div key={m.id} className={`msg agent ${m.error ? "error" : ""} ${m.clarification ? "asks" : ""}`}>
              <header className="resp-head">
                <span className="resp-who"><Logo size={16} /> HomeRelay</span>
                {m.clarification && <span className="tag warn">Needs your answer</span>}
                {m.stateChanged && <span className="tag ok">Saved</span>}
                <time dateTime={m.at}>{clock(m.at)}</time>
              </header>
              {steps.length > 0 && (
                <ol className="steps" aria-label="What I did">
                  {steps.map((s) => <li key={s.id} className={s.ok ? "ok" : "err"} title={s.detail}>{s.ok ? <CircleCheck size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}{s.label}</li>)}
                </ol>
              )}
              <p className="reply">{m.text}</p>
              {m.documents && m.documents.length > 0 && <DocResults hits={m.documents} onOpen={onOpenDocument} compact label="Documents in this answer" />}
              {m.entities && m.entities.length > 0 && <EntityResults items={m.entities} onOpen={onOpenRoute} />}
              {changes.length > 0 && (
                <ul className="changes" aria-label="What was saved">
                  {changes.map((c) => <li key={c.id}><CircleCheck size={14} aria-hidden /><span><strong>{c.label}</strong> · {c.detail}</span></li>)}
                </ul>
              )}
              {live && <ProposalCard key={`${live.id}-${live.status}`} proposal={live} busy={busy} onApprove={(ids) => onApprove(live.id, ids)} onReject={() => onReject(live.id)} />}
              {m.situationId && threadKey === HOME && (
                <button className="link-btn" onClick={() => onOpenSituation(m.situationId!)}>Open situation <ArrowUpRight size={14} aria-hidden /></button>
              )}
              {m.trace && m.trace.length > 0 && (
                <details className="mini-trace"><summary>{m.trace.length} tool call{m.trace.length === 1 ? "" : "s"}</summary><TraceRows entries={m.trace} /></details>
              )}
              {m.error && m.retryText && <button className="btn small" onClick={() => submit(m.retryText)} disabled={sending}>Retry</button>}
            </div>
          );
        })}
        {sending && <Working />}
        <div ref={endRef} />
      </div>

      {suggestions.length > 0 && !sending && (
        <div className="suggest" aria-label="Suggestions">{suggestions.slice(0, 3).map((s) => <button key={s} className="chip-btn" onClick={() => submit(s)}>{s}</button>)}</div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor={`chat-input-${variant}`} className="sr-only">Message HomeRelay</label>
        <textarea
          id={`chat-input-${variant}`} ref={input} rows={2} value={text} maxLength={1000} placeholder="Tell HomeRelay what is happening…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button className="btn primary" type="submit" disabled={sending || !text.trim()} aria-label="Send message"><Send size={16} aria-hidden /></button>
      </form>
      {variant === "drawer" && <TracePanel entries={trace} />}
    </div>
  );
}
