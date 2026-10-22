import { useId, useState } from "react";
import { X } from "lucide-react";
import { ApiError, type NewSituationInput } from "../api";
import { Overlay } from "./Overlay";

type Cat = NewSituationInput["category"];

const TYPES: { value: Cat; label: string; hint: string; start: string; end?: string; home?: string }[] = [
  { value: "delivery", label: "Delivery", hint: "A package arrives while you may be unavailable.", start: "Delivery window starts", end: "Delivery window ends", home: "You are free from" },
  { value: "maintenance", label: "Maintenance appointment", hint: "A technician visits during a time window.", start: "Window starts", end: "Window ends", home: "You will be home from" },
  { value: "family_visit", label: "Family visit", hint: "People are arriving and you need to prepare.", start: "They arrive", home: "You will be home from" },
  { value: "general", label: "Something else", hint: "Track a one-off follow-up.", start: "When (optional)" },
];

interface Props { open: boolean; onClose: () => void; onSubmit: (b: NewSituationInput) => Promise<void> }

export function NewSituationSheet({ open, onClose, onSubmit }: Props) {
  return (
    <Overlay open={open} onClose={onClose} variant="sheet" label="New situation">
      <Form onClose={onClose} onSubmit={onSubmit} />
    </Overlay>
  );
}

function Form({ onClose, onSubmit }: Omit<Props, "open">) {
  const uid = useId();
  const [cat, setCat] = useState<Cat>("delivery");
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState("");
  const [start, setStart] = useState(""); const [end, setEnd] = useState(""); const [home, setHome] = useState("");
  const [alone, setAlone] = useState(false); const [task, setTask] = useState(""); const [taskDue, setTaskDue] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({}); const [serverErr, setServerErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = TYPES.find((x) => x.value === cat)!;
  const fid = (n: string) => `${uid}-${n}`;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = "Give it a short title.";
    if (start && end && end <= start) e.end = "The end must be after the start.";
    if (cat === "maintenance" && !start) e.start = "A maintenance appointment needs a start time.";
    if (cat === "family_visit" && !start) e.start = "Add when they arrive so I can plan backwards from it.";
    setErrors(e); return Object.keys(e).length === 0;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy || !validate()) return;
    setBusy(true); setServerErr(null);
    try {
      await onSubmit({
        title: title.trim(), category: cat, description: desc.trim() || undefined,
        startLocal: start || undefined, windowEndLocal: end || undefined, availableFromLocal: home || undefined,
        nobodyElseHome: cat === "delivery" && alone ? true : undefined,
        initialTaskTitle: task.trim() || undefined, initialTaskDueLocal: task.trim() && taskDue ? taskDue : undefined,
      });
      onClose(); // only after the server confirmed the situation exists
    } catch (e) {
      setServerErr(e instanceof ApiError ? e.message : "Could not save. Nothing was created.");
    } finally { setBusy(false); }
  };

  return (
    <form className="sheet-form" onSubmit={submit} noValidate>
      <header className="sheet-head">
        <div>
          <h2>New situation</h2>
          <p>Times are in your local time zone. Only the title is required; HomeRelay asks for anything else it needs later.</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="sheet-scroll">
        <fieldset className="fgroup">
          <legend>The basics</legend>
          <div className="field">
            <label htmlFor={fid("type")}>Type</label>
            <select id={fid("type")} value={cat} onChange={(e) => setCat(e.target.value as Cat)}>{TYPES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
            <span className="hint">{t.hint}</span>
          </div>
          <div className="field">
            <label htmlFor={fid("title")}>Title</label>
            <input id={fid("title")} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} aria-describedby={errors.title ? fid("title-e") : undefined} placeholder="e.g. Boiler service" autoComplete="off" />
            {errors.title && <span className="err" id={fid("title-e")}>{errors.title}</span>}
          </div>
          <div className="field">
            <label htmlFor={fid("desc")}>Details (optional)</label>
            <textarea id={fid("desc")} rows={2} value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} />
          </div>
        </fieldset>

        <fieldset className="fgroup">
          <legend>Timing</legend>
          <div className="row2">
            <div className="field">
              <label htmlFor={fid("start")}>{t.start}</label>
              <input id={fid("start")} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={!!errors.start} aria-describedby={errors.start ? fid("start-e") : undefined} />
              {errors.start && <span className="err" id={fid("start-e")}>{errors.start}</span>}
            </div>
            {t.end && (
              <div className="field">
                <label htmlFor={fid("end")}>{t.end}</label>
                <input id={fid("end")} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={!!errors.end} aria-describedby={errors.end ? fid("end-e") : undefined} />
                {errors.end && <span className="err" id={fid("end-e")}>{errors.end}</span>}
              </div>
            )}
          </div>
          {t.home && (
            <div className="field">
              <label htmlFor={fid("home")}>{t.home} (optional)</label>
              <input id={fid("home")} type="datetime-local" value={home} onChange={(e) => setHome(e.target.value)} />
            </div>
          )}
        </fieldset>

        {cat === "delivery" && (
          <fieldset className="fgroup">
            <legend>Household</legend>
            <label className="check"><input type="checkbox" checked={alone} onChange={(e) => setAlone(e.target.checked)} /> Nobody else will be home</label>
          </fieldset>
        )}

        <fieldset className="fgroup">
          <legend>First task <span>(optional)</span></legend>
          <div className="row2">
            <div className="field"><label htmlFor={fid("task")}>Task</label><input id={fid("task")} value={task} maxLength={200} onChange={(e) => setTask(e.target.value)} autoComplete="off" /></div>
            <div className="field"><label htmlFor={fid("tdue")}>Due</label><input id={fid("tdue")} type="datetime-local" value={taskDue} disabled={!task.trim()} onChange={(e) => setTaskDue(e.target.value)} /></div>
          </div>
        </fieldset>

        <div aria-live="polite">{serverErr && <p className="banner error" role="alert">{serverErr}</p>}</div>
      </div>

      <footer className="sheet-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy && <span className="spinner" aria-hidden />} Create situation</button>
      </footer>
    </form>
  );
}
