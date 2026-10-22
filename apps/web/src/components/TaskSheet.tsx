import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import type { DocumentHit, SituationSummary, Task, TaskCategory, TaskWithContext } from "@homerelay/shared";
import { PRIORITIES, RECURRENCES, TASK_CATEGORIES, TASK_CATEGORY_LABEL } from "@homerelay/shared";
import { ApiError, api, type TaskInput } from "../api";
import { Overlay } from "./Overlay";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called only after the server has saved the task. */
  onCreated: (task: Task) => void;
  situations: SituationSummary[];
  /** Pre-select a situation (when adding from a situation page). */
  situationId?: string | null;
}

export function TaskSheet(p: Props) {
  return (
    <Overlay open={p.open} onClose={p.onClose} variant="sheet" label="New task">
      <Form {...p} />
    </Overlay>
  );
}

const RECUR_LABEL: Record<string, string> = { none: "Does not repeat", weekly: "Every week", monthly: "Every month" };

function Form({ onClose, onCreated, situations, situationId }: Omit<Props, "open">) {
  const uid = useId(); const fid = (n: string) => `${uid}-${n}`;
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [due, setDue] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("normal"); const [category, setCategory] = useState<TaskCategory>("general");
  const [sit, setSit] = useState(situationId ?? ""); const [dep, setDep] = useState(""); const [recurrence, setRecurrence] = useState<(typeof RECURRENCES)[number]>("none");
  const [tags, setTags] = useState(""); const [docs, setDocs] = useState<string[]>([]); const [more, setMore] = useState(false);
  const [openTasks, setOpenTasks] = useState<TaskWithContext[]>([]); const [docQ, setDocQ] = useState(""); const [docHits, setDocHits] = useState<DocumentHit[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({}); const [serverErr, setServerErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  useEffect(() => { api.tasks({ filter: "open" }).then((r) => setOpenTasks(r.tasks)).catch(() => undefined); }, []);
  useEffect(() => {
    const h = setTimeout(() => { api.documents({ q: docQ.trim() || undefined, limit: 8 }).then((r) => setDocHits(r.results)).catch(() => undefined); }, 200);
    return () => clearTimeout(h);
  }, [docQ]);
  // a prerequisite must be in the same situation or be a household task
  const depChoices = openTasks.filter((t) => !t.situation_id || !sit || t.situation_id === sit);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = "Give the task a short title.";
    if (recurrence !== "none" && !due) e.due = "A repeating task needs a due time.";
    if (tags.split(",").filter((t) => t.trim()).length > 12) e.tags = "Up to 12 tags.";
    setErrors(e); return Object.keys(e).length === 0;
  };
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy || !validate()) return;
    setBusy(true); setServerErr(null);
    const body: TaskInput = {
      title: title.trim(), description: desc.trim() || undefined, dueLocal: due || undefined, situationId: sit || undefined, priority, category,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean), recurrence, dependsOnTaskId: dep || undefined, documentIds: docs.length ? docs : undefined,
    };
    try {
      const r = await api.createTask(body);
      onCreated(r.task);
      onClose(); // only after the server confirmed the task exists
    } catch (e) {
      setServerErr(e instanceof ApiError ? e.message : "Could not save. Nothing was created.");
    } finally { setBusy(false); }
  };

  return (
    <form className="sheet-form" onSubmit={submit} noValidate>
      <header className="sheet-head">
        <div>
          <h2>New task</h2>
          <p>Only the title is required. A due time is stored with the task; HomeRelay does not send notifications.</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="sheet-scroll">
        <fieldset className="fgroup">
          <legend>The task</legend>
          <div className="field">
            <label htmlFor={fid("title")}>Title</label>
            <input id={fid("title")} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} aria-describedby={errors.title ? fid("title-e") : undefined} placeholder="e.g. Replace the water filter" autoComplete="off" autoFocus />
            {errors.title && <span className="err" id={fid("title-e")}>{errors.title}</span>}
          </div>
          <div className="field"><label htmlFor={fid("desc")}>Notes (optional)</label><textarea id={fid("desc")} rows={2} value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} /></div>
          <div className="row3">
            <div className="field">
              <label htmlFor={fid("due")}>Due</label>
              <input id={fid("due")} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-invalid={!!errors.due} aria-describedby={errors.due ? fid("due-e") : undefined} />
              {errors.due && <span className="err" id={fid("due-e")}>{errors.due}</span>}
            </div>
            <div className="field"><label htmlFor={fid("prio")}>Priority</label>
              <select id={fid("prio")} value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>{PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></div>
            <div className="field"><label htmlFor={fid("cat")}>Category</label>
              <select id={fid("cat")} value={category} onChange={(e) => setCategory(e.target.value as TaskCategory)}>{TASK_CATEGORIES.map((c) => <option key={c} value={c}>{TASK_CATEGORY_LABEL[c]}</option>)}</select></div>
          </div>
          <details className="more-options" open={more || recurrence !== "none" || !!tags || !!errors.tags} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)}>
          <summary>More options <span className="muted">repeats, tags</span></summary>
          <div className="row2">
            <div className="field"><label htmlFor={fid("rec")}>Repeats</label>
              <select id={fid("rec")} value={recurrence} onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}>{RECURRENCES.map((r) => <option key={r} value={r}>{RECUR_LABEL[r]}</option>)}</select>
              <span className="hint">The next one is saved when you complete this one.</span></div>
            <div className="field"><label htmlFor={fid("tags")}>Tags (optional)</label>
              <input id={fid("tags")} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="kitchen, filter" aria-invalid={!!errors.tags} />
              {errors.tags && <span className="err">{errors.tags}</span>}</div>
          </div>
          </details>
        </fieldset>

        <fieldset className="fgroup">
          <legend>Connections <span>(optional)</span></legend>
          <div className="row2">
            <div className="field"><label htmlFor={fid("sit")}>Situation</label>
              <select id={fid("sit")} value={sit} onChange={(e) => { setSit(e.target.value); setDep(""); }}>
                <option value="">None (household task)</option>
                {situations.filter((s) => s.status !== "resolved").map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select></div>
            <div className="field"><label htmlFor={fid("dep")}>Must happen after</label>
              <select id={fid("dep")} value={dep} onChange={(e) => setDep(e.target.value)}>
                <option value="">Nothing</option>
                {depChoices.map((t) => <option key={t.id} value={t.id}>{t.title}{t.situation_title ? ` · ${t.situation_title}` : ""}</option>)}
              </select></div>
          </div>
          <div className="field">
            <label htmlFor={fid("docq")}>Attach documents</label>
            <input id={fid("docq")} type="search" value={docQ} onChange={(e) => setDocQ(e.target.value)} placeholder="Search your documents…" />
            <ul className="pick-docs" aria-label="Documents to attach">
              {docHits.map((h) => (
                <li key={h.document.id}><label className="check"><input type="checkbox" checked={docs.includes(h.document.id)}
                  onChange={(e) => setDocs((d) => e.target.checked ? [...d, h.document.id] : d.filter((x) => x !== h.document.id))} /> {h.document.title}</label></li>
              ))}
              {!docHits.length && <li className="muted small">No documents match.</li>}
            </ul>
            {docs.length > 0 && <span className="hint">{docs.length} selected</span>}
          </div>
        </fieldset>
        <div aria-live="polite">{serverErr && <p className="banner error" role="alert">{serverErr}</p>}</div>
      </div>
      <footer className="sheet-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy && <span className="spinner" aria-hidden />} Create task</button>
      </footer>
    </form>
  );
}
