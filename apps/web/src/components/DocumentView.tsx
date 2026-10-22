import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleAlert, Download, Link2, MessageCircle, Trash2, Unlink } from "lucide-react";
import type { DocumentCategory, DocumentSummary, DocumentText, SituationSummary, TaskWithContext } from "@homerelay/shared";
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import { ApiError, api, documentUrl } from "../api";
import { DocIcon, StatusBadge, formatBytes, useLocal } from "../ui";

interface Props {
  doc: DocumentSummary;
  text: DocumentText | null;
  situations: SituationSummary[];
  busy: boolean;
  onBack: () => void;
  onAsk: () => void;
  onOpenSituation: (id: string) => void;
  onOpenTask: (id: string) => void;
  /** Runs a mutation through the app's act(): refreshes from the server and reports the real outcome. */
  run: (fn: () => Promise<string | void>) => Promise<void>;
  onDeleted: () => void;
}

const EXTRACTION_LABEL: Record<DocumentSummary["extraction_status"], string> = {
  completed: "Text extracted", unsupported: "No text extraction", failed: "Could not read", pending: "Extraction pending", not_required: "No text needed",
};

export function DocumentView({ doc: d, text, situations, busy, onBack, onAsk, onOpenSituation, onOpenTask, run, onDeleted }: Props) {
  const local = useLocal();
  const [title, setTitle] = useState(d.title); const [category, setCategory] = useState<DocumentCategory>(d.category);
  const [tags, setTags] = useState(d.tags.join(", ")); const [description, setDescription] = useState(d.description); const [notes, setNotes] = useState(d.notes);
  const [linkTo, setLinkTo] = useState(""); const [confirmDelete, setConfirmDelete] = useState(false); const [formErr, setFormErr] = useState<string | null>(null);
  useEffect(() => { setTitle(d.title); setCategory(d.category); setTags(d.tags.join(", ")); setDescription(d.description); setNotes(d.notes); }, [d]);
  const tagList = useMemo(() => tags.split(",").map((t) => t.trim()).filter(Boolean), [tags]);
  const dirty = title !== d.title || category !== d.category || tagList.join(",") !== d.tags.join(",") || description !== d.description || notes !== d.notes;
  const linkable = situations.filter((s) => s.status !== "resolved" && !d.linked_situations.some((l) => l.id === s.id));
  const pages = text?.pages.filter((p) => p.text.trim()) ?? [];

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setFormErr("A title is required."); return; }
    setFormErr(null);
    void run(async () => { await api.updateDocument(d.id, { title: title.trim(), category, tags: tagList, description, notes }); return "Document details saved."; });
  };

  return (
    <div className="page detail docdetail">
      <button className="btn ghost small back" onClick={onBack}><ArrowLeft size={14} aria-hidden /> All documents</button>
      <header className={`d-head kind-${d.kind}`}>
        <DocIcon kind={d.kind} size={24} />
        <div className="d-title">
          <p className="eyebrow">{DOCUMENT_CATEGORY_LABEL[d.category]} · {d.kind.toUpperCase()}</p>
          <h1>{d.title}</h1>
          <p className="d-meta"><span>{d.original_filename}</span><span>{formatBytes(d.size_bytes)}</span><span>Added {local(d.created_at)}</span>{d.page_count ? <span>{d.page_count} page{d.page_count === 1 ? "" : "s"}</span> : null}</p>
        </div>
        <div className="d-actions">
          <button className="btn primary" onClick={onAsk}><MessageCircle size={16} aria-hidden /> Ask about this document</button>
          <a className="btn" href={documentUrl.download(d.id)} download><Download size={16} aria-hidden /> Download</a>
        </div>
      </header>

      <div className="detail-grid">
        <div className="main-col">
          {d.kind === "text" ? (
            // a text file IS its extracted text: one panel, not a preview plus an echo of it
            <section className="panel preview" aria-label="Content">
              <h2>Content <span className={`tag ${d.extraction_status === "completed" ? "ok" : "muted"}`}>{EXTRACTION_LABEL[d.extraction_status]}</span></h2>
              {pages.length ? <pre className="doc-text">{pages.map((p) => p.text).join("\n")}</pre> : <p className="muted">This file has no text.</p>}
              <p className="fine">Search and the assistant use this stored text. It is reference material only: HomeRelay never follows instructions written inside a document.</p>
            </section>
          ) : (
          <section className="panel preview" aria-label="Preview">
            <h2>Preview</h2>
            {d.kind === "image" && <img className="doc-img" src={documentUrl.content(d.id)} alt={d.description || d.title} />}
            {d.kind === "pdf" && <iframe className="doc-pdf" src={documentUrl.content(d.id)} title={`Preview of ${d.title}`} />}
          </section>
          )}

          {d.kind !== "text" && <section className="panel" aria-label="Extracted text">
            <h2>Extracted text <span className={`tag ${d.extraction_status === "completed" ? "ok" : d.extraction_status === "failed" ? "late" : "muted"}`}>{EXTRACTION_LABEL[d.extraction_status]}</span></h2>
            {d.extraction_note && <p className="note"><CircleAlert size={14} aria-hidden /> {d.extraction_note}</p>}
            {d.kind === "pdf" && pages.length > 0 && (
              <details>
                <summary>Show the text HomeRelay stored ({d.text_chars.toLocaleString()} characters{text?.truncated ? ", first part" : ""})</summary>
                {pages.map((p) => <div key={p.page} className="page-text"><span className="eyebrow">Page {p.page}</span><pre className="doc-text">{p.text}</pre></div>)}
              </details>
            )}
            <p className="fine">Search and the assistant use this stored text. It is reference material only: HomeRelay never follows instructions written inside a document.</p>
          </section>}
        </div>

        <aside className="side-col">
          <section className="panel" aria-label="Details">
            <h2>Details</h2>
            <form className="meta-form" onSubmit={save}>
              <div className="field"><label htmlFor="dm-title">Title</label><input id="dm-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!formErr} />{formErr && <span className="err">{formErr}</span>}</div>
              <div className="field"><label htmlFor="dm-cat">Category</label>
                <select id="dm-cat" value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}>{DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{DOCUMENT_CATEGORY_LABEL[c]}</option>)}</select></div>
              <div className="field"><label htmlFor="dm-tags">Tags</label><input id="dm-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated" /><span className="hint">Up to 12. Used by search.</span></div>
              <div className="field"><label htmlFor="dm-desc">Description</label><textarea id="dm-desc" rows={2} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What is it? Model, purchase, appliance…" /></div>
              <div className="field"><label htmlFor="dm-notes">Notes</label><textarea id="dm-notes" rows={2} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} /></div>
              <button type="submit" className="btn primary" disabled={!dirty || busy}>Save details</button>
            </form>
          </section>

          <section className="panel" aria-label="Linked situations">
            <h2>Linked situations <span className="count">{d.linked_situations.length}</span></h2>
            {d.linked_situations.length === 0 && <p className="muted">Not attached to any situation.</p>}
            <ul className="links">
              {d.linked_situations.map((s) => (
                <li key={s.id}>
                  <button className="link" onClick={() => onOpenSituation(s.id)}>{s.title}</button> <StatusBadge status={s.status} />
                  <button className="btn small ghost" disabled={busy} onClick={() => run(async () => { await api.unlinkDocument(d.id, s.id); return `Detached from ${s.title}.`; })} aria-label={`Detach from ${s.title}`}><Unlink size={13} aria-hidden /> Detach</button>
                </li>
              ))}
            </ul>
            {linkable.length > 0 && (
              <div className="link-row">
                <label htmlFor="dm-link" className="sr-only">Attach to a situation</label>
                <select id="dm-link" value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
                  <option value="">Attach to a situation…</option>
                  {linkable.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
                <button className="btn small" disabled={!linkTo || busy} onClick={() => { const sid = linkTo; setLinkTo(""); void run(async () => { await api.linkDocument(d.id, sid); return "Document attached."; }); }}><Link2 size={13} aria-hidden /> Attach</button>
              </div>
            )}
          </section>

          <LinkedTasks doc={d} busy={busy} run={run} onOpenTask={onOpenTask} />

          <section className="panel danger-zone" aria-label="Delete document">
            {!confirmDelete ? (
              <button className="btn small ghost" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 size={14} aria-hidden /> Delete document…</button>
            ) : (
              <div className="confirm" role="group" aria-label="Confirm deletion">
                <span>Delete “{d.title}” and its stored file permanently?{d.linked_situations.length ? ` It will be detached from ${d.linked_situations.length} situation(s); the situations are kept.` : ""}</span>
                <button className="btn small danger" disabled={busy} onClick={() => run(async () => {
                  try { await api.deleteDocument(d.id); onDeleted(); return "Document deleted."; }
                  catch (e) { setConfirmDelete(false); throw e instanceof ApiError ? e : new Error("Delete failed."); }
                })}>Delete permanently</button>
                <button className="btn small" onClick={() => setConfirmDelete(false)}>Keep it</button>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Tasks this document is attached to, and attaching it to another open task. */
function LinkedTasks({ doc: d, busy, run, onOpenTask }: { doc: DocumentSummary; busy: boolean; run: Props["run"]; onOpenTask: (id: string) => void }) {
  const [open, setOpen] = useState<TaskWithContext[]>([]); const [pick, setPick] = useState("");
  useEffect(() => { api.tasks({ filter: "open" }).then((r) => setOpen(r.tasks)).catch(() => undefined); }, [d.linked_tasks.length]);
  const choices = open.filter((t) => !d.linked_tasks.some((x) => x.id === t.id));
  return (
    <section className="panel" aria-label="Linked tasks">
      <h2>Linked tasks <span className="count">{d.linked_tasks.length}</span></h2>
      {d.linked_tasks.length === 0 && <p className="muted">Not attached to any task.</p>}
      <ul className="links">
        {d.linked_tasks.map((t) => (
          <li key={t.id}>
            <button className="link" onClick={() => onOpenTask(t.id)}>{t.title}</button> <StatusBadge status={t.status} />
            <button className="btn small ghost" disabled={busy} onClick={() => run(async () => { await api.unlinkTaskDocument(t.id, d.id); return `Detached from ${t.title}.`; })} aria-label={`Detach from task ${t.title}`}>Detach</button>
          </li>
        ))}
      </ul>
      {choices.length > 0 && (
        <div className="link-row">
          <label htmlFor="dm-task" className="sr-only">Attach to a task</label>
          <select id="dm-task" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Attach to a task…</option>
            {choices.map((t) => <option key={t.id} value={t.id}>{t.title}{t.situation_title ? ` · ${t.situation_title}` : ""}</option>)}
          </select>
          <button className="btn small" disabled={!pick || busy} onClick={() => { const tid = pick; setPick(""); void run(async () => { await api.linkTaskDocument(tid, d.id); return "Document attached to the task."; }); }}>Attach</button>
        </div>
      )}
    </section>
  );
}
