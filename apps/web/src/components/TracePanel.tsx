import { CircleAlert, CircleCheck, Terminal } from "lucide-react";
import type { TraceEntry } from "@homerelay/shared";

const VIA: Record<TraceEntry["via"], string> = { deterministic: "rules agent", llm: "LLM agent", api: "app action" };

export function TraceRows({ entries }: { entries: TraceEntry[] }) {
  return (
    <ol className="trace-list">
      {entries.map((t) => (
        <li key={t.id} className={t.ok ? "ok" : "err"}>
          {t.ok ? <CircleCheck size={13} aria-label="succeeded" /> : <CircleAlert size={13} aria-label="failed" />}
          <span className="tool">{t.tool}</span>
          <span className="res">{t.result_summary}</span>
          <span className="via">{VIA[t.via]} · {t.duration_ms}ms</span>
        </li>
      ))}
    </ol>
  );
}

/** Real MCP calls recorded by the backend's MCP client (GET /api/trace). Nothing here is hard-coded. */
export function TracePanel({ entries }: { entries: TraceEntry[] }) {
  return (
    <details className="trace">
      <summary><Terminal size={14} aria-hidden /> Developer activity: MCP tool calls <span className="count">{entries.length}</span></summary>
      {entries.length === 0 ? <p className="muted small">No tool calls yet.</p> : <TraceRows entries={[...entries].reverse().slice(0, 14)} />}
      <p className="fine">Each row is a real call from the backend's MCP client to the HomeRelay MCP server (Streamable HTTP). Credentials are redacted.</p>
    </details>
  );
}
