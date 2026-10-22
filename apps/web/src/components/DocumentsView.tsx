import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Link2, RotateCcw, Search, Upload, X, LayoutGrid, List } from "lucide-react";
import type { DocumentCategory, DocumentHit, DocumentSummary } from "@homerelay/shared";
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import { ApiError, UploadError, api, uploadDocument } from "../api";
import { makeSequencer } from "../logic";
import { DocIcon, Snippet, formatBytes, relative } from "../ui";

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.txt,.md,.markdown,application/pdf,image/png,image/jpeg,text/plain,text/markdown";

interface UploadItem { key: string; file: File; progress: number | null; status: "uploading" | "done" | "error"; message?: string; docId?: string }

function DocCard({ hit, fresh, onOpen }: { hit: DocumentHit; fresh: boolean; onOpen: (id: string) => void }) {
  const d = hit.document;
  return (
    <li className={fresh ? "just-added" : ""}>
      <button className={`doc-card kind-${d.kind}`} onClick={() => onOpen(d.id)} aria-label={`Open document: ${d.title}`}>
        <span className="dc-top"><DocIcon kind={d.kind} size={20} /><span className="dc-cat">{DOCUMENT_CATEGORY_LABEL[d.category]}</span>
          {d.extraction_status === "failed" && <span className="tag late" title={d.extraction_note ?? ""}>Unreadable</span>}
          {d.extraction_status === "unsupported" && <span className="tag muted" title={d.extraction_note ?? ""}>No text</span>}
        </span>
        <span className="dc-title">{d.title}</span>
        {hit.snippet ? <span className="dc-snip">{hit.page ? <em>p.{hit.page} </em> : null}<Snippet text={hit.snippet} /></span>
          : d.description ? <span className="dc-snip">{d.description}</span> : null}
        <span className="dc-meta">{d.kind.toUpperCase()} · {formatBytes(d.size_bytes)} · {relative(d.created_at)}{d.linked_situations.length > 0 && <> · <Link2 size={12} aria-hidden /> {d.linked_situations.map((s) => s.title).join(", ")}</>}</span>
        {d.tags.length > 0 && <span className="dc-tags">{d.tags.map((t) => <span key={t} className="tagchip">#{t}</span>)}</span>}
      </button>
    </li>
  );
}

interface Props { onOpen: (id: string) => void; onStored: (doc: DocumentSummary) => void; maxMb: number }

export function DocumentsView({ onOpen, onStored, maxMb }: Props) {
  const [q, setQ] = useState(""); const [debounced, setDebounced] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">(() => { try { return localStorage.getItem("homerelay.docs.layout") === "list" ? "list" : "grid"; } catch { return "grid"; } });
  const pickLayout = (l: "grid" | "list") => { setLayout(l); try { localStorage.setItem("homerelay.docs.layout", l); } catch { /* per-browser preference only */ } };
  const [category, setCategory] = useState<DocumentCategory | "">(""); const [sort, setSort] = useState<"recent" | "name" | "size">("recent");
  const [results, setResults] = useState<DocumentHit[] | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]); const [uploadCategory, setUploadCategory] = useState<DocumentCategory | "">("");
  const [drag, setDrag] = useState(false); const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seq = useRef(makeSequencer()); const fileInput = useRef<HTMLInputElement>(null); const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(h); }, [q]);
  const load = useCallback(async () => {
    const n = seq.current.next("docs"); setLoading(true);
    try {
      const r = await api.documents({ q: debounced, category, sort, limit: 200 });
      if (seq.current.isLatest("docs", n)) { setResults(r.results); setError(null); }
    } catch (e) {
      // never leave earlier results on screen as if they answered this search
      if (seq.current.isLatest("docs", n)) { setResults([]); setError(e instanceof ApiError && e.code !== "INVALID_INPUT" ? e.message : debounced ? "Search failed. Nothing was changed." : "Could not load documents."); }
    }
    finally { if (seq.current.isLatest("docs", n)) setLoading(false); }
  }, [debounced, category, sort]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); searchInput.current?.focus(); } };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, []);

  const start = (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      setUploads((u) => [...u, { key, file, progress: 0, status: "uploading" }]);
      const patch = (p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      uploadDocument(file, { category: uploadCategory, onProgress: (f) => patch({ progress: f }) })
        .then((doc) => { patch({ status: "done", docId: doc.id, progress: 1 }); setFresh((s) => new Set(s).add(doc.id)); onStored(doc); void load(); })
        .catch((e: unknown) => patch({ status: "error", message: e instanceof ApiError ? e.message : "Upload failed. Nothing was saved.", docId: e instanceof UploadError ? e.documentId : undefined }));
    }
  };
  const retry = (u: UploadItem) => { setUploads((all) => all.filter((x) => x.key !== u.key)); start([u.file]); };
  const count = results?.length ?? 0;

  return (
    <div className="page ws docs">
      <header className="ws-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Documents</h1>
          <p className="lede">Receipts, warranties, manuals and photos you keep with the situations they belong to. Files stay on this computer.</p>
        </div>
        <div className="head-actions">
          <label className="sel"><span className="sr-only">Category for new uploads</span>
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value as DocumentCategory | "")} aria-label="Category for new uploads">
              <option value="">Upload as: automatic</option>
              {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>Upload as: {DOCUMENT_CATEGORY_LABEL[c]}</option>)}
            </select></label>
          <button className="btn primary" onClick={() => fileInput.current?.click()}><Upload size={16} aria-hidden /> Upload files</button>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { start([...(e.target.files ?? [])]); e.target.value = ""; }} aria-label="Choose files to upload" />
        </div>
      </header>

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); start([...e.dataTransfer.files]); }}
        role="region" aria-label="Upload area"
      >
        <Upload size={20} aria-hidden />
        <span>Drop files here, or <button className="link" onClick={() => fileInput.current?.click()}>choose files</button>. PDF, PNG, JPEG, TXT or Markdown, up to {maxMb} MB each.</span>
      </div>

      {uploads.length > 0 && (
        <ul className="uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.key} className={`upload ${u.status}`}>
              <span className="up-name">{u.file.name} <span className="muted">· {formatBytes(u.file.size)}</span></span>
              {u.status === "uploading" && (
                <span className="up-progress" role="progressbar" aria-label={`Uploading ${u.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.progress === null ? undefined : Math.round(u.progress * 100)}>
                  <span className={u.progress === null ? "indeterminate" : ""} style={u.progress === null ? undefined : { width: `${Math.round(u.progress * 100)}%` }} />
                </span>
              )}
              {u.status === "uploading" && <span className="up-state">{u.progress === null ? "Uploading…" : u.progress >= 1 ? "Processing…" : `${Math.round(u.progress * 100)}%`}</span>}
              {u.status === "done" && <span className="up-state ok"><CircleCheck size={14} aria-hidden /> Saved · <button className="link" onClick={() => onOpen(u.docId!)}>Open</button></span>}
              {u.status === "error" && (
                <span className="up-state err" role="alert"><CircleAlert size={14} aria-hidden /> {u.message}
                  {u.docId ? <> <button className="link" onClick={() => onOpen(u.docId!)}>Open the existing file</button></> : <> <button className="link" onClick={() => retry(u)}><RotateCcw size={12} aria-hidden /> Retry</button></>}
                </span>
              )}
              {u.status !== "uploading" && <button className="icon-btn" onClick={() => setUploads((all) => all.filter((x) => x.key !== u.key))} aria-label={`Dismiss ${u.file.name}`}><X size={14} /></button>}
            </li>
          ))}
        </ul>
      )}

      <form className="filters bar" role="search" aria-label="Search documents" onSubmit={(e) => e.preventDefault()}>
        <div className="search wide"><Search size={15} aria-hidden /><label htmlFor="doc-q" className="sr-only">Search documents</label>
          <input id="doc-q" ref={searchInput} type="search" placeholder="Search titles, tags and text (press / )" value={q} onChange={(e) => setQ(e.target.value)} />
          {loading && <span className="spinner small-spin" aria-hidden />}
        </div>
        <label className="sel"><span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} disabled={!!debounced} title={debounced ? "Search results are ordered by relevance" : undefined}>
            <option value="recent">Newest first</option><option value="name">Name</option><option value="size">Largest first</option>
          </select></label>
        <div className="seg" role="group" aria-label="Layout">
          <button type="button" className={layout === "grid" ? "on" : ""} aria-pressed={layout === "grid"} onClick={() => pickLayout("grid")} aria-label="Grid"><LayoutGrid size={15} aria-hidden /></button>
          <button type="button" className={layout === "list" ? "on" : ""} aria-pressed={layout === "list"} onClick={() => pickLayout("list")} aria-label="List"><List size={15} aria-hidden /></button>
        </div>
      </form>
      <div className="chips" role="group" aria-label="Filter by category">
        <button className={`chip-btn ${category === "" ? "on" : ""}`} aria-pressed={category === ""} onClick={() => setCategory("")}>All</button>
        {DOCUMENT_CATEGORIES.map((c) => <button key={c} className={`chip-btn ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{DOCUMENT_CATEGORY_LABEL[c]}</button>)}
      </div>

      <p className="result-count" role="status" aria-live="polite">
        {error ? "" : results === null ? "Loading documents…" : debounced ? `${count} result${count === 1 ? "" : "s"} for “${debounced}”` : `${count} document${count === 1 ? "" : "s"}${category ? ` in ${DOCUMENT_CATEGORY_LABEL[category]}` : ""}`}
      </p>
      {error && <p className="banner error" role="alert">{error} <button className="link" onClick={() => void load()}>Retry</button></p>}
      {results && results.length === 0 && !error && (
        <p className="empty-line">{debounced ? "Nothing matches. Search looks at titles, filenames, tags, descriptions, linked situations and extracted text." : "No documents yet. Upload a receipt, warranty or manual to get started."}</p>
      )}
      {results && results.length > 0 && (
        <ul className={`doc-grid ${layout === "list" ? "as-list" : ""}`} aria-label="Document library">{results.map((h) => <DocCard key={h.document.id} hit={h} fresh={fresh.has(h.document.id)} onOpen={onOpen} />)}</ul>
      )}
    </div>
  );
}
