import { useEffect, useRef, useState } from "react";
import { Link2, Paperclip, Unlink, Upload } from "lucide-react";
import type { DocumentHit, DocumentSummary } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";
import { api, uploadDocument } from "../api";
import { makeSequencer } from "../logic";
import { DocIcon, formatBytes } from "../ui";
import { ACCEPT } from "./DocumentsView";

interface Props {
  situationId: string;
  documents: DocumentSummary[];
  busy: boolean;
  resolved: boolean;
  onOpen: (id: string) => void;
  run: (fn: () => Promise<string | void>) => Promise<void>;
}

/** Files that belong to this situation, from the stored links. Attach existing ones or upload straight into it. */
export function SituationDocuments({ situationId, documents, busy, resolved, onOpen, run }: Props) {
  const [picking, setPicking] = useState(false); const [q, setQ] = useState(""); const [hits, setHits] = useState<DocumentHit[] | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const seq = useRef(makeSequencer()); const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!picking) return;
    const n = seq.current.next("pick");
    const h = setTimeout(() => { api.documents({ q: q.trim(), limit: 8 }).then((r) => { if (seq.current.isLatest("pick", n)) setHits(r.results); }).catch(() => setHits([])); }, 200);
    return () => clearTimeout(h);
  }, [q, picking]);

  const upload = (f: File | undefined) => {
    if (!f) return;
    setUploading(f.name);
    void run(async () => {
      try { await uploadDocument(f, { situationId }); return `Uploaded and attached ${f.name}.`; }
      finally { setUploading(null); }
    });
  };
  const candidates = (hits ?? []).filter((h) => !documents.some((d) => d.id === h.document.id));

  return (
    <section className="panel" aria-label="Situation documents">
      <h2>Documents <span className="count">{documents.length}</span></h2>
      {documents.length === 0 && <p className="muted">No documents attached.</p>}
      <ul className="att-docs">
        {documents.map((d) => (
          <li key={d.id}>
            <button className="doc-mini" onClick={() => onOpen(d.id)} aria-label={`Open document: ${d.title}`}>
              <DocIcon kind={d.kind} /><span><strong>{d.title}</strong><span className="muted">{DOCUMENT_CATEGORY_LABEL[d.category]} · {formatBytes(d.size_bytes)}</span></span>
            </button>
            <button className="icon-btn" disabled={busy} aria-label={`Detach ${d.title}`} title="Detach (the document is kept)"
              onClick={() => run(async () => { await api.unlinkDocument(d.id, situationId); return `Detached ${d.title}.`; })}><Unlink size={14} /></button>
          </li>
        ))}
      </ul>
      {!resolved && (
        <div className="doc-actions">
          <button className="btn small" onClick={() => { setPicking((p) => !p); setQ(""); }} aria-expanded={picking}><Paperclip size={14} aria-hidden /> Attach existing</button>
          <button className="btn small" disabled={!!uploading} onClick={() => file.current?.click()}>{uploading ? <span className="spinner" aria-hidden /> : <Upload size={14} aria-hidden />} {uploading ? `Uploading ${uploading}…` : "Upload & attach"}</button>
          <input ref={file} type="file" accept={ACCEPT} hidden aria-label="Choose a file to upload and attach" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      )}
      {picking && (
        <div className="picker">
          <label htmlFor={`pick-${situationId}`} className="sr-only">Find a document to attach</label>
          <input id={`pick-${situationId}`} type="search" autoFocus placeholder="Find a document…" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits !== null && candidates.length === 0 && <p className="fine">{q ? "No matching documents." : "No other documents stored yet."}</p>}
          <ul>
            {candidates.map((h) => (
              <li key={h.document.id}>
                <span><DocIcon kind={h.document.kind} size={14} /> {h.document.title}</span>
                <button className="btn small" disabled={busy} onClick={() => run(async () => { await api.linkDocument(h.document.id, situationId); setPicking(false); return `Attached ${h.document.title}.`; })}><Link2 size={13} aria-hidden /> Attach</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
