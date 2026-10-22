import { describe, expect, it } from "vitest";
import type { ChatMsg, Route } from "../apps/web/src/types";
import { HOME, activeDocumentFor, activeSituationFor, activeTaskFor, operationSteps, parseRoute, routeHash, appendMessages, createdSituation, greetingFor, loadThreads, makeSequencer, pickFeatured, pruneThreads, rehome, saveThreads, suggestionsFor, syncProposal, threadKeyFor } from "../apps/web/src/logic";

const msg = (id: string, text = id): ChatMsg => ({ id, role: "agent", text, at: "2026-10-22T09:00:00Z" });
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe("conversation threads are bound to one situation", () => {
  it("derives the thread and the agent's active situation from the route, never from memory", () => {
    const home: Route = { view: "dashboard" }; const sit: Route = { view: "situation", id: "s-2" };
    expect(threadKeyFor(home)).toBe(HOME); expect(activeSituationFor(home)).toBeNull();
    expect(threadKeyFor(sit)).toBe("s-2"); expect(activeSituationFor(sit)).toBe("s-2");
    expect(threadKeyFor({ view: "activity" })).toBe(HOME);
  });

  it("a resolved situation's conversation is invisible from a new situation (the reported bug)", () => {
    let t = appendMessages({}, "old", msg("user: I collected the package"), msg("agent: marked the situation resolved"));
    t = appendMessages(t, "new", msg("agent: simulated delivery saved"));
    expect((t["new"] ?? []).map((m) => m.id)).toEqual(["agent: simulated delivery saved"]);
    expect((t["old"] ?? []).some((m) => /resolved/.test(m.id))).toBe(true);
    expect((t[threadKeyFor({ view: "situation", id: "new" })] ?? []).every((m) => !/resolved/.test(m.text))).toBe(true);
  });

  it("re-homes only the new exchange when a chat from home creates a situation", () => {
    let t = appendMessages({}, HOME, msg("older"), msg("u1"), msg("a1"));
    t = rehome(t, HOME, "created", ["u1", "a1"]);
    expect(t[HOME].map((m) => m.id)).toEqual(["older"]);
    expect(t["created"].map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(rehome(t, "created", "created", ["u1"])).toBe(t);
  });

  it("only a genuinely new situation re-homes; an existing demo delivery does not", () => {
    const base = { situationId: "s1" } as any;
    expect(createdSituation({ ...base, trace: [{ ok: true, tool: "create_situation", result_summary: "situation saved" }] as any })).toBe("s1");
    expect(createdSituation({ ...base, trace: [{ ok: true, tool: "simulate_delivery_event", result_summary: "simulated delivery saved" }] as any })).toBe("s1");
    expect(createdSituation({ ...base, trace: [{ ok: true, tool: "simulate_delivery_event", result_summary: "existing demo delivery returned" }] as any })).toBeNull();
    expect(createdSituation({ ...base, trace: [{ ok: false, tool: "create_situation", result_summary: "error" }] as any })).toBeNull();
  });

  it("prunes threads of situations that no longer exist but keeps home", () => {
    const t = { [HOME]: [msg("h")], gone: [msg("g")], kept: [msg("k")] };
    expect(Object.keys(pruneThreads(t, ["kept"])).sort()).toEqual([HOME, "kept"]);
  });

  it("updates a stored proposal snapshot wherever it appears", () => {
    const p = { id: "p1", status: "approved" } as any;
    const t = { a: [{ ...msg("m"), proposal: { id: "p1", status: "proposed" } as any }], b: [msg("x")] };
    expect(syncProposal(t, p).a[0].proposal!.status).toBe("approved");
  });

  it("persists per thread, caps length, drops the legacy global conversation, and survives broken storage", () => {
    const s = mem();
    s.m.set("homerelay.chat.v1", JSON.stringify([msg("leaky")]));
    saveThreads({ a: Array.from({ length: 60 }, (_, i) => msg(`m${i}`)), empty: [] }, s);
    const back = loadThreads(s);
    expect(back.a).toHaveLength(40); expect(back.a.at(-1)!.id).toBe("m59"); expect(back.empty).toBeUndefined();
    expect(s.m.has("homerelay.chat.v1")).toBe(false);
    s.m.set("homerelay.threads.v2", "{not json");
    expect(loadThreads(s)).toEqual({});
    expect(loadThreads(null)).toEqual({});
    expect(() => saveThreads({ a: [msg("x")] }, { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined })).not.toThrow();
  });
});

describe("stale responses", () => {
  it("only the latest request per key may apply its result", () => {
    const q = makeSequencer();
    const first = q.next("detail:a"); const second = q.next("detail:a"); const other = q.next("detail:b");
    expect(q.isLatest("detail:a", first)).toBe(false);
    expect(q.isLatest("detail:a", second)).toBe(true);
    expect(q.isLatest("detail:b", other)).toBe(true);
  });
});

describe("featured situation and suggestions come from real state", () => {
  const sit = (o: any) => ({ id: "x", status: "open", priority: "normal", expected_at: null, next_due_at: null, pending_proposal_id: null, can_resolve: false, ...o });
  const dash = (situations: any[], overdue: any[] = []) => ({ situations, summary: { overdue } }) as any;

  it("prefers a pending proposal, then overdue work, then ready-to-resolve; ignores resolved", () => {
    expect(pickFeatured(null)).toBeNull();
    expect(pickFeatured(dash([sit({ id: "r", status: "resolved" })]))).toBeNull();
    const a = sit({ id: "a", can_resolve: true }); const b = sit({ id: "b", pending_proposal_id: "p" }); const c = sit({ id: "c" });
    expect(pickFeatured(dash([a, c, b]))!.id).toBe("b");
    expect(pickFeatured(dash([a, c], [{ situation_id: "c" }]))!.id).toBe("c");
    expect(pickFeatured(dash([c, a]))!.id).toBe("a");
  });
  it("breaks ties by the nearest time", () => {
    const early = sit({ id: "early", expected_at: "2026-10-22T10:00:00Z" }); const late = sit({ id: "late", expected_at: "2026-10-23T10:00:00Z" });
    expect(pickFeatured(dash([late, early]))!.id).toBe("early");
  });
  it("suggests only prompts the state can support", () => {
    expect(suggestionsFor(null)).toEqual(["What is on my plate today?", "Which tasks are blocked?", "Find my receipts"]);
    expect(suggestionsFor(null, { taskOpen: true })[0]).toBe("Show me everything connected to this");
    const d = (o: any) => ({ situation: { category: "delivery", status: "open", constraints: {}, ...o.s }, tasks: o.tasks ?? [], proposals: o.proposals ?? [], workflow: { can_resolve: false } }) as any;
    expect(suggestionsFor(d({}))[0]).toMatch(/working until 6 PM/);
    expect(suggestionsFor(d({ s: { constraints: { available_from: "x" } }, tasks: [{ status: "pending" }] }))).toContain("I collected the package");
    expect(suggestionsFor(d({ proposals: [{ status: "proposed" }] }))).toEqual(["What is still pending?"]);
    expect(suggestionsFor(d({ s: { status: "resolved" } }))).toEqual(["What is still pending?"]);
  });
  it("greets by local hour", () => {
    expect(greetingFor(new Date(2026, 9, 21, 9))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 9, 21, 15))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 9, 21, 20))).toBe("Good evening");
  });
});

describe("v3 routes, threads and operation steps", () => {
  it("round-trips every workspace route and falls back safely", () => {
    const routes: Route[] = [{ view: "dashboard" }, { view: "situations" }, { view: "situation", id: "s 1" }, { view: "documents" }, { view: "document", id: "d1" }, { view: "tasks" }, { view: "task", id: "t1" }, { view: "map" }, { view: "activity" }, { view: "assistant" }, { view: "assistant", id: "s1" }];
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
    expect(parseRoute("#/nope")).toEqual({ view: "dashboard" });
    expect(parseRoute("#/situation/")).toEqual({ view: "situations" });
    expect(parseRoute("#/document")).toEqual({ view: "documents" });
    expect(parseRoute("#/task/")).toEqual({ view: "tasks" });
    expect(parseRoute("#/situation/%E0%A4%A")).toEqual({ view: "situations" });
  });
  it("keeps document and assistant threads separate from Home", () => {
    expect(threadKeyFor({ view: "document", id: "d1" })).toBe("doc:d1");
    expect(threadKeyFor({ view: "assistant", id: "s1" })).toBe(threadKeyFor({ view: "situation", id: "s1" }));
    expect(threadKeyFor({ view: "assistant" })).toBe(HOME);
    expect(threadKeyFor({ view: "tasks" })).toBe(HOME);
    expect(threadKeyFor({ view: "task", id: "t1" })).toBe("task:t1");
    expect(threadKeyFor({ view: "map" })).toBe(HOME);
    expect(activeTaskFor({ view: "task", id: "t1" })).toBe("t1");
    expect(activeTaskFor({ view: "situation", id: "s1" })).toBeNull();
    expect(activeDocumentFor({ view: "document", id: "d1" })).toBe("d1");
    expect(activeDocumentFor({ view: "situation", id: "s1" })).toBeNull();
    expect(activeSituationFor({ view: "document", id: "d1" })).toBeNull();
    expect(activeSituationFor({ view: "assistant", id: "s1" })).toBe("s1");
  });
  it("turns the real trace into readable steps without inventing any", () => {
    expect(operationSteps(undefined)).toEqual([]);
    const steps = operationSteps([{ id: "1", tool: "search_documents", ok: true, result_summary: "2 hits" }, { id: "2", tool: "mystery_tool", ok: false, result_summary: "err" }] as any);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ id: "2", label: "mystery_tool", ok: false, detail: "err" });
  });
});
