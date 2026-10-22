// Shared domain vocabulary + API shapes for HomeRelay (used by MCP server, API and web).

export const SITUATION_STATUSES = ["open", "in_progress", "blocked", "resolved"] as const;
export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked", "cancelled"] as const;
export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "superseded"] as const;
export const CATEGORIES = ["delivery", "maintenance", "family_visit", "general"] as const;
export const PRIORITIES = ["low", "normal", "high"] as const;
export const SOURCES = ["user", "demo"] as const;
export const TASK_KINDS = ["followup", "coordination", "contingency", "general"] as const;
export const ACTORS = ["user", "agent", "system"] as const;
/** What a household task is about (independent of any situation). */
export const TASK_CATEGORIES = ["general", "maintenance", "cleaning", "shopping", "bills", "family", "garden", "other"] as const;
/** Completion-based recurrence: the next occurrence is saved when the current one is completed. */
export const RECURRENCES = ["none", "weekly", "monthly"] as const;
export const TASK_FILTERS = ["open", "overdue", "today", "upcoming", "blocked", "waiting", "standalone", "done", "all"] as const;

export type SituationStatus = (typeof SITUATION_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Source = (typeof SOURCES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type Actor = (typeof ACTORS)[number];
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export type Recurrence = (typeof RECURRENCES)[number];
export type TaskFilter = (typeof TASK_FILTERS)[number];
export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  general: "General", maintenance: "Maintenance", cleaning: "Cleaning", shopping: "Shopping", bills: "Bills & admin", family: "Family", garden: "Garden", other: "Other",
};

/** Allowed task status transitions. completed / cancelled are terminal here; reopening is a separate, explicit operation. */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["in_progress", "completed", "blocked", "cancelled"],
  in_progress: ["pending", "completed", "blocked", "cancelled"],
  blocked: ["pending", "in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface Constraints {
  /** ISO UTC instant from which the user is available. */
  available_from?: string;
  /** Delivery window end (start is the situation's expected_at). */
  window_end?: string;
  /** Free-text note, e.g. "nobody else is home". */
  note?: string;
  nobody_else_home?: boolean;
}

export interface Situation {
  id: string;
  title: string;
  description: string;
  category: Category;
  status: SituationStatus;
  priority: Priority;
  expected_at: string | null;
  source: Source;
  constraints: Constraints;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface Task {
  id: string;
  /** null for a standalone household task. */
  situation_id: string | null;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  due_at: string | null;
  depends_on_task_id: string | null;
  template_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  priority: Priority;
  category: TaskCategory;
  tags: string[];
  recurrence: Recurrence;
  /** The occurrence this one follows (recurring tasks). */
  recurrence_of: string | null;
}

export type PlanAction =
  | { id: string; type: "add_task"; title: string; description: string; kind: TaskKind; due_at: string | null; depends_on_ref?: string; depends_on_task_id?: string; template_key?: string; rationale: string }
  | { id: string; type: "reschedule_task"; task_id: string; title: string; new_due_at: string; old_due_at: string | null; rationale: string };

export interface Plan {
  summary: string;
  /** Explainability: what the planner looked at. Generated from real inputs, never by an LLM. */
  scenario?: string;
  situation_title?: string;
  constraints_used?: string[];
  outstanding_tasks?: string[];
  conflicts: string[];
  assumptions: string[];
  missing_info: string[];
  actions: PlanAction[];
}

export interface Proposal {
  id: string;
  situation_id: string;
  summary: string;
  status: ProposalStatus;
  plan: Plan;
  applied_action_ids: string[];
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  rejected_at: string | null;
}

export interface ActivityEvent {
  id: string;
  situation_id: string | null;
  task_id: string | null;
  event_type: string;
  description: string;
  actor: Actor;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Preference {
  key: string;
  value: string;
  updated_at: string;
}

export interface WorkflowInfo {
  scenario: string;
  summary: string;
  resolution: string;
  can_resolve: boolean;
  next_action: string;
}

export interface SituationSummary extends Situation {
  can_resolve: boolean;
  open_task_count: number;
  total_task_count: number;
  next_due_at: string | null;
  next_action: string;
  pending_proposal_id: string | null;
}

export interface SituationDetail {
  situation: Situation;
  tasks: Task[];
  proposals: Proposal[];
  preferences: Preference[];
  workflow: WorkflowInfo;
}

export interface TaskWithContext extends Task {
  situation_title: string | null;
  /** Number of documents attached to this task. */
  document_count: number;
  overdue: boolean;
  /** Title of an unfinished prerequisite, when this task cannot proceed yet. */
  waiting_on: string | null;
}

export interface WorkloadSummary {
  now: string;
  tz: string;
  open_situations: number;
  open_tasks: number;
  overdue: TaskWithContext[];
  due_today: TaskWithContext[];
  blocked: TaskWithContext[];
  /** Open tasks due in the next 7 local days (after today). */
  upcoming: TaskWithContext[];
  /** Open tasks not attached to any situation. */
  standalone_open: number;
  recent_documents: { id: string; title: string; kind: string; category: string; created_at: string }[];
  waiting_approval: { situation_id: string; situation_title: string; proposal_id: string; summary: string }[];
  can_resolve: { situation_id: string; situation_title: string }[];
  recent_activity: (ActivityEvent & { situation_title: string | null })[];
}

/** One real MCP call made by the backend's MCP client. */
export interface TraceEntry {
  id: string;
  at: string;
  tool: string;
  ok: boolean;
  duration_ms: number;
  args_summary: string;
  result_summary: string;
  via: "deterministic" | "llm" | "api";
}

export interface ChatRequest { message: string; activeSituationId?: string | null; activeDocumentId?: string | null; activeTaskId?: string | null }

export interface ChatResponse {
  mode: "deterministic" | "llm";
  reply: string;
  situationId: string | null;
  proposal: Proposal | null;
  clarification: string | null;
  trace: TraceEntry[];
  /** True when the reply reports a state change that was actually saved. */
  stateChanged: boolean;
  /** Real document records the reply refers to (search results, linked files). */
  documents?: DocumentHit[];
  /** Real records the reply refers to (tasks, situations, documents), each with its route. */
  entities?: EntityRef[];
}

// ---------- v4: connected records ----------
export const ENTITY_TYPES = ["situation", "task", "document"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const RELATION_TYPES = ["part_of", "depends_on", "attached_to"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** A pointer to one stored record. id is the record's own UUID; key is "type:id" and is unique across types. */
export interface EntityRef {
  key: string;
  type: EntityType;
  id: string;
  title: string;
  status: string;
  /** Short context, e.g. "Task · due 5:00 PM · Package delivery". */
  subtitle: string;
  /** Client route that opens the record, e.g. "#/task/<id>". */
  route: string;
}

export interface GraphNode extends EntityRef { degree: number; category: string }
export interface GraphEdge { id: string; source: string; target: string; relation: RelationType }
export interface HouseholdGraph { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; generated_at: string }

export interface Connections {
  center: EntityRef;
  /** Directly and (for situations) two-step related records, with how each is connected. */
  related: (EntityRef & { relation: string; via: string | null })[];
  /** Gaps derived from stored state, e.g. "No documents attached". */
  gaps: string[];
  recent_activity: ActivityEvent[];
}

export interface TaskDetail {
  task: TaskWithContext;
  situation: { id: string; title: string; status: SituationStatus; category: Category } | null;
  depends_on: { id: string; title: string; status: TaskStatus } | null;
  dependents: { id: string; title: string; status: TaskStatus }[];
  documents: { id: string; title: string; kind: string; category: string }[];
  activity: ActivityEvent[];
  /** Why the task cannot be completed right now, if it cannot. */
  blocked_reason: string | null;
  /** Repeating tasks: the occurrence this one follows, and the one saved when this one was completed. */
  previous_occurrence: { id: string; title: string; status: TaskStatus; due_at: string | null } | null;
  next_occurrence: { id: string; title: string; status: TaskStatus; due_at: string | null } | null;
}

export interface SearchResult extends EntityRef { snippet: string | null }

export interface DashboardResponse {
  mode: "deterministic" | "llm";
  situations: SituationSummary[];
  openCount: number;
  summary: WorkloadSummary;
}

export interface ApiErrorBody { error: { code: string; message: string } }
export * from "./time";

// ---------------- Household document vault ----------------

export const DOCUMENT_CATEGORIES = ["receipt", "warranty", "manual", "delivery", "maintenance_record", "photo", "note", "other"] as const;
export const DOCUMENT_KINDS = ["pdf", "image", "text"] as const;
/** not_required: nothing to extract. unsupported: stored, but no extractor (e.g. images, no OCR). */
export const EXTRACTION_STATUSES = ["not_required", "pending", "completed", "unsupported", "failed"] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  receipt: "Receipt", warranty: "Warranty", manual: "Appliance manual", delivery: "Delivery document",
  maintenance_record: "Maintenance record", photo: "Photo", note: "Household note", other: "Other",
};

export interface LinkedSituation { id: string; title: string; status: SituationStatus; category: Category }

export interface DocumentSummary {
  id: string;
  title: string;
  original_filename: string;
  mime_type: string;
  kind: DocumentKind;
  size_bytes: number;
  sha256: string;
  category: DocumentCategory;
  tags: string[];
  description: string;
  notes: string;
  extraction_status: ExtractionStatus;
  /** Human explanation of the extraction outcome (e.g. "No OCR: images are searchable by metadata only"). */
  extraction_note: string | null;
  page_count: number | null;
  text_chars: number;
  created_at: string;
  updated_at: string;
  linked_situations: LinkedSituation[];
  /** Tasks this document is attached to. */
  linked_tasks: { id: string; title: string; status: TaskStatus; situation_id: string | null }[];
}

export interface DocumentHit {
  document: DocumentSummary;
  /** Excerpt from the stored text or metadata, with matches wrapped in « ». Null when nothing textual matched. */
  snippet: string | null;
  /** 1-based page of the snippet for PDFs; null for metadata matches or single-page text. */
  page: number | null;
  matched: ("metadata" | "text")[];
}

export interface DocumentText {
  document_id: string;
  status: ExtractionStatus;
  note: string | null;
  pages: { page: number; text: string }[];
  truncated: boolean;
}
