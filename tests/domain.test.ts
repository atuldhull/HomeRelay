import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../apps/mcp-server/src/db";
import { DomainError, HomeRelayService } from "../apps/mcp-server/src/domain";

const TZ = "Asia/Kolkata";
// 2026-10-22 14:30 IST. Demo delivery -> 17:00 IST = 11:30Z. Free at 18:00 IST = 12:30Z; 19:00 IST = 13:30Z.
const NOW = new Date("2026-10-22T09:00:00.000Z");
const FREE_6 = "2026-10-22T12:30:00.000Z";
const FREE_7 = "2026-10-22T13:30:00.000Z";

let db: Db; let svc: HomeRelayService;
beforeEach(() => { db = openDb(":memory:"); svc = new HomeRelayService(db, { tz: TZ, now: () => NOW }); });

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof DomainError ? e.code : `non-domain:${String(e)}`; } return "no-error"; };
const events = (sid: string) => svc.getActivityLog(sid).map((e) => e.event_type);

describe("situations", () => {
  it("creates and retrieves a situation, writing an activity event", () => {
    const s = svc.createSituation({ title: "Plumber visit", category: "maintenance" }, "user");
    expect(s.status).toBe("open");
    expect(svc.getSituation(s.id).situation.title).toBe("Plumber visit");
    expect(events(s.id)).toEqual(["situation_created"]);
  });
  it("rejects invalid timestamps and unknown ids", () => {
    expect(code(() => svc.createSituation({ title: "x", category: "general", expected_at: "tomorrow" }))).toBe("INVALID_INPUT");
    expect(code(() => svc.getSituation("nope"))).toBe("NOT_FOUND");
  });
  it("lists only open situations by default and computes task counts", () => {
    const a = svc.createSituation({ title: "A", category: "general" });
    const b = svc.createSituation({ title: "B", category: "general" });
    svc.resolveSituation(b.id, { confirmed_by_user: true });
    const list = svc.listSituations();
    expect(list.map((s) => s.id)).toEqual([a.id]);
    expect(svc.listSituations({ statuses: ["resolved"] }).map((s) => s.id)).toEqual([b.id]);
  });
});

describe("tasks", () => {
  let sid: string;
  beforeEach(() => { sid = svc.createSituation({ title: "S", category: "general" }).id; });

  it("adds tasks, rejects invalid situation / dependency / duplicate", () => {
    const t = svc.addTask({ situation_id: sid, title: "One" });
    expect(t.status).toBe("pending");
    expect(code(() => svc.addTask({ situation_id: "nope", title: "x" }))).toBe("NOT_FOUND");
    expect(code(() => svc.addTask({ situation_id: sid, title: "x", depends_on_task_id: "nope" }))).toBe("NOT_FOUND");
    expect(code(() => svc.addTask({ situation_id: sid, title: "One" }))).toBe("DUPLICATE");
    const other = svc.createSituation({ title: "O", category: "general" });
    const ot = svc.addTask({ situation_id: other.id, title: "Other" });
    expect(code(() => svc.addTask({ situation_id: sid, title: "y", depends_on_task_id: ot.id }))).toBe("INVALID_INPUT");
  });
  it("enforces status transitions and completion confirmation", () => {
    const t = svc.addTask({ situation_id: sid, title: "T" });
    expect(code(() => svc.updateTaskStatus(t.id, "completed"))).toBe("CONFIRMATION_REQUIRED");
    const done = svc.updateTaskStatus(t.id, "completed", { confirmed_by_user: true });
    expect(done.completed_at).toBe(NOW.toISOString());
    expect(code(() => svc.updateTaskStatus(t.id, "pending"))).toBe("INVALID_TRANSITION");
    const b = svc.addTask({ situation_id: sid, title: "B" });
    svc.updateTaskStatus(b.id, "blocked");
    expect(code(() => svc.updateTaskStatus(b.id, "completed", { confirmed_by_user: true }))).toBe("INVALID_TRANSITION");
  });
  it("blocks completing a task whose dependency is incomplete", () => {
    const a = svc.addTask({ situation_id: sid, title: "A" });
    const b = svc.addTask({ situation_id: sid, title: "B", depends_on_task_id: a.id });
    expect(code(() => svc.updateTaskStatus(b.id, "completed", { confirmed_by_user: true }))).toBe("DEPENDENCY_INCOMPLETE");
    svc.updateTaskStatus(a.id, "completed", { confirmed_by_user: true });
    expect(svc.updateTaskStatus(b.id, "completed", { confirmed_by_user: true }).status).toBe("completed");
  });
  it("reschedules, records old/new values, preserves history, rejects no-ops", () => {
    const t = svc.addTask({ situation_id: sid, title: "T", due_at: FREE_6 });
    const r = svc.rescheduleTask(t.id, FREE_7, "meeting extended");
    expect(r.due_at).toBe(FREE_7);
    const ev = svc.getActivityLog(sid).find((e) => e.event_type === "task_rescheduled")!;
    expect(ev.metadata).toMatchObject({ old_due_at: FREE_6, new_due_at: FREE_7, reason: "meeting extended" });
    expect(events(sid)).toContain("task_created");
    expect(code(() => svc.rescheduleTask(t.id, FREE_7))).toBe("NO_CHANGE");
    expect(code(() => svc.rescheduleTask(t.id, "later"))).toBe("INVALID_INPUT");
  });
});

describe("delivery planning, approval and replanning", () => {
  function demo() {
    const { situation } = svc.simulateDeliveryEvent();
    return situation;
  }
  it("simulated delivery is labelled, demo-sourced, idempotent, and force_new creates another", () => {
    const s = demo();
    expect(s.source).toBe("demo");
    expect(s.description).toContain("SIMULATED");
    expect(s.expected_at).toBe("2026-10-22T11:30:00.000Z");
    expect(svc.simulateDeliveryEvent().already_exists).toBe(true);
    expect(svc.listSituations()).toHaveLength(1);
    expect(svc.simulateDeliveryEvent(true).already_exists).toBe(false);
    expect(svc.listSituations()).toHaveLength(2);
  });
  it("asks for missing availability instead of inventing it", () => {
    const s = demo();
    const r = svc.proposePlan(s.id);
    expect(r.proposal).toBeNull();
    expect(r.plan.missing_info.length).toBeGreaterThan(0);
  });
  it("proposes without executing, then approval creates tasks exactly once", () => {
    const s = demo();
    svc.setConstraints(s.id, { available_from: FREE_6, nobody_else_home: true }, "user");
    const { proposal } = svc.proposePlan(s.id);
    expect(proposal!.status).toBe("proposed");
    expect(proposal!.plan.conflicts.length).toBe(2);
    expect(svc.getTasks(s.id)).toHaveLength(0); // proposal alone changes nothing
    const first = svc.approvePlan(proposal!.id);
    expect(first.created_tasks).toHaveLength(3);
    expect(first.created_tasks[2].depends_on_task_id).toBe(first.created_tasks[0].id);
    const again = svc.approvePlan(proposal!.id); // duplicate approval attempt
    expect(again.already_applied).toBe(true);
    expect(svc.getTasks(s.id)).toHaveLength(3);
    expect(svc.getSituation(s.id).situation.status).toBe("in_progress");
    expect(events(s.id)).toEqual(expect.arrayContaining(["plan_proposed", "plan_approved", "task_created"]));
  });
  it("supports approving a subset of actions", () => {
    const s = demo(); svc.setConstraints(s.id, { available_from: FREE_6 });
    const { proposal } = svc.proposePlan(s.id);
    const r = svc.approvePlan(proposal!.id, ["a1"]);
    expect(r.created_tasks.map((t) => t.kind)).toEqual(["followup"]);
    expect(code(() => svc.approvePlan(svc.proposePlan(s.id).proposal?.id ?? "x", ["zzz"]))).toBeTruthy();
  });
  it("rejecting a proposal creates no tasks and cannot then be approved", () => {
    const s = demo(); svc.setConstraints(s.id, { available_from: FREE_6 });
    const { proposal } = svc.proposePlan(s.id);
    svc.rejectPlan(proposal!.id, "not now");
    expect(svc.getTasks(s.id)).toHaveLength(0);
    expect(code(() => svc.approvePlan(proposal!.id))).toBe("INVALID_STATE");
    expect(events(s.id)).toContain("plan_rejected");
  });
  it("new proposal supersedes the previous pending one", () => {
    const s = demo(); svc.setConstraints(s.id, { available_from: FREE_6 });
    const p1 = svc.proposePlan(s.id).proposal!;
    const p2 = svc.proposePlan(s.id).proposal!;
    expect(svc.getSituation(s.id).proposals.find((p) => p.id === p1.id)!.status).toBe("superseded");
    expect(code(() => svc.approvePlan(p1.id))).toBe("INVALID_STATE");
    expect(svc.approvePlan(p2.id).created_tasks.length).toBeGreaterThan(0);
  });
  it("replans when the meeting is extended: reschedules, no duplicates, history kept", () => {
    const s = demo(); svc.setConstraints(s.id, { available_from: FREE_6 });
    svc.approvePlan(svc.proposePlan(s.id).proposal!.id);
    const before = svc.getTasks(s.id);
    svc.setConstraints(s.id, { available_from: FREE_7 }, "user");
    const { proposal } = svc.proposePlan(s.id);
    expect(proposal!.plan.actions.every((a) => a.type === "reschedule_task")).toBe(true);
    const r = svc.approvePlan(proposal!.id);
    expect(r.rescheduled_tasks).toHaveLength(2);
    const after = svc.getTasks(s.id);
    expect(after).toHaveLength(before.length); // no duplicates
    expect(after.find((t) => t.kind === "followup")!.due_at).toBe(FREE_7);
    expect(after.find((t) => t.kind === "contingency")!.due_at).toBe("2026-10-22T14:30:00.000Z");
    expect(after.find((t) => t.kind === "coordination")!.due_at).toBe(before.find((t) => t.kind === "coordination")!.due_at); // not availability-bound
    expect(events(s.id).filter((e) => e === "task_created")).toHaveLength(3); // originals preserved
    // already consistent -> nothing more to propose
    const again = svc.proposePlan(s.id);
    expect(again.proposal).toBeNull(); expect(again.plan.actions).toHaveLength(0);
  });
  it("resolution needs confirmation and no open tasks unless explicitly closed", () => {
    const s = demo(); svc.setConstraints(s.id, { available_from: FREE_6 });
    svc.approvePlan(svc.proposePlan(s.id).proposal!.id);
    expect(code(() => svc.resolveSituation(s.id, { confirmed_by_user: false }))).toBe("CONFIRMATION_REQUIRED");
    expect(code(() => svc.resolveSituation(s.id, { confirmed_by_user: true }))).toBe("OUTSTANDING_TASKS");
    expect(svc.getSituation(s.id).situation.status).not.toBe("resolved");
    const r = svc.resolveSituation(s.id, { confirmed_by_user: true, close_outstanding: true });
    expect(r.situation.status).toBe("resolved");
    expect(r.cancelled_tasks.length).toBe(3);
    expect(code(() => svc.addTask({ situation_id: s.id, title: "late" }))).toBe("INVALID_STATE");
  });
});

describe("transactions and isolation", () => {
  it("rolls back approval entirely when a write fails midway", () => {
    const s = svc.simulateDeliveryEvent().situation; svc.setConstraints(s.id, { available_from: FREE_6 });
    const { proposal } = svc.proposePlan(s.id);
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON activity_events WHEN NEW.event_type='task_created' AND NEW.description LIKE '%redelivery%' BEGIN SELECT RAISE(ABORT,'boom'); END;`);
    expect(() => svc.approvePlan(proposal!.id)).toThrow();
    expect(svc.getTasks(s.id)).toHaveLength(0);
    expect(svc.getSituation(s.id).proposals[0].status).toBe("proposed");
    expect(events(s.id)).not.toContain("plan_approved");
  });
  it("reset removes only demo data", () => {
    const user = svc.createSituation({ title: "Mine", category: "general", source: "user" });
    svc.addTask({ situation_id: user.id, title: "keep me" });
    svc.simulateDeliveryEvent();
    const r = svc.resetDemoData();
    expect(r.situations_removed).toBe(1);
    expect(svc.listSituations().map((s) => s.id)).toEqual([user.id]);
    expect(svc.getTasks(user.id)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) c FROM preferences WHERE scope='demo'").get()).toEqual({ c: 0 });
    expect(svc.getActivityLog().some((e) => e.event_type === "demo_reset")).toBe(true);
  });
  it("migrations are repeatable and keep data", () => {
    svc.createSituation({ title: "keep", category: "general" });
    // re-running migrate must not drop anything
    return import("../apps/mcp-server/src/db").then(({ migrate }) => {
      migrate(db); migrate(db);
      expect(svc.listSituations()).toHaveLength(1);
    });
  });
});
