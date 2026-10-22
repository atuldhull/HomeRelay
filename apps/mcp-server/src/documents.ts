import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import type { Actor, DocumentCategory, DocumentHit, DocumentKind, DocumentSummary, DocumentText, ExtractionStatus, LinkedSituation } from "@homerelay/shared";
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import type { Db } from "./db";
import { DomainError } from "./domain";

/**
 * Household document vault. Files the user explicitly uploads are stored under opaque keys in an application-owned
 * directory; SQLite holds metadata, extracted text (per page) and an FTS5 index. Nothing here can read a path supplied
 * by a caller: the only file a request can reach is one this service stored itself.
 */

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_CHARS = 100_000;
const MAX_TOTAL_CHARS = 1_000_000;
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface FileType { kind: DocumentKind; mime: string; exts: string[]; sniff: (b: Buffer) => boolean }
const FILE_TYPES: FileType[] = [
  { kind: "pdf", mime: "application/pdf", exts: [".pdf"], sniff: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { kind: "image", mime: "image/png", exts: [".png"], sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: "image", mime: "image/jpeg", exts: [".jpg", ".jpeg"], sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "text", mime: "text/markdown", exts: [".md", ".markdown"], sniff: isUtf8Text },
  { kind: "text", mime: "text/plain", exts: [".txt"], sniff: isUtf8Text },
];
export const ALLOWED_EXTENSIONS = FILE_TYPES.flatMap((t) => t.exts);
/** Browser-declared types we tolerate; anything else (text/html, executables, ...) is refused outright. */
const TOLERATED_DECLARED = new Set(["", "application/octet-stream", "application/pdf", "image/png", "image/jpeg", "image/jpg", "image/pjpeg", "text/plain", "text/markdown", "text/x-markdown"]);

function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

/** Strips any path, control characters and odd whitespace from a browser-supplied name. Never used as a storage path. */
export function sanitizeFilename(raw: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === "..") throw new DomainError("INVALID_FILE", "The file needs a name.");
  if (clean.length <= 180) return clean;
  const ext = path.extname(clean).slice(0, 12);
  return clean.slice(0, 180 - ext.length) + ext;
}

/** Decides the real type from the bytes; the extension must agree and the declared type must be plausible. */
export function detectFile(bytes: Buffer, filename: string, declaredMime = ""): { kind: DocumentKind; mime: string } {
  const ext = path.extname(filename).toLowerCase();
  const type = FILE_TYPES.find((t) => t.exts.includes(ext));
  if (!type) throw new DomainError("UNSUPPORTED_TYPE", `Files of type "${ext || "(none)"}" are not supported. Use PDF, PNG, JPEG, TXT or Markdown.`);
  const declared = declaredMime.split(";")[0].trim().toLowerCase();
  if (!TOLERATED_DECLARED.has(declared)) throw new DomainError("UNSUPPORTED_TYPE", `The browser reported this file as "${declared}", which is not accepted.`);
  if (!type.sniff(bytes)) throw new DomainError("INVALID_FILE", `The file's contents do not match its ${ext} extension.`);
  return { kind: type.kind, mime: type.mime };
}

const STOP = new Set(["a", "an", "the", "my", "our", "for", "of", "to", "in", "on", "and", "or", "is", "it", "this", "that", "me", "find", "show", "search", "please", "with", "from", "file", "files", "document", "documents", "uploaded"]);
const CATEGORY_HINTS: [RegExp, DocumentCategory][] = [
  [/warrant|guarantee/i, "warranty"], [/receipt|invoice|\bbill\b/i, "receipt"], [/manual|instructions|user.?guide/i, "manual"],
  [/deliver|shipping|tracking|courier|parcel/i, "delivery"], [/service|repair|maintenance/i, "maintenance_record"], [/\bnotes?\b/i, "note"],
];
/** "Automatic" category: a predictable guess from the file name only (never from the contents), else photo for images, else other. */
export function guessCategory(filename: string, kind: DocumentKind): DocumentCategory {
  const name = filename.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ");
  return CATEGORY_HINTS.find(([re]) => re.test(name))?.[1] ?? (kind === "image" ? "photo" : "other");
}

export function queryTokens(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t)))].slice(0, 8);
}

interface Extracted { status: ExtractionStatus; note: string | null; pages: { page: number; text: string }[]; pageCount: number | null }

async function extract(kind: DocumentKind, bytes: Buffer): Promise<Extracted> {
  if (kind === "image") return { status: "unsupported", note: "Images are stored and searchable by title, tags and description only. HomeRelay has no OCR.", pages: [], pageCount: null };
  if (kind === "text") {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    return { status: "completed", note: text.trim() ? null : "The file contains no text.", pages: [{ page: 1, text }], pageCount: null };
  }
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const r = await extractText(pdf, { mergePages: false });
    const pages = r.text.map((t, i) => ({ page: i + 1, text: t }));
    const chars = pages.reduce((n, p) => n + p.text.trim().length, 0);
    return { status: "completed", note: chars ? null : "No text layer found. It may be a scanned image; HomeRelay has no OCR.", pages, pageCount: r.totalPages };
  } catch {
    return { status: "failed", note: "The PDF could not be read. It may be damaged or password-protected.", pages: [], pageCount: null };
  }
}

function capPages(pages: { page: number; text: string }[]): { pages: { page: number; text: string }[]; truncated: boolean } {
  let total = 0; let truncated = false;
  const out = [];
  for (const p of pages) {
    if (total >= MAX_TOTAL_CHARS) { truncated = true; break; }
    let t = p.text;
    if (t.length > MAX_PAGE_CHARS) { t = t.slice(0, MAX_PAGE_CHARS); truncated = true; }
    if (total + t.length > MAX_TOTAL_CHARS) { t = t.slice(0, MAX_TOTAL_CHARS - total); truncated = true; }
    total += t.length; out.push({ page: p.page, text: t });
  }
  return { pages: out, truncated };
}

const normTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return [];
  const out = [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, "-")).filter((t) => t.length > 0))];
  if (out.length > 12) throw new DomainError("INVALID_INPUT", "At most 12 tags.");
  if (out.some((t) => t.length > 40)) throw new DomainError("INVALID_INPUT", "Tags must be 40 characters or fewer.");
  return out;
};

export interface DocumentServiceOptions { dir: string; maxBytes?: number; now?: () => Date }
export interface IngestInput {
  bytes: Buffer; filename: string; declaredMime?: string;
  category?: DocumentCategory; title?: string; tags?: string[]; description?: string; situation_id?: string | null;
}

export class DocumentService {
  readonly dir: string;
  readonly maxBytes: number;
  private now: () => Date;
  constructor(private db: Db, opts: DocumentServiceOptions) {
    this.dir = path.resolve(opts.dir);
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private ts() { return this.now().toISOString(); }

  private log(situationId: string | null, type: string, description: string, actor: Actor, meta: Record<string, unknown>, taskId: string | null = null) {
    this.db.prepare(`INSERT INTO activity_events (id, situation_id, task_id, event_type, description, actor, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), situationId, taskId, type, description, actor, JSON.stringify(meta), this.ts());
  }

  // ---------- reads ----------
  private row(id: string): any {
    const r = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id);
    if (!r) throw new DomainError("NOT_FOUND", `Document ${id} not found`);
    return r;
  }
  private links(ids: string[]): Map<string, LinkedSituation[]> {
    const by = new Map<string, LinkedSituation[]>();
    if (!ids.length) return by;
    const rows = this.db.prepare(`SELECT l.document_id, s.id, s.title, s.status, s.category FROM document_links l JOIN situations s ON s.id=l.situation_id
      WHERE l.document_id IN (${ids.map(() => "?").join(",")}) ORDER BY l.created_at`).all(...ids) as any[];
    for (const r of rows) (by.get(r.document_id) ?? by.set(r.document_id, []).get(r.document_id)!).push({ id: r.id, title: r.title, status: r.status, category: r.category });
    return by;
  }
  private toSummary(r: any, linked: LinkedSituation[] = [], tasks: DocumentSummary["linked_tasks"] = []): DocumentSummary {
    const { tags_json, storage_key: _key, ...rest } = r;
    return { ...rest, tags: JSON.parse(tags_json), linked_situations: linked, linked_tasks: tasks } as DocumentSummary;
  }
  private taskLinks(ids: string[]): Map<string, DocumentSummary["linked_tasks"]> {
    const by = new Map<string, DocumentSummary["linked_tasks"]>();
    if (!ids.length) return by;
    const rows = this.db.prepare(`SELECT l.document_id, t.id, t.title, t.status, t.situation_id FROM task_documents l JOIN tasks t ON t.id=l.task_id
      WHERE l.document_id IN (${ids.map(() => "?").join(",")}) ORDER BY l.created_at`).all(...ids) as any[];
    for (const r of rows) (by.get(r.document_id) ?? by.set(r.document_id, []).get(r.document_id)!).push({ id: r.id, title: r.title, status: r.status, situation_id: r.situation_id });
    return by;
  }
  private summaries(rows: any[]): DocumentSummary[] {
    const ids = rows.map((r) => r.id);
    const links = this.links(ids); const tasks = this.taskLinks(ids);
    return rows.map((r) => this.toSummary(r, links.get(r.id) ?? [], tasks.get(r.id) ?? []));
  }

  get(id: string): DocumentSummary { return this.summaries([this.row(id)])[0]; }

  list(o: { category?: DocumentCategory; situation_id?: string; sort?: "recent" | "name" | "size"; limit?: number } = {}): DocumentSummary[] {
    if (o.situation_id) this.requireSituation(o.situation_id);
    const where: string[] = []; const args: unknown[] = [];
    if (o.category) { where.push("d.category=?"); args.push(o.category); }
    if (o.situation_id) { where.push("EXISTS (SELECT 1 FROM document_links l WHERE l.document_id=d.id AND l.situation_id=?)"); args.push(o.situation_id); }
    const order = o.sort === "name" ? "lower(d.title) ASC" : o.sort === "size" ? "d.size_bytes DESC" : "d.created_at DESC, d.rowid DESC";
    const rows = this.db.prepare(`SELECT d.* FROM documents d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`).all(...args, Math.min(o.limit ?? 50, 200));
    return this.summaries(rows as any[]);
  }

  /**
   * Full-text search over metadata and extracted text. Tokens are OR-matched by FTS5, then documents are ranked by how
   * many query terms they cover (across all their rows) and by bm25. Snippets come from the stored text only.
   */
  search(query: string, o: { category?: DocumentCategory; situation_id?: string; limit?: number } = {}): DocumentHit[] {
    const tokens = queryTokens(query);
    if (!tokens.length) return this.list({ category: o.category, situation_id: o.situation_id, limit: o.limit }).map((d) => ({ document: d, snippet: null, page: null, matched: [] }));
    if (o.situation_id) this.requireSituation(o.situation_id);
    const match = tokens.map((t) => `"${t}"*`).join(" OR ");
    const rows = this.db.prepare(`SELECT document_id, page, field, content, snippet(documents_fts, 3, '«', '»', '…', 14) AS snip, bm25(documents_fts) AS rank
      FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank LIMIT 400`).all(match) as { document_id: string; page: number; field: string; content: string; snip: string; rank: number }[];
    const stems = tokens.map((t) => new RegExp(`\\b${t.slice(0, Math.max(3, t.length - 3)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu"));
    const byDoc = new Map<string, { covered: Set<number>; best: number; text?: { snip: string; page: number; rank: number }; meta?: { snip: string }; fields: Set<"metadata" | "text"> }>();
    for (const r of rows) {
      const e = byDoc.get(r.document_id) ?? { covered: new Set<number>(), best: Infinity, fields: new Set<"metadata" | "text">() };
      stems.forEach((re, i) => { if (re.test(r.content)) e.covered.add(i); });
      e.best = Math.min(e.best, r.rank);
      if (r.field === "text") { e.fields.add("text"); if (!e.text || r.rank < e.text.rank) e.text = { snip: r.snip, page: r.page, rank: r.rank }; }
      else { e.fields.add("metadata"); e.meta ??= { snip: r.snip }; }
      byDoc.set(r.document_id, e);
    }
    const need = Math.max(1, Math.ceil(tokens.length / 2));
    let ids = [...byDoc.entries()].filter(([, e]) => e.covered.size >= need)
      .sort((a, b) => b[1].covered.size - a[1].covered.size || a[1].best - b[1].best).map(([id]) => id);
    if (!ids.length) return [];
    const docs = new Map(this.summaries(this.db.prepare(`SELECT * FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[]).map((d) => [d.id, d]));
    ids = ids.filter((id) => {
      const d = docs.get(id)!;
      return (!o.category || d.category === o.category) && (!o.situation_id || d.linked_situations.some((s) => s.id === o.situation_id));
    });
    return ids.slice(0, Math.min(o.limit ?? 20, 100)).map((id) => {
      const e = byDoc.get(id)!; const d = docs.get(id)!;
      return {
        document: d,
        snippet: e.text?.snip ?? e.meta?.snip?.split("\n").find((l) => l.includes("«")) ?? null,
        page: e.text && d.kind === "pdf" ? e.text.page : null,
        matched: [...e.fields].sort(),
      };
    });
  }

  getText(id: string, o: { page?: number; max_chars?: number } = {}): DocumentText {
    const d = this.row(id);
    const max = Math.min(Math.max(o.max_chars ?? 20_000, 200), 100_000);
    const rows = (o.page
      ? this.db.prepare("SELECT page, text FROM document_pages WHERE document_id=? AND page=?").all(id, o.page)
      : this.db.prepare("SELECT page, text FROM document_pages WHERE document_id=? ORDER BY page").all(id)) as { page: number; text: string }[];
    if (o.page && !rows.length && d.extraction_status === "completed") throw new DomainError("NOT_FOUND", `Page ${o.page} does not exist in this document`);
    let used = 0; let truncated = false; const pages = [];
    for (const r of rows) {
      if (used >= max) { truncated = true; break; }
      const t = r.text.length + used > max ? (truncated = true, r.text.slice(0, max - used)) : r.text;
      used += t.length; pages.push({ page: r.page, text: t });
    }
    return { document_id: id, status: d.extraction_status, note: d.extraction_note, pages, truncated };
  }

  situationDocuments(situationId: string): DocumentSummary[] { return this.list({ situation_id: situationId, limit: 200 }); }

  /** The only way to locate stored bytes. The key comes from our own database row, never from a caller. */
  content(id: string): { file: string; mime: string; filename: string; size: number } {
    const d = this.row(id);
    if (!STORAGE_KEY.test(d.storage_key)) throw new DomainError("INTERNAL", "Invalid storage key");
    const file = path.join(this.dir, d.storage_key);
    if (path.dirname(file) !== this.dir || !fs.existsSync(file)) throw new DomainError("NOT_FOUND", "The stored file is missing");
    return { file, mime: d.mime_type, filename: d.original_filename, size: d.size_bytes };
  }

  // ---------- writes ----------
  private requireSituation(id: string) {
    const s = this.db.prepare("SELECT id, title FROM situations WHERE id=?").get(id) as { id: string; title: string } | undefined;
    if (!s) throw new DomainError("NOT_FOUND", `Situation ${id} not found`);
    return s;
  }

  /** (Re)builds the metadata row of the FTS index: title, filename, category, tags, description, notes, linked situation titles. */
  private indexMeta(id: string) {
    const d = this.row(id);
    const linked = (this.db.prepare("SELECT s.title FROM document_links l JOIN situations s ON s.id=l.situation_id WHERE l.document_id=?").all(id) as { title: string }[]).map((x) => x.title);
    this.db.prepare("DELETE FROM documents_fts WHERE document_id=? AND field='meta'").run(id);
    const content = [d.title, d.original_filename, DOCUMENT_CATEGORY_LABEL[d.category as DocumentCategory], JSON.parse(d.tags_json).join(" "), d.description, d.notes, ...linked].filter(Boolean).join("\n");
    this.db.prepare("INSERT INTO documents_fts (document_id, page, field, content) VALUES (?, 0, 'meta', ?)").run(id, content);
  }

  async ingest(input: IngestInput, actor: Actor = "user"): Promise<DocumentSummary> {
    const bytes = input.bytes;
    if (!bytes?.length) throw new DomainError("INVALID_FILE", "The file is empty.");
    if (bytes.length > this.maxBytes) throw new DomainError("TOO_LARGE", `The file is larger than the ${Math.round(this.maxBytes / 1024 / 1024)} MB limit.`);
    const filename = sanitizeFilename(input.filename);
    const { kind, mime } = detectFile(bytes, filename, input.declaredMime);
    const category = input.category ?? guessCategory(filename, kind);
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) throw new DomainError("INVALID_INPUT", `Unknown category "${category}"`);
    const tags = normTags(input.tags ?? []);
    const title = (input.title?.trim() || filename.replace(/\.[^.]+$/, "")).slice(0, 200);
    const description = (input.description ?? "").slice(0, 2000);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dup = this.db.prepare("SELECT id, title FROM documents WHERE sha256=?").get(sha256) as { id: string; title: string } | undefined;
    if (dup) throw new DomainError("DUPLICATE", `This exact file is already stored as "${dup.title}".`, { document_id: dup.id });
    if (input.situation_id) this.requireSituation(input.situation_id);

    const ex = await extract(kind, bytes);
    const capped = capPages(ex.pages);
    const note = capped.truncated ? [ex.note, "Extracted text was truncated to the size limit."].filter(Boolean).join(" ") : ex.note;
    const textChars = capped.pages.reduce((n, p) => n + p.text.length, 0);

    // Write the bytes first (atomic rename), then the row; if the row fails, remove the file again.
    const id = randomUUID(); const storageKey = randomUUID();
    const file = path.join(this.dir, storageKey); const tmp = `${file}.part`;
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    fs.renameSync(tmp, file);
    try {
      this.db.transaction(() => {
        const t = this.ts();
        this.db.prepare(`INSERT INTO documents (id,title,original_filename,storage_key,mime_type,kind,size_bytes,sha256,category,tags_json,description,notes,extraction_status,extraction_note,page_count,text_chars,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, title, filename, storageKey, mime, kind, bytes.length, sha256, category, JSON.stringify(tags), description, "", ex.status, note, ex.pageCount, textChars, t, t);
        const page = this.db.prepare("INSERT INTO document_pages (document_id, page, text) VALUES (?,?,?)");
        const fts = this.db.prepare("INSERT INTO documents_fts (document_id, page, field, content) VALUES (?,?, 'text', ?)");
        for (const p of capped.pages) { page.run(id, p.page, p.text); if (p.text.trim()) fts.run(id, p.page, p.text); }
        this.log(null, "document_added", `Document added: ${title} (${DOCUMENT_CATEGORY_LABEL[category]})`, actor, { document_id: id, extraction_status: ex.status });
        if (input.situation_id) {
          this.db.prepare("INSERT INTO document_links (document_id, situation_id, created_at) VALUES (?,?,?)").run(id, input.situation_id, t);
          this.log(input.situation_id, "document_linked", `Document attached: ${title}`, actor, { document_id: id });
        }
        this.indexMeta(id);
      })();
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    return this.get(id);
  }

  link(documentId: string, situationId: string, actor: Actor = "agent"): { document: DocumentSummary; already_linked: boolean } {
    return this.db.transaction(() => {
      const d = this.row(documentId); const s = this.requireSituation(situationId);
      const exists = this.db.prepare("SELECT 1 FROM document_links WHERE document_id=? AND situation_id=?").get(documentId, situationId);
      if (exists) return { document: this.get(documentId), already_linked: true };
      this.db.prepare("INSERT INTO document_links (document_id, situation_id, created_at) VALUES (?,?,?)").run(documentId, situationId, this.ts());
      this.log(situationId, "document_linked", `Document attached: ${d.title}`, actor, { document_id: documentId, situation_title: s.title });
      this.indexMeta(documentId);
      return { document: this.get(documentId), already_linked: false };
    })();
  }

  unlink(documentId: string, situationId: string, actor: Actor = "agent"): DocumentSummary {
    return this.db.transaction(() => {
      const d = this.row(documentId); this.requireSituation(situationId);
      const r = this.db.prepare("DELETE FROM document_links WHERE document_id=? AND situation_id=?").run(documentId, situationId);
      if (!r.changes) throw new DomainError("NOT_LINKED", "That document is not attached to that situation.");
      this.log(situationId, "document_unlinked", `Document detached: ${d.title}`, actor, { document_id: documentId });
      this.indexMeta(documentId);
      return this.get(documentId);
    })();
  }

  updateMetadata(id: string, patch: { title?: string; category?: DocumentCategory; tags?: string[]; description?: string; notes?: string }, actor: Actor = "user"): DocumentSummary {
    return this.db.transaction(() => {
      const d = this.row(id);
      const next = {
        title: patch.title === undefined ? d.title : patch.title.trim(),
        category: patch.category ?? d.category,
        tags_json: patch.tags === undefined ? d.tags_json : JSON.stringify(normTags(patch.tags)),
        description: patch.description === undefined ? d.description : patch.description.slice(0, 2000),
        notes: patch.notes === undefined ? d.notes : patch.notes.slice(0, 4000),
      };
      if (!next.title || next.title.length > 200) throw new DomainError("INVALID_INPUT", "Title must be 1 to 200 characters.");
      if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(next.category)) throw new DomainError("INVALID_INPUT", `Unknown category "${next.category}"`);
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== d[k]);
      if (!changed.length) return this.get(id);
      this.db.prepare("UPDATE documents SET title=?, category=?, tags_json=?, description=?, notes=?, updated_at=? WHERE id=?")
        .run(next.title, next.category, next.tags_json, next.description, next.notes, this.ts(), id);
      this.log(null, "document_updated", `Document details updated: ${next.title}`, actor, { document_id: id, fields: changed.map((c) => c.replace("_json", "")) });
      this.indexMeta(id);
      return this.get(id);
    })();
  }

  /** Deletes ONE document: its row, pages, index rows, links and stored file. Situations are untouched. */
  delete(id: string, actor: Actor = "user"): { deleted: string; title: string; detached_from: string[] } {
    const { storageKey, title, linked } = this.db.transaction(() => {
      const d = this.row(id);
      const linked = (this.db.prepare("SELECT situation_id FROM document_links WHERE document_id=?").all(id) as { situation_id: string }[]).map((x) => x.situation_id);
      const tasks = this.db.prepare("SELECT t.id, t.title, t.situation_id FROM task_documents l JOIN tasks t ON t.id=l.task_id WHERE l.document_id=?").all(id) as { id: string; title: string; situation_id: string | null }[];
      this.db.prepare("DELETE FROM documents_fts WHERE document_id=?").run(id);
      this.db.prepare("DELETE FROM documents WHERE id=?").run(id); // links to situations and tasks cascade
      for (const s of linked) this.log(s, "document_unlinked", `Document deleted: ${d.title}`, actor, { document_id: id });
      for (const t of tasks) this.log(t.situation_id, "document_unlinked", `Document deleted (was attached to task "${t.title}"): ${d.title}`, actor, { document_id: id, task_title: t.title }, t.id);
      this.log(null, "document_deleted", `Document deleted: ${d.title}`, actor, { document_id: id });
      return { storageKey: d.storage_key as string, title: d.title as string, linked };
    })();
    if (STORAGE_KEY.test(storageKey)) fs.rmSync(path.join(this.dir, storageKey), { force: true });
    return { deleted: id, title, detached_from: linked };
  }
}
