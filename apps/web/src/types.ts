import type { DocumentHit, EntityRef, Proposal, TraceEntry } from "@homerelay/shared";

export interface ChatMsg {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
  proposal?: Proposal | null;
  trace?: TraceEntry[];
  stateChanged?: boolean;
  mode?: "deterministic" | "llm";
  error?: boolean;
  situationId?: string | null;
  retryText?: string;
  /** Real documents the reply refers to. */
  documents?: DocumentHit[];
  /** The agent's focused question, when it needs something from the user. */
  clarification?: string | null;
  /** Real records (tasks, situations, documents) the reply refers to. */
  entities?: EntityRef[];
}

export type Route =
  | { view: "dashboard" }
  | { view: "situations" }
  | { view: "situation"; id: string }
  | { view: "documents" }
  | { view: "document"; id: string }
  | { view: "tasks" }
  | { view: "task"; id: string }
  /** Relay Map: the household knowledge map. */
  | { view: "map" }
  | { view: "activity" }
  /** The full assistant workspace; with an id it works on that situation's thread. */
  | { view: "assistant"; id?: string };
