import type {
  ActivityEvent, ChatResponse, Connections, DashboardResponse, DocumentCategory, DocumentHit, DocumentSummary, DocumentText, EntityType, HouseholdGraph, Priority, Proposal,
  Recurrence, SearchResult, SituationDetail, Task, TaskCategory, TaskDetail, TaskFilter, TaskWithContext, TraceEntry,
} from "@homerelay/shared";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", "X-HomeRelay-Client": "web", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("NETWORK", "Cannot reach the HomeRelay server. Check that it is running, then retry.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.code ?? "ERROR", body?.error?.message ?? `Request failed (${res.status})`, res.status);
  return body as T;
}
const post = <T>(path: string, body: unknown = {}, headers?: Record<string, string>) =>
  req<T>(path, { method: "POST", body: JSON.stringify(body), headers });

export interface Health { ok: boolean; mode: "deterministic" | "llm"; tz: string; mcp: "up" | "down"; documentMaxMb?: number; llmDocumentAccess?: boolean }

export interface NewSituationInput {
  title: string; category: "delivery" | "maintenance" | "family_visit" | "general"; description?: string;
  startLocal?: string; windowEndLocal?: string; availableFromLocal?: string; nobodyElseHome?: boolean;
  initialTaskTitle?: string; initialTaskDueLocal?: string;
}

export const exportUrl = {
  tasksCsv: "/api/export/tasks.csv",
  json: (id: string) => `/api/situations/${encodeURIComponent(id)}/export.json`,
  report: (id: string) => `/api/situations/${encodeURIComponent(id)}/report.md`,
};

export const api = {
  health: () => req<Health>("/health"),
  dashboard: () => req<DashboardResponse>("/dashboard"),
  situation: (id: string) => req<SituationDetail>(`/situations/${id}`),
  activity: (id: string) => req<{ events: ActivityEvent[] }>(`/situations/${id}/activity`),
  allActivity: () => req<{ events: ActivityEvent[] }>("/activity"),
  trace: (limit = 30) => req<{ trace: TraceEntry[] }>(`/trace?limit=${limit}`),
  chat: (message: string, activeSituationId: string | null, activeDocumentId: string | null = null, activeTaskId: string | null = null) => post<ChatResponse>("/chat", { message, activeSituationId, activeDocumentId, activeTaskId }),
  createSituation: (b: NewSituationInput) => post<{ situation: { id: string } }>("/situations", b),
  simulateDelivery: (startNew = false) => post<{ situation: { id: string }; already_exists: boolean }>("/demo/delivery", { startNew }),
  resetDemo: () => post<{ situations_removed: number }>("/demo/reset", {}, { "X-HomeRelay-Confirm": "reset-demo" }),
  approve: (id: string, selectedActionIds: string[]) =>
    post<{ proposal: Proposal; created_tasks: Task[]; rescheduled_tasks: Task[]; skipped: string[]; already_applied: boolean }>(`/proposals/${id}/approve`, { selectedActionIds }),
  reject: (id: string, reason?: string) => post<{ proposal: Proposal }>(`/proposals/${id}/reject`, { reason }),
  setTaskStatus: (id: string, status: Task["status"], confirmedByUser = false) =>
    post<{ task: Task }>(`/tasks/${id}/status`, { status, confirmedByUser }),
  resolve: (id: string, closeOutstanding: boolean) =>
    post(`/situations/${id}/resolve`, { confirmed: true, closeOutstanding }),

  // ---- tasks ----
  tasks: (o: TaskQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) p.set(k, String(v));
    return req<{ tasks: TaskWithContext[] }>(`/tasks?${p}`);
  },
  createTask: (b: TaskInput) => post<{ task: Task }>("/tasks", b),
  task: (id: string) => req<TaskDetail>(`/tasks/${encodeURIComponent(id)}`),
  updateTask: (id: string, b: Partial<Omit<TaskInput, "documentIds" | "dueLocal" | "situationId" | "dependsOnTaskId">> & { dueLocal?: string | null; situationId?: string | null; dependsOnTaskId?: string | null }) =>
    post<{ task: Task }>(`/tasks/${encodeURIComponent(id)}/update`, b),
  reopenTask: (id: string) => post<{ task: Task }>(`/tasks/${encodeURIComponent(id)}/reopen`, {}),
  deleteTask: (id: string) => post<{ deleted: { id: string; title: string } }>(`/tasks/${encodeURIComponent(id)}/delete`, {}, { "X-HomeRelay-Confirm": "delete-task" }),
  linkTaskDocument: (id: string, documentId: string) => post<{ already_linked: boolean }>(`/tasks/${encodeURIComponent(id)}/documents/link`, { documentId }),
  unlinkTaskDocument: (id: string, documentId: string) => post(`/tasks/${encodeURIComponent(id)}/documents/unlink`, { documentId }),

  // ---- connected records ----
  map: (o: { includeResolved?: boolean; includeDone?: boolean } = {}) => req<HouseholdGraph>(`/map?includeResolved=${o.includeResolved ? 1 : 0}&includeDone=${o.includeDone ? 1 : 0}`),
  connections: (type: EntityType, id: string) => req<Connections>(`/connections/${type}/${encodeURIComponent(id)}`),
  search: (q: string) => req<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`),

  // ---- documents ----
  documents: (o: { q?: string; category?: DocumentCategory | ""; situationId?: string; sort?: "recent" | "name" | "size"; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (o.q) p.set("q", o.q); if (o.category) p.set("category", o.category); if (o.situationId) p.set("situationId", o.situationId);
    if (o.sort) p.set("sort", o.sort); if (o.limit) p.set("limit", String(o.limit));
    return req<{ query: string; results: DocumentHit[] }>(`/documents?${p}`);
  },
  document: (id: string) => req<{ document: DocumentSummary }>(`/documents/${encodeURIComponent(id)}`),
  documentText: (id: string) => req<DocumentText>(`/documents/${encodeURIComponent(id)}/text`),
  situationDocuments: (id: string) => req<{ documents: DocumentSummary[] }>(`/situations/${encodeURIComponent(id)}/documents`),
  updateDocument: (id: string, patch: { title?: string; category?: DocumentCategory; tags?: string[]; description?: string; notes?: string }) =>
    post<{ document: DocumentSummary }>(`/documents/${encodeURIComponent(id)}/metadata`, patch),
  linkDocument: (id: string, situationId: string) => post<{ document: DocumentSummary; already_linked: boolean }>(`/documents/${encodeURIComponent(id)}/link`, { situationId }),
  unlinkDocument: (id: string, situationId: string) => post<{ document: DocumentSummary }>(`/documents/${encodeURIComponent(id)}/unlink`, { situationId }),
  deleteDocument: (id: string) => post<{ deleted: string; title: string }>(`/documents/${encodeURIComponent(id)}/delete`, {}, { "X-HomeRelay-Confirm": "delete-document" }),
};

export type { TaskFilter };
export interface TaskQuery { filter?: TaskFilter; q?: string; category?: TaskCategory | ""; priority?: Priority | ""; situationId?: string; documentId?: string }
export interface TaskInput {
  title: string; description?: string; dueLocal?: string; situationId?: string; priority?: Priority; category?: TaskCategory;
  tags?: string[]; recurrence?: Recurrence; dependsOnTaskId?: string; documentIds?: string[];
}
export const documentUrl = {
  content: (id: string) => `/api/documents/${encodeURIComponent(id)}/content`,
  download: (id: string) => `/api/documents/${encodeURIComponent(id)}/content?download=1`,
};

/** Error from the upload endpoint, carrying the existing document id when the file is a duplicate. */
export class UploadError extends ApiError {
  constructor(code: string, message: string, status: number, public documentId?: string) { super(code, message, status); }
}

/**
 * Uploads one file as raw bytes with REAL progress (XMLHttpRequest upload events). Resolves only when the server has
 * stored the file and returned its record.
 */
export function uploadDocument(file: File, o: { category?: DocumentCategory | ""; situationId?: string; onProgress?: (fraction: number | null) => void }): Promise<DocumentSummary> {
  return new Promise((resolve, reject) => {
    const p = new URLSearchParams();
    if (o.category) p.set("category", o.category); if (o.situationId) p.set("situationId", o.situationId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/documents?${p}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-HomeRelay-Client", "web");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Declared-Type", file.type || "");
    xhr.upload.onprogress = (e) => o.onProgress?.(e.lengthComputable ? e.loaded / e.total : null);
    xhr.onerror = () => reject(new UploadError("NETWORK", "Cannot reach the HomeRelay server. Nothing was saved.", 0));
    xhr.onload = () => {
      let body: any = null; try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status === 201 && body?.document) return resolve(body.document as DocumentSummary);
      reject(new UploadError(body?.error?.code ?? "ERROR", body?.error?.message ?? `Upload failed (${xhr.status}).`, xhr.status, body?.error?.document_id));
    };
    xhr.send(file);
  });
}
