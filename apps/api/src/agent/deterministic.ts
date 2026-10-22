import type { ChatRequest, ChatResponse, DocumentHit, EntityRef, Proposal, SituationDetail, SituationSummary, Task, TaskWithContext, TraceEntry, WorkloadSummary } from "@homerelay/shared";
import { formatClock, localDatePlus, localYmd, nextLocalTimeIso, parseClockTime, parseTimeRange, zonedToUtcIso } from "@homerelay/shared";
import { McpToolError, type McpGateway } from "../gateway";
import { documentIntent } from "./document-intents";
import { RX, householdIntent, normalize, retrievalFallback } from "./intents";

export interface AgentDeps {
  gw: McpGateway;
  tz: string;
  now: () => Date;
}

const MUTATING = new Set(["link_document_to_situation", "update_task", "reopen_task", "link_document_to_task", "unlink_document_from_task", "unlink_document_from_situation", "update_document_metadata", "create_situation", "update_situation", "simulate_delivery_event", "set_constraints", "propose_plan", "approve_plan", "reject_plan", "add_task", "reschedule_task", "update_task_status", "resolve_situation"]);
const OPEN_TASK = new Set(["pending", "in_progress", "blocked"]);
const DAYPART: Record<string, [number, number]> = { morning: [9, 0], afternoon: [14, 0], evening: [18, 0], night: [20, 0] };

const RE = {
  simulate: /\bsimulat\w*\b.*\b(delivery|package|parcel)\b|\b(delivery|package|parcel)\b.*\bsimulat/i,
  collected: /\b(collected|picked\s*up|received)\b.*\b(package|parcel|delivery|it)\b|\bgot\b.*\b(package|parcel)\b|\b(package|parcel)\b.*\b(collected|picked up|in my hands)\b/i,
  workDone: /\b(repair|work|fix(ed)?|visit|technician|plumber|electrician|engineer)\b.*\b(done|complete[d]?|finished|fixed)\b|\b(fixed|finished)\b/i,
  approve: /^\s*(yes|yep|yeah|approve(d)?|go ahead|do it|looks good|confirm)\b/i,
  reject: /^\s*(no|nope|reject(ed)?|cancel|discard|don'?t)\b/i,
  attention: /\b(overdue|due today|needs?\s+(my\s+)?attention|what.*\btoday\b)/i,
  pending: /\b(what('?s| is)?\s+(still\s+)?(pending|open|left)|what do i need|what.*remain|unresolved|any(thing)?\s+pending)\b/i,
  plan: /\b(plan|help|manage|what should|what do i do|next step|handle|prepare)\b/i,
  nobody: /\b(nobody|no one|noone)\b.*\b(home|there|here)\b/i,
  delivery: /\b(package|parcel|delivery|courier)\b/i,
  maintenance: /\b(technician|plumber|electrician|repair(man)?|maintenance|engineer|handyman)\b/i,
  family: /\b(parents?|family|guests?|relatives?|in-?laws?|grand(parents|ma|pa))\b/i,
  arriving: /\b(arrive[sd]?|arriving|coming|visit(ing|s)?|staying|comes)\b/i,
  change: /\b(moved|rescheduled|pushed|delayed|postponed|changed)\b|\bnow\s+(coming|arriving|arrives|visiting)\b/i,
  availKw: /\b(until|till|free (?:at|from|after)|available (?:at|from|after)|back (?:at|by)|home (?:at|by|after)|extended|after)\b/i,
};

function afterKeyword(text: string, kw: RegExp): { h: number; mi: number } | null {
  const m = kw.exec(text);
  return m ? parseClockTime(text.slice(m.index)) : null;
}

/** "tomorrow" -> 1, "today"/"tonight" -> 0, otherwise null (next occurrence of the clock time). */
function dayOffset(msg: string): number | null {
  if (/\btomorrow\b/i.test(msg)) return 1;
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/i.test(msg)) return 0;
  return null;
}

export async function deterministicChat(deps: AgentDeps, req: ChatRequest): Promise<ChatResponse> {
  const trace: TraceEntry[] = [];
  const msg = req.message.trim();
  const call = <T = any>(tool: string, args: Record<string, unknown> = {}) => deps.gw.call<T>(tool, args, { via: "deterministic", trace });
  const fmt = (iso: string | null | undefined) => formatClock(iso, deps.tz);
  let situationId: string | null = req.activeSituationId ?? null;
  let proposal: Proposal | null = null;
  let clarification: string | null = null;
  let documents: DocumentHit[] | undefined;
  let entities: EntityRef[] | undefined;
  const norm = normalize(msg);
  const taskRef = (t: TaskWithContext): EntityRef => ({ key: `task:${t.id}`, type: "task", id: t.id, title: t.title, status: t.status, route: `#/task/${t.id}`, subtitle: `Task${t.due_at ? ` · due ${fmt(t.due_at)}` : ""} · ${t.situation_title ?? "household task"}` });

  const savedSomething = () => trace.some((t) => t.ok && MUTATING.has(t.tool) && !(t.tool === "propose_plan" && !/plan saved/.test(t.result_summary)));
  const done = (reply: string): ChatResponse => ({ mode: "deterministic", reply, situationId, proposal, clarification, trace, stateChanged: savedSomething(), ...(documents ? { documents } : {}), ...(entities?.length ? { entities } : {}) });

  const instantFor = (h: number, mi: number, off: number | null, anchorIso?: string | null): string => {
    if (off !== null) { const d = localDatePlus(deps.now(), off, deps.tz); return zonedToUtcIso(d.y, d.mo, d.d, h, mi, deps.tz); }
    if (anchorIso) { const d = localYmd(anchorIso, deps.tz); return zonedToUtcIso(d.y, d.mo, d.d, h, mi, deps.tz); }
    return nextLocalTimeIso(deps.now(), h, mi, deps.tz);
  };

  async function loadTarget(): Promise<SituationDetail | null> {
    if (situationId) {
      try { return await call<SituationDetail>("get_situation", { situation_id: situationId }); }
      catch (e) { if (!(e instanceof McpToolError && e.code === "NOT_FOUND")) throw e; situationId = null; }
    }
    const list = await call<{ situations: SituationSummary[] }>("list_open_situations", { limit: 10 });
    const pick = list.situations[0];
    if (!pick) return null;
    situationId = pick.id;
    return call<SituationDetail>("get_situation", { situation_id: pick.id });
  }
  const pendingProposal = (d: SituationDetail) => d.proposals.find((p) => p.status === "proposed") ?? null;

  /** Proposes a plan for a situation and phrases the outcome from the real result. */
  async function planFor(sid: string, lead: string, hadTasks = false): Promise<ChatResponse> {
    const plan = await call<{ proposal: Proposal | null; plan: { summary: string; conflicts: string[]; missing_info: string[]; actions: unknown[] }; no_changes_needed: boolean }>("propose_plan", { situation_id: sid });
    if (plan.proposal) {
      proposal = plan.proposal;
      const conflict = plan.plan.conflicts[0] ? ` ${plan.plan.conflicts[0]}` : "";
      return done(hadTasks
        ? `${lead} Your open tasks were set around an earlier time, so I drafted a reschedule. It is only a proposal until you approve it.`
        : `${lead}${conflict} I drafted a plan below. It is only a proposal; nothing is created until you approve it.`);
    }
    if (plan.plan.missing_info.length) { clarification = plan.plan.missing_info[0]; return done(`${lead} ${plan.plan.missing_info[0]}`); }
    return done(`${lead} ${plan.plan.summary}`);
  }

  /** User-confirmed completion: completes the named tasks, cancels the ones that became moot, resolves. */
  async function confirmDone(target: SituationDetail, isKey: (t: Task) => boolean, what: string, verifiedWith: string): Promise<ChatResponse> {
    const open = target.tasks.filter((t) => OPEN_TASK.has(t.status));
    const key = open.filter(isKey);
    const actions: string[] = [];
    for (const t of key) {
      await call("update_task_status", { task_id: t.id, status: "completed", confirmed_by_user: true, note: `User said ${what}`, actor: "user" });
      actions.push(`completed "${t.title}"`);
    }
    const rest = open.filter((t) => !key.includes(t));
    for (const t of rest) await call("update_task_status", { task_id: t.id, status: "cancelled", note: `No longer needed: ${what}`, actor: "user" });
    if (rest.length) actions.push(`cancelled ${rest.length} task(s) that are no longer needed`);
    await call("resolve_situation", { situation_id: target.situation.id, confirmed_by_user: true, note: `User confirmed ${what}`, actor: "user" });
    actions.push("marked the situation resolved");
    return done(`Recorded, based on your confirmation that ${what}: I ${actions.join(", ")}. I have not verified this with ${verifiedWith}.`);
  }

  try {
    // 1. Start the simulated delivery
    if (RE.simulate.test(msg)) {
      const r = await call<{ situation: { id: string }; already_exists: boolean }>("simulate_delivery_event");
      situationId = r.situation.id;
      return done(r.already_exists
        ? "A simulated delivery is already active, so I opened it instead of creating a duplicate. Tell me when you are free and I will plan around it."
        : "I created a simulated delivery (clearly labelled as such) and saved it. Tell me what your day looks like, for example: \"I'm working until 6 PM and nobody else is home.\"");
    }

    // 1a. Household intents: tasks, connections, blocked/overdue, "before the visit", history, electrical safety
    const hh = await householdIntent(msg, { situationId, documentId: req.activeDocumentId ?? null, taskId: req.activeTaskId ?? null, tz: deps.tz, now: deps.now }, call);
    if (hh) { entities = hh.entities; clarification = hh.clarification ?? null; if (hh.situationId) situationId = hh.situationId; return done(hh.reply); }

    // 1b. Documents: search, attached files, attach, read stored text (on the normalised text, so "reciept" still finds receipts)
    const doc = await documentIntent(norm, { situationId, documentId: req.activeDocumentId ?? null }, call);
    if (doc) { documents = doc.documents; clarification = doc.clarification ?? null; return done(doc.reply); }

    // 2. Workload overview ("what needs attention", "what is on my plate today", "priorities")
    if (RE.attention.test(msg) || RX.today.test(norm)) {
      const w = await call<WorkloadSummary>("get_workload_summary");
      const where = (t: { situation_title: string | null }) => t.situation_title ?? "household task";
      const lines: string[] = [];
      for (const t of w.overdue) lines.push(`• Overdue: ${t.title} (${where(t)}), was due ${fmt(t.due_at)}`);
      for (const t of w.due_today) lines.push(`• Due today: ${t.title} (${where(t)}) at ${fmt(t.due_at)}`);
      for (const t of w.blocked.filter((b) => !w.overdue.includes(b) && !w.due_today.includes(b))) lines.push(`• Blocked: ${t.title} (${t.waiting_on ? `waiting for "${t.waiting_on}"` : "marked blocked"})`);
      for (const a of w.waiting_approval) lines.push(`• Plan waiting for your approval: ${a.situation_title}`);
      for (const r of w.can_resolve) lines.push(`• Ready to resolve: ${r.situation_title}`);
      entities = [...w.overdue, ...w.due_today].slice(0, 8).map(taskRef);
      const later = w.upcoming.length ? `\nLater this week: ${w.upcoming.length} task${w.upcoming.length === 1 ? "" : "s"}.` : "";
      return done(lines.length ? `Here is what needs attention:\n${lines.join("\n")}${later}` : `Nothing is overdue, due today or waiting for you.${later}`);
    }

    // 3. Pending overview
    if (RE.pending.test(msg) || /\bwhat is (still )?(open|outstanding|left to do)\b/.test(norm)) {
      const list = await call<{ situations: SituationSummary[] }>("list_open_situations", { limit: 20 });
      const solo = (await call<{ tasks: TaskWithContext[] }>("list_tasks", { filter: "standalone", limit: 50 })).tasks;
      if (!list.situations.length && !solo.length) return done("Nothing is pending. You have no open situations or household tasks.");
      const lines = list.situations.map((s) => `• ${s.title}: ${s.open_task_count} open task(s). Next: ${s.next_action}`);
      const tail = solo.length ? `\nHousehold tasks (${solo.length}): ${solo.slice(0, 5).map((t) => t.title).join(", ")}${solo.length > 5 ? ", …" : ""}` : "";
      entities = solo.slice(0, 5).map(taskRef);
      return done(list.situations.length ? `You have ${list.situations.length} open situation(s):\n${lines.join("\n")}${tail}` : `No open situations.${tail}`);
    }

    // 4. Create a new maintenance appointment or family visit from the message
    const range = parseTimeRange(msg);
    const isMaint = RE.maintenance.test(msg); const isFamily = RE.family.test(msg) && RE.arriving.test(msg);
    // Only a "moved" message needs the current situation up front; creating a new one must not depend on existing state.
    const existing = RE.change.test(msg) ? await loadTarget() : null;
    const changing = !!existing && RE.change.test(msg) &&
      ((existing.situation.category === "maintenance" && !!range) || (existing.situation.category === "family_visit" && parseClockTime(msg) !== null));

    if (changing && existing) {
      const { situation } = existing; const off = dayOffset(msg);
      if (situation.category === "maintenance" && range) {
        const start = instantFor(range.start.h, range.start.mi, off, situation.expected_at);
        const end = instantFor(range.end.h, range.end.mi, off, start);
        const oldEnd = situation.constraints.window_end ?? null;
        // keep the window valid at every step: widen first when the new start is after the old end
        if (oldEnd && new Date(start) >= new Date(oldEnd)) { await call("set_constraints", { situation_id: situation.id, window_end: end, actor: "user" }); await call("update_situation", { situation_id: situation.id, expected_at: start, actor: "user" }); }
        else { await call("update_situation", { situation_id: situation.id, expected_at: start, actor: "user" }); await call("set_constraints", { situation_id: situation.id, window_end: end, actor: "user" }); }
        return planFor(situation.id, `Saved: the appointment window is now ${fmt(start)}–${fmt(end)}.`, existing.tasks.some((t) => OPEN_TASK.has(t.status)));
      }
      const t = parseClockTime(msg)!;
      const start = instantFor(t.h, t.mi, off, situation.expected_at);
      await call("update_situation", { situation_id: situation.id, expected_at: start, actor: "user" });
      return planFor(situation.id, `Saved: the time is now ${fmt(start)}.`, existing.tasks.some((x) => OPEN_TASK.has(x.status)));
    }

    if (isMaint && !RE.delivery.test(msg) && !changing && !RE.workDone.test(msg)) {
      if (!range) { clarification = "What time window did the technician give (for example 2 PM to 4 PM)?"; return done(`I can plan around a technician visit. ${clarification}`); }
      const off = dayOffset(msg);
      const start = instantFor(range.start.h, range.start.mi, off);
      const end = instantFor(range.end.h, range.end.mi, off, start);
      const noun = /(plumber|electrician|technician|engineer|handyman|repair)/i.exec(msg)?.[1] ?? "technician";
      const c = await call<{ situation: { id: string } }>("create_situation", {
        title: `${noun[0].toUpperCase()}${noun.slice(1).toLowerCase()} visit`, description: `Created from your message: "${msg.slice(0, 160)}"`,
        category: "maintenance", expected_at: start, window_end: end, source: "user", actor: "user",
      });
      situationId = c.situation.id;
      const home = afterKeyword(msg, /\b(until|till|home (?:at|by|after)|back (?:at|by)|after)\b/i);
      const lead = `I saved the appointment (${fmt(start)}–${fmt(end)}).`;
      if (!home) { clarification = "When will you be home?"; return done(`${lead} ${clarification}`); }
      const availableFrom = instantFor(home.h, home.mi, null, start);
      await call("set_constraints", { situation_id: c.situation.id, available_from: availableFrom, actor: "user" });
      return planFor(c.situation.id, `${lead} You are home from ${fmt(availableFrom)}.`);
    }

    if (isFamily && !isMaint && !RE.delivery.test(msg) && !changing) {
      const clock = parseClockTime(msg);
      const part = /\b(morning|afternoon|evening|night)\b/i.exec(msg)?.[1]?.toLowerCase();
      const when = clock ?? (part ? { h: DAYPART[part][0], mi: DAYPART[part][1] } : null);
      if (!when) { clarification = "What time do they arrive?"; return done(`Happy to help you prepare. ${clarification}`); }
      const start = instantFor(when.h, when.mi, dayOffset(msg));
      const assumed = !clock && part ? ` I took "${part}" as ${fmt(start)}; tell me the exact time to change it.` : "";
      const who = /\bparents?\b/i.test(msg) ? "Visit from your parents" : "Family visit";
      const c = await call<{ situation: { id: string } }>("create_situation", {
        title: who, description: `Created from your message: "${msg.slice(0, 160)}"${assumed ? ` (arrival time assumed from "${part}")` : ""}`,
        category: "family_visit", expected_at: start, source: "user", actor: "user",
      });
      situationId = c.situation.id;
      return planFor(c.situation.id, `I saved the visit (arrival ${fmt(start)}).${assumed}`);
    }

    const target = existing ?? (await loadTarget());

    // 5. User-confirmed completion
    if (target?.situation.category === "delivery" && RE.collected.test(msg)) {
      return confirmDone(target, (t) => t.template_key === "collect" || (!t.template_key && t.kind === "followup"), "you have the package", "the courier");
    }
    if (target?.situation.category === "maintenance" && RE.workDone.test(msg)) {
      return confirmDone(target, (t) => t.template_key === "be_home" || t.template_key === "confirm_done", "the work was completed", "the technician");
    }

    // 6. A typed "yes" / "no" is not a decision: approval and rejection are user actions on the plan card itself.
    if (target && (RE.approve.test(msg) || RE.reject.test(msg))) {
      const p = pendingProposal(target);
      if (p) {
        proposal = p;
        return done(RE.approve.test(msg)
          ? "To apply this plan, press Approve plan on the card below. A typed reply is not treated as approval, so nothing has been created yet."
          : "To discard this plan, press Reject plan on the card below. Nothing has been created.");
      }
    }

    // 7. Availability / delivery description / replanning
    const hasAvail = RE.availKw.test(msg) && parseClockTime(msg) !== null;
    const mentionsMeeting = /\b(meeting|working|work|shift)\b/i.test(msg) && parseClockTime(msg) !== null;
    if (hasAvail || mentionsMeeting) {
      let ctx = target; let created = false;
      if (!ctx && RE.delivery.test(msg)) {
        const arr = afterKeyword(msg, /\b(arrive[sd]?|come[s]?|coming|deliver\w*|expected)\b/i);
        const expected = arr ? nextLocalTimeIso(deps.now(), arr.h, arr.mi, deps.tz) : undefined;
        const c = await call<{ situation: { id: string } }>("create_situation", {
          title: "Package delivery", description: `Created from your message: "${msg.slice(0, 160)}"`, category: "delivery", expected_at: expected, source: "user", actor: "user",
        });
        situationId = c.situation.id; created = true;
        ctx = await call<SituationDetail>("get_situation", { situation_id: c.situation.id });
      }
      if (!ctx) {
        clarification = "Which situation is this about?";
        return done("I do not have an open situation to attach that to. Tell me what is happening (for example, a package arriving) or use \"Simulate delivery event\".");
      }
      const t = afterKeyword(msg, RE.availKw) ?? parseClockTime(msg)!;
      const availableFrom = instantFor(t.h, t.mi, null, ctx.situation.expected_at ?? deps.now().toISOString());
      const hadTasks = ctx.tasks.some((x) => OPEN_TASK.has(x.status));
      await call("set_constraints", { situation_id: ctx.situation.id, available_from: availableFrom, ...(RE.nobody.test(msg) ? { nobody_else_home: true } : {}), actor: "user" });
      return planFor(ctx.situation.id, `${created ? "I created a delivery situation and saved " : "Saved: "}you are free from ${fmt(availableFrom)}.`, hadTasks);
    }

    // 8. "Help me manage it" / plan
    if (RE.plan.test(msg) && target) {
      const existingProposal = pendingProposal(target);
      if (existingProposal) { proposal = existingProposal; return done("There is already a plan waiting for your decision. Approve or reject it below."); }
      const r = await call<{ proposal: Proposal | null; plan: { summary: string; missing_info: string[] } }>("propose_plan", { situation_id: target.situation.id });
      proposal = r.proposal;
      if (r.plan.missing_info.length) {
        clarification = r.plan.missing_info[0];
        return done(`I have "${target.situation.title}" on file${target.situation.expected_at ? ` (expected ${fmt(target.situation.expected_at)})` : ""}, but I need more before I can plan. ${clarification}`);
      }
      return done(r.proposal ? "Here is a plan. It is only a proposal until you approve it." : r.plan.summary);
    }

    // 9. Fallback: look for matching records instead of listing example prompts
    const fb = await retrievalFallback(msg, call, !!target);
    entities = fb.entities; clarification = fb.clarification ?? null;
    return done(fb.reply);
  } catch (e) {
    if (e instanceof McpToolError) {
      const saved = trace.filter((t) => t.ok && MUTATING.has(t.tool) && !(t.tool === "propose_plan" && !/plan saved/.test(t.result_summary)));
      return done(`That did not fully work: ${e.message}. ${saved.length ? `Steps already saved before the failure: ${saved.map((s) => s.tool).join(", ")}.` : "Nothing was changed."}`);
    }
    throw e; // transport failures are reported by the API layer as 503
  }
}
