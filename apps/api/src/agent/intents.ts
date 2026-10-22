import type { ActivityEvent, Connections, EntityRef, SearchResult, SituationDetail, SituationSummary, Task, TaskWithContext } from "@homerelay/shared";
import { formatClock, formatLocal, localDatePlus, nextLocalTimeIso, parseClockTime, zonedToUtcIso } from "@homerelay/shared";
import { McpToolError } from "../gateway";

/**
 * Household intents for the rules agent. Each intent retrieves real records through MCP tools before it answers and
 * only reports what those tools returned. Phrasing is normalised first (contractions, common misspellings) so ordinary
 * variants reach the same intent; nothing here guesses at facts it did not read.
 */

export type Call = <T = any>(tool: string, args?: Record<string, unknown>) => Promise<T>;
export interface IntentContext { situationId: string | null; documentId: string | null; taskId: string | null; tz: string; now: () => Date }
export interface IntentResult { reply: string; entities?: EntityRef[]; clarification?: string | null; situationId?: string | null }

const TYPOS: [RegExp, string][] = [
  [/\b(warrenty|waranty|warrantee|warrnty)\b/g, "warranty"], [/\b(reciept|recipt|receit|recept)\b/g, "receipt"],
  [/\b(tommorow|tomorow|tommorrow|tmrw|tmr)\b/g, "tomorrow"], [/\b(maintainance|maintenence|maintanance)\b/g, "maintenance"],
  [/\b(techician|technitian|techincian|tech)\b/g, "technician"], [/\b(electrican|electritian)\b/g, "electrician"], [/\b(plummer|plumer)\b/g, "plumber"],
  [/\b(pls|plz)\b/g, "please"], [/\b(tsk|taks)\b/g, "task"], [/\b(docs)\b/g, "documents"], [/\b(appt)\b/g, "appointment"],
];
const CONTRACTIONS: [RegExp, string][] = [
  [/\bwhat'?s\b/g, "what is"], [/\bwhere'?s\b/g, "where is"], [/\bwho'?s\b/g, "who is"], [/\bit'?s\b/g, "it is"], [/\bthat'?s\b/g, "that is"],
  [/\bi'?m\b/g, "i am"], [/\bcan'?t\b/g, "cannot"], [/\bwon'?t\b/g, "will not"], [/\bdon'?t\b/g, "do not"], [/\bdoesn'?t\b/g, "does not"],
  [/\bisn'?t\b/g, "is not"], [/\bi'?ve\b/g, "i have"], [/\bi'?ll\b/g, "i will"],
];
/** Lower case, straight quotes, contractions expanded, common misspellings fixed, punctuation (except ':' and '?') removed. */
export function normalize(msg: string): string {
  let s = msg.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  for (const [re, to] of TYPOS) s = s.replace(re, to);
  return s.replace(/[^\p{L}\p{N}\s:?'"-]/gu, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set("a an the my our me i is are was were be to of in on for and or it this that these those what which who where when how do does did can could would should will please show find tell give list any all about with from at by there have has had get need needs you your up just".split(" "));
export const contentWords = (norm: string) => [...new Set(norm.replace(/[?:'"]/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w)))];

const OPEN = new Set(["pending", "in_progress", "blocked"]);
const ref = (t: { id: string; title: string; status: string; situation_title?: string | null; due_at?: string | null }, tz: string): EntityRef => ({
  key: `task:${t.id}`, type: "task", id: t.id, title: t.title, status: t.status, route: `#/task/${t.id}`,
  subtitle: `Task${t.due_at ? ` · due ${formatLocal(t.due_at, tz)}` : ""}${t.situation_title ? ` · ${t.situation_title}` : t.situation_title === null ? " · household task" : ""}`,
});
const sitRef = (s: { id: string; title: string; status: string; category: string }): EntityRef => ({ key: `situation:${s.id}`, type: "situation", id: s.id, title: s.title, status: s.status, route: `#/situation/${s.id}`, subtitle: `Situation · ${s.category.replace("_", " ")}` });
const strip = (r: EntityRef): EntityRef => ({ key: r.key, type: r.type, id: r.id, title: r.title, status: r.status, subtitle: r.subtitle, route: r.route });
const quoteList = (items: string[]) => items.map((x) => `• ${x}`).join("\n");

export const RX = {
  connections: /\b(everything|anything|all (the )?(things|records|stuff))\b.*\b(connected|linked|related|attached|associated)\b|\bconnections?\b|\bconnected to\b|\bknowledge map\b|\bwhat goes with\b/,
  blocked: /\b(blocked|stuck|waiting on|waiting for|cannot (start|do|finish|complete)|held up|dependenc(y|ies))\b/,
  overdue: /\b(overdue|past due|missed|late tasks?|behind)\b/,
  today: /\b(on my plate|needs? (my )?attention|due today|agenda|priorities|prioritise|prioritize|what (is|do i have) (on )?today|today'?s (tasks|list|plan)|what should i (do|focus on)( first| today| now)?|what is (due|happening) today|what needs doing)\b/,
  before: /\bbefore\b.*\b(arrive|arrives|arrival|arriving|comes|coming|visit|appointment|technician|plumber|electrician|delivery|guests?|parents|they get here)\b/,
  createTask: /^(?:please )?(?:add|create|make|new|save)(?: a| another| new)? (?:task|todo|to-do|to do|reminder)\b[:\s-]*(?:to |for |that )?(.+)$|^(?:please )?remind me to (.+)$|^(?:please )?add "?(.+?)"? to (?:my )?(?:tasks|task list|to-?do list|list)$/,
  completeTask: /^(?:please )?(?:mark|set|tick( off)?|check off)\s+(.+?)\s+(?:as )?(?:done|complete|completed|finished)$|^(?:i (?:have )?(?:finished|completed|did|done)|finished|completed|done with|i am done with)\s+(.+)$|^(.+?)\s+(?:is|are) (?:done|finished|complete|completed)$/,
  activity: /\b(what happened|history|recent activity|activity log|what changed|what did (i|you) do|timeline|log of)\b/,
  electrical: /\b(fuse|fuses|breaker|breakers|circuit|tripped|trip switch|rcd|rcbo|mcb|consumer unit|fuse ?box|distribution board|power (cut|outage|went|is out|is off)|no power|lost power|electricity (is )?(off|out|gone))\b/,
};
const CATEGORY_WORDS: [RegExp, string][] = [[/\b(maintenance|repair|technician|plumber|electrician|fix)\b/, "maintenance"], [/\b(delivery|package|parcel|courier)\b/, "delivery"], [/\b(visit|guests?|parents|family)\b/, "family_visit"]];

/** Finds the situation a message is about: the open one, else one named in the message, else the only one of a mentioned kind. */
async function situationFromMessage(norm: string, ctx: IntentContext, call: Call): Promise<{ id: string } | { clarify: string; entities: EntityRef[] } | null> {
  if (ctx.situationId) return { id: ctx.situationId };
  const words = contentWords(norm).filter((w) => !["issue", "situation", "connected", "linked", "related", "everything", "attached", "tasks", "task", "happen", "arrives", "arrive"].includes(w));
  if (words.length) {
    const hits = (await call<{ results: SearchResult[] }>("search_household", { query: words.join(" "), types: ["situation"], limit: 5 })).results.filter((r) => r.status !== "resolved");
    if (hits.length === 1) return { id: hits[0].id };
  }
  const cat = CATEGORY_WORDS.find(([re]) => re.test(norm))?.[1];
  const open = (await call<{ situations: SituationSummary[] }>("list_open_situations", { limit: 20 })).situations;
  const pool = cat ? open.filter((s) => s.category === cat) : open;
  if (pool.length === 1) return { id: pool[0].id };
  if (pool.length > 1) return { clarify: "Which situation do you mean?", entities: pool.slice(0, 6).map(sitRef) };
  return null;
}

/** Best open task for a phrase, by word overlap with titles. Ambiguity is returned, never resolved by guessing. */
async function findTask(phrase: string, call: Call): Promise<{ task: TaskWithContext } | { many: TaskWithContext[] } | null> {
  const words = contentWords(phrase);
  if (!words.length) return null;
  const open = (await call<{ tasks: TaskWithContext[] }>("list_tasks", { filter: "open", limit: 500 })).tasks;
  const scored = open.map((t) => {
    const tw = contentWords(normalize(t.title));
    const hit = tw.filter((w) => words.some((p) => p === w || (p.length > 3 && w.startsWith(p.slice(0, -1))) || (w.length > 3 && p.startsWith(w.slice(0, -1))))).length;
    return { t, score: tw.length ? hit / tw.length : 0, hit };
  }).filter((x) => x.hit > 0 && x.score >= 0.5).sort((a, b) => b.score - a.score || b.hit - a.hit);
  if (!scored.length) return null;
  const top = scored.filter((x) => x.score === scored[0].score && x.hit === scored[0].hit);
  return top.length === 1 ? { task: top[0].t } : { many: top.map((x) => x.t) };
}

function dueFrom(norm: string, ctx: IntentContext): { due: string | null; rest: string } {
  const clock = parseClockTime(norm);
  const off = /\btomorrow\b/.test(norm) ? 1 : /\b(today|tonight)\b/.test(norm) ? 0 : null;
  const rest = norm
    .replace(/\b(by|at|before|on)?\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b/g, " ").replace(/\b(today|tonight|tomorrow)\b/g, " ")
    .replace(/\b(morning|afternoon|evening)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!clock && off === null) return { due: null, rest };
  const t = clock ?? { h: 9, mi: 0 };
  if (off !== null) { const d = localDatePlus(ctx.now(), off, ctx.tz); return { due: zonedToUtcIso(d.y, d.mo, d.d, t.h, t.mi, ctx.tz), rest }; }
  return { due: nextLocalTimeIso(ctx.now(), t.h, t.mi, ctx.tz), rest };
}

function describeConnections(c: Connections): string {
  const groups = new Map<string, string[]>();
  for (const r of c.related) {
    const label = r.type === "task" ? "Tasks" : r.type === "document" ? "Documents" : "Situations";
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(`${r.title} (${r.relation}${r.via ? `: ${r.via}` : ""}${r.type === "task" ? `, ${r.status.replace("_", " ")}` : ""})`);
  }
  const parts = [...groups.entries()].map(([k, v]) => `${k}:\n${quoteList(v)}`);
  const gaps = c.gaps.length ? `\nWorth knowing:\n${quoteList(c.gaps)}` : "";
  return parts.length ? `Everything stored as connected to "${c.center.title}":\n${parts.join("\n")}${gaps}` : `Nothing is connected to "${c.center.title}" yet.${gaps}`;
}

export async function householdIntent(raw: string, ctx: IntentContext, call: Call): Promise<IntentResult | null> {
  const norm = normalize(raw);
  const fmt = (iso: string | null | undefined) => formatClock(iso, ctx.tz);

  // Electrical: retrieve what is stored, never invent circuits, and keep advice to what is safe for anyone.
  if (RX.electrical.test(norm)) {
    const found = new Map<string, SearchResult>();
    for (const q of ["fuse", "breaker", "circuit", "electrical", "consumer unit", "electrician"]) {
      for (const r of (await call<{ results: SearchResult[] }>("search_household", { query: q, limit: 5 })).results) found.set(r.key, r);
    }
    const safety = "For safety: only switch a tripped breaker back on, and do not remove panel covers or touch wiring. If it trips again straight away, or you notice burning smells, heat or scorch marks, leave it off and call a qualified electrician.";
    if (found.size) {
      const list = [...found.values()].slice(0, 6);
      return { reply: `I cannot see your electrical panel, but these stored records mention it:\n${quoteList(list.map((r) => `${r.title} (${r.subtitle})`))}\n${safety}`, entities: list.map(strip), clarification: "Which room or appliance lost power?" };
    }
    return {
      reply: `I have no record of your fuse box or circuits, so I cannot tell which one is off. Which room or appliance lost power? If you have the consumer unit's labels or an electrician's report, upload it on Documents and I can search it.\n${safety}`,
      clarification: "Which room or appliance lost power?",
    };
  }

  // Create a task from a sentence ("add a task to buy a filter tomorrow at 5 pm", "remind me to call the plumber").
  const create = RX.createTask.exec(norm);
  if (create) {
    const body = (create[1] ?? create[2] ?? create[3] ?? "").trim();
    const { due, rest } = dueFrom(body, ctx);
    const title = rest.replace(/^(to|that|for)\s+/, "").replace(/\s+(to|for) (this|the) (situation|task list)$/, "").trim();
    if (!title) return { reply: "What should the task say?", clarification: "What should the task say?" };
    const nice = title[0].toUpperCase() + title.slice(1);
    try {
      const r = await call<{ task: Task }>("add_task", { title: nice, due_at: due ?? undefined, situation_id: ctx.situationId ?? undefined, actor: "user" });
      const where = ctx.situationId ? "in this situation" : "as a household task";
      const reminder = /^(please )?remind me/.test(norm) ? " It is saved with a due time; HomeRelay does not send notifications." : "";
      return { reply: `Saved "${r.task.title}" ${where}${due ? `, due ${formatLocal(due, ctx.tz)}` : ""}.${reminder}`, entities: [ref({ ...r.task, situation_title: ctx.situationId ? undefined : null }, ctx.tz)] };
    } catch (e) {
      if (e instanceof McpToolError && e.code === "DUPLICATE") return { reply: `There is already an open task called "${nice}" there, so I did not add another.`, clarification: null };
      throw e;
    }
  }

  // Complete a task by name, only on an explicit statement and only when exactly one open task matches.
  const done = RX.completeTask.exec(norm);
  if (done) {
    const phrase = (done[2] ?? done[3] ?? done[4] ?? "").trim();
    const m = await findTask(phrase, call);
    if (m && "task" in m) {
      try {
        await call("update_task_status", { task_id: m.task.id, status: "completed", confirmed_by_user: true, note: `User said: "${raw.slice(0, 120)}"`, actor: "user" });
        return { reply: `Marked "${m.task.title}" done, based on what you told me.`, entities: [ref({ ...m.task, status: "completed" }, ctx.tz)] };
      } catch (e) {
        if (e instanceof McpToolError && e.code === "DEPENDENCY_INCOMPLETE") {
          return { reply: `I did not mark "${m.task.title}" done: ${e.message}. Finish that first, or remove the dependency on the task page.`, entities: [ref(m.task, ctx.tz)] };
        }
        throw e;
      }
    }
    if (m && "many" in m) return { reply: `More than one open task matches, so I did not change anything:\n${quoteList(m.many.map((t) => t.title))}\nWhich one is done?`, entities: m.many.slice(0, 6).map((t) => ref(t, ctx.tz)), clarification: "Which task is done?" };
    // no task matches: let the situation flows (e.g. "the repair is finished") handle it
  }

  // Everything connected to the open record, or to a situation named in the message.
  if (RX.connections.test(norm)) {
    let type: "situation" | "task" | "document" | null = ctx.taskId ? "task" : ctx.documentId ? "document" : null;
    let id = ctx.taskId ?? ctx.documentId ?? null;
    if (!id) {
      const s = await situationFromMessage(norm, ctx, call);
      if (s && "clarify" in s) return { reply: `${s.clarify}\n${quoteList(s.entities.map((e) => e.title))}`, entities: s.entities, clarification: s.clarify };
      if (s) { type = "situation"; id = s.id; }
    }
    if (!type || !id) return { reply: "Open the situation, task or document you mean (or name it), and I will show everything stored as connected to it.", clarification: "Which record do you mean?" };
    const c = await call<Connections>("get_connections", { type, id });
    return { reply: describeConnections(c), entities: [strip(c.center as any), ...c.related.map((r) => strip(r as any))], situationId: type === "situation" ? id : undefined };
  }

  // What has to happen before a visit / delivery / arrival.
  if (RX.before.test(norm)) {
    const s = await situationFromMessage(norm, ctx, call);
    if (s && "clarify" in s) return { reply: `${s.clarify}\n${quoteList(s.entities.map((e) => e.title))}`, entities: s.entities, clarification: s.clarify };
    if (!s) return { reply: "I do not have an open appointment, delivery or visit on file. Tell me what is happening and when, and I will set it up.", clarification: "What is happening, and when?" };
    const d = await call<SituationDetail>("get_situation", { situation_id: s.id });
    const at = d.situation.expected_at;
    const open = d.tasks.filter((t) => OPEN.has(t.status));
    const before = open.filter((t) => !at || !t.due_at || t.due_at <= at);
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    const lines = before.map((t) => {
      const dep = t.depends_on_task_id ? byId.get(t.depends_on_task_id) : undefined;
      return `${t.title}${t.due_at ? ` (due ${fmt(t.due_at)})` : " (no due time)"}${dep && OPEN.has(dep.status) ? `, after "${dep.title}"` : ""}`;
    });
    const when = at ? ` at ${formatLocal(at, ctx.tz)}` : "";
    const pending = d.proposals.find((p) => p.status === "proposed");
    if (!lines.length) return { reply: `"${d.situation.title}"${when} has no open tasks before then.${pending ? " A proposed plan is waiting for your approval." : " Ask me to plan it if you want a checklist."}`, situationId: s.id, entities: [sitRef(d.situation)] };
    return { reply: `Before "${d.situation.title}"${when}:\n${quoteList(lines)}${pending ? "\nA proposed plan with more steps is waiting for your approval." : ""}`, entities: [sitRef(d.situation), ...before.map((t) => ref({ ...t, situation_title: d.situation.title }, ctx.tz))], situationId: s.id };
  }

  // Blocked / waiting tasks, with the stored reason.
  if (RX.blocked.test(norm) && /\b(task|tasks|what|which|anything|why|blocked|stuck)\b/.test(norm)) {
    const t = (await call<{ tasks: TaskWithContext[] }>("list_tasks", { filter: "blocked", limit: 50 })).tasks;
    if (!t.length) return { reply: "No open task is blocked or waiting on another task." };
    return { reply: `${t.length} task${t.length === 1 ? " is" : "s are"} held up:\n${quoteList(t.map((x) => `${x.title}: ${x.waiting_on ? `waiting for "${x.waiting_on}"` : "marked blocked"}${x.situation_title ? ` (${x.situation_title})` : ""}`))}`, entities: t.slice(0, 8).map((x) => ref(x, ctx.tz)) };
  }

  // Overdue tasks only.
  if (RX.overdue.test(norm) && !RX.today.test(norm)) {
    const t = (await call<{ tasks: TaskWithContext[] }>("list_tasks", { filter: "overdue", limit: 50 })).tasks;
    if (!t.length) return { reply: "Nothing is overdue." };
    return { reply: `${t.length} task${t.length === 1 ? " is" : "s are"} past due (overdue means past its due time, not failed):\n${quoteList(t.map((x) => `${x.title}, was due ${formatLocal(x.due_at, ctx.tz)}${x.situation_title ? ` (${x.situation_title})` : ""}`))}`, entities: t.slice(0, 8).map((x) => ref(x, ctx.tz)) };
  }

  // Recent activity, for the open situation or task, else the household.
  if (RX.activity.test(norm)) {
    const ev = (await call<{ events: ActivityEvent[] }>("get_activity_log", { ...(ctx.taskId ? { task_id: ctx.taskId } : ctx.situationId ? { situation_id: ctx.situationId } : {}), limit: 10 })).events;
    if (!ev.length) return { reply: "Nothing has been recorded yet." };
    const scope = ctx.taskId ? "this task" : ctx.situationId ? "this situation" : "your household";
    return { reply: `Most recent changes recorded for ${scope}:\n${quoteList(ev.slice(-8).reverse().map((e) => `${fmt(e.created_at)} ${e.description}`))}` };
  }
  return null;
}

/** When nothing else applies: look for stored records that match the message instead of listing example prompts. */
export async function retrievalFallback(raw: string, call: Call, hasOpenWork: boolean): Promise<IntentResult> {
  const words = contentWords(normalize(raw)).slice(0, 4);
  const found = new Map<string, SearchResult>();
  if (words.length) {
    for (const r of (await call<{ results: SearchResult[] }>("search_household", { query: words.join(" "), limit: 5 })).results) found.set(r.key, r);
    if (!found.size && words.length > 1) for (const w of words.filter((x) => x.length > 3).slice(0, 3)) for (const r of (await call<{ results: SearchResult[] }>("search_household", { query: w, limit: 3 })).results) found.set(r.key, r);
  }
  if (found.size) {
    const list = [...found.values()].slice(0, 6);
    return { reply: `I am not sure what you want me to do, but these stored records match "${words.join(" ")}":\n${quoteList(list.map((r) => `${r.title} (${r.subtitle})`))}\nOpen one, or tell me what to do with it.`, entities: list.map(strip), clarification: "What would you like to do with it?" };
  }
  const nudge = hasOpenWork ? "You can ask what needs attention, or tell me what changed." : "If something is happening at home, tell me what and when, and I will set it up.";
  return { reply: `I could not match that to something I can do, and nothing in your situations, tasks or documents mentions ${words.length ? `"${words.join(" ")}"` : "it"}. ${nudge}`, clarification: null };
}
