import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { localDatePlus, nextLocalTimeIso, parseTimeRange, sameLocalDay, zonedToUtcIso } from "@homerelay/shared";
import { migrate, openDb, type Db } from "../apps/mcp-server/src/db";
import { DomainError, HomeRelayService } from "../apps/mcp-server/src/domain";
import { scenarioCatalog } from "../apps/mcp-server/src/scenarios";

const TZ = "Asia/Kolkata";
let now = new Date("2026-10-22T09:00:00.000Z"); // 14:30 IST
let db: Db; let svc: HomeRelayService;
beforeEach(() => { now = new Date("2026-10-22T09:00:00.000Z"); db = openDb(":memory:"); svc = new HomeRelayService(db, { tz: TZ, now: () => now }); });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof DomainError ? e.code : `non-domain:${String(e)}`; } return "no-error"; };
const ist = (day: number, h: number, m = 0) => zonedToUtcIso(2026, 10, day, h, m, TZ);
const approveAll = (sid: string) => svc.approvePlan(svc.proposePlan(sid).proposal!.id);

describe("scenario catalog", () => {
  it("describes every scenario with required info, templates and resolution", () => {
    const cat = scenarioCatalog();
    expect(cat.map((c) => c.category).sort()).toEqual(["delivery", "family_visit", "general", "maintenance"]);
    for (const c of cat) { expect(c.resolution).toBeTruthy(); expect(c.tasks.length).toBeGreaterThan(0); }
    expect(cat.find((c) => c.category === "maintenance")!.tasks.find((t) => t.key === "confirm_done")!.depends_on).toBe("be_home");
  });
});

describe("maintenance appointment", () => {
  const make = (extra: Record<string, unknown> = {}) => svc.createSituation({ title: "Plumber", category: "maintenance", expected_at: ist(23, 14), constraints: { window_end: ist(23, 16), ...extra } }, "user");

  it("asks for each missing piece of information instead of guessing", () => {
    const bare = svc.createSituation({ title: "Plumber", category: "maintenance" });
    expect(svc.proposePlan(bare.id).plan.missing_info[0]).toMatch(/when is the technician coming/i);
    const noWindow = svc.createSituation({ title: "P2", category: "maintenance", expected_at: ist(23, 14) });
    expect(svc.proposePlan(noWindow.id).plan.missing_info[0]).toMatch(/window/i);
    const s = make();
    const r = svc.proposePlan(s.id);
    expect(r.proposal).toBeNull(); expect(r.plan.missing_info).toEqual(["When will you be home?"]);
  });

  it("detects a partial overlap and proposes access instructions, never claiming to contact the technician", () => {
    const s = make({ available_from: ist(23, 15) });
    const { proposal, plan } = svc.proposePlan(s.id);
    expect(plan.conflicts[0]).toMatch(/not home until 3:00 PM/);
    const keys = proposal!.plan.actions.map((a) => (a.type === "add_task" ? a.template_key : "r"));
    expect(keys).toEqual(["be_home", "access_instructions", "confirm_done"]); // no ask_later_slot: you are home for part of the window
    const text = JSON.stringify(plan).toLowerCase();
    expect(text).toContain("has not contacted");
    expect(text).not.toMatch(/\bi (contacted|called|emailed|messaged)\b/);
    expect(plan.scenario).toBe("Maintenance appointment");
    expect(plan.constraints_used.join(" ")).toContain("available from 3:00 PM");
  });

  it("a full miss also proposes asking for a later slot; no conflict means no access task", () => {
    const missed = make({ available_from: ist(23, 17) });
    expect(svc.proposePlan(missed.id).proposal!.plan.actions.map((a) => (a as any).template_key)).toContain("ask_later_slot");
    const fine = svc.createSituation({ title: "Fine", category: "maintenance", expected_at: ist(23, 14), constraints: { window_end: ist(23, 16), available_from: ist(23, 13) } });
    expect(svc.proposePlan(fine.id).proposal!.plan.actions.map((a) => (a as any).template_key)).toEqual(["be_home", "confirm_done"]);
  });

  it("enforces task dependencies in the domain, and replans (reschedules, no duplicates) when the window moves", () => {
    const s = make({ available_from: ist(23, 15) });
    const created = approveAll(s.id).created_tasks;
    const beHome = created.find((t) => t.template_key === "be_home")!; const done = created.find((t) => t.template_key === "confirm_done")!;
    expect(done.depends_on_task_id).toBe(beHome.id);
    expect(code(() => svc.updateTaskStatus(done.id, "completed", { confirmed_by_user: true }))).toBe("DEPENDENCY_INCOMPLETE");

    // technician now comes 4-6 PM: widen the window first, then move the start (server rejects an inverted window)
    expect(code(() => svc.updateSituation(s.id, { expected_at: ist(23, 17) }))).toBe("INVALID_INPUT");
    svc.setConstraints(s.id, { window_end: ist(23, 18) }, "user");
    svc.updateSituation(s.id, { expected_at: ist(23, 16) }, "user");
    const { proposal } = svc.proposePlan(s.id);
    expect(proposal!.plan.actions.every((a) => a.type === "reschedule_task")).toBe(true);
    const r = svc.approvePlan(proposal!.id);
    expect(r.created_tasks).toHaveLength(0);
    expect(svc.getTasks(s.id)).toHaveLength(created.length);
    expect(svc.getTasks(s.id).find((t) => t.template_key === "be_home")!.due_at).toBe(ist(23, 15, 30));
    expect(svc.getTasks(s.id).find((t) => t.template_key === "confirm_done")!.due_at).toBe(ist(23, 18, 30));
    expect(svc.getActivityLog(s.id).map((e) => e.event_type)).toContain("situation_updated");
  });

  it("resolves only after the visit is confirmed", () => {
    const s = make({ available_from: ist(23, 13) });
    approveAll(s.id);
    expect(svc.getSituation(s.id).workflow.can_resolve).toBe(false);
    const [be, done] = [svc.getTasks(s.id).find((t) => t.template_key === "be_home")!, svc.getTasks(s.id).find((t) => t.template_key === "confirm_done")!];
    svc.updateTaskStatus(be.id, "completed", { confirmed_by_user: true });
    svc.updateTaskStatus(done.id, "completed", { confirmed_by_user: true });
    expect(svc.getSituation(s.id).workflow.can_resolve).toBe(true);
    expect(svc.getSituation(s.id).workflow.next_action).toMatch(/confirm to resolve/i);
  });
});

describe("family visit", () => {
  it("needs an arrival time, then lays out preparation relative to it with a dependency", () => {
    const bare = svc.createSituation({ title: "Parents", category: "family_visit" });
    expect(svc.proposePlan(bare.id).plan.missing_info[0]).toMatch(/when do they arrive/i);
    const s = svc.createSituation({ title: "Parents visit", category: "family_visit", expected_at: ist(23, 19) }, "user");
    const created = approveAll(s.id).created_tasks;
    expect(created.map((t) => t.template_key)).toEqual(["groceries", "prepare_room", "tidy_common", "confirm_arrival"]);
    expect(created.find((t) => t.template_key === "groceries")!.due_at).toBe(ist(23, 13));
    expect(created.find((t) => t.template_key === "tidy_common")!.depends_on_task_id).toBe(created.find((t) => t.template_key === "prepare_room")!.id);
  });

  it("moving the arrival time reschedules every task once; a late arrival at home adds a welcome task", () => {
    const s = svc.createSituation({ title: "Parents visit", category: "family_visit", expected_at: ist(23, 19) }, "user");
    approveAll(s.id);
    svc.updateSituation(s.id, { expected_at: ist(23, 21) }, "user");
    const r = approveAll(s.id);
    expect(r.rescheduled_tasks).toHaveLength(4);
    expect(svc.getTasks(s.id)).toHaveLength(4);
    expect(svc.proposePlan(s.id).proposal).toBeNull(); // idempotent
    svc.setConstraints(s.id, { available_from: ist(23, 22) }, "user");
    const add = svc.proposePlan(s.id).proposal!;
    expect(add.plan.actions.map((a) => (a as any).template_key)).toEqual(["arrange_welcome"]);
  });

  it("new tasks that would already be overdue are scheduled for the next minutes and the plan says so", () => {
    now = new Date(ist(23, 18)); // 6 PM; arrival 7 PM, groceries would have been due 1 PM
    const s = svc.createSituation({ title: "Parents visit", category: "family_visit", expected_at: ist(23, 19) }, "user");
    const { proposal } = svc.proposePlan(s.id);
    const groceries = proposal!.plan.actions.find((a) => a.type === "add_task" && a.template_key === "groceries") as any;
    expect(new Date(groceries.due_at).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(groceries.due_at).getTime()).toBeLessThanOrEqual(now.getTime() + 10 * 60_000);
    expect(proposal!.plan.assumptions.join(" ")).toMatch(/already be due/);
  });
});

describe("manual intake validation", () => {
  it("creates a situation with constraints and an initial task in one transaction", () => {
    const s = svc.createSituation({ title: "Gas refill", category: "general", expected_at: ist(25, 10), constraints: { available_from: ist(25, 9) }, initial_task: { title: "Call the supplier", due_at: ist(24, 12) } }, "user");
    expect(svc.getTasks(s.id).map((t) => t.title)).toEqual(["Call the supplier"]);
    expect(svc.getActivityLog(s.id).map((e) => e.event_type)).toEqual(["situation_created", "task_created"]);
  });
  it("rejects bad timestamps and inverted windows, writing nothing", () => {
    expect(code(() => svc.createSituation({ title: "x", category: "maintenance", expected_at: ist(23, 14), constraints: { window_end: ist(23, 13) } }))).toBe("INVALID_INPUT");
    expect(code(() => svc.createSituation({ title: "x", category: "general", constraints: { available_from: "soon" } }))).toBe("INVALID_INPUT");
    expect(code(() => svc.createSituation({ title: "x", category: "general", initial_task: { title: "t", due_at: "later" } }))).toBe("INVALID_INPUT");
    expect(svc.listSituations({ statuses: ["open"] })).toHaveLength(0);
  });
  it("update_situation records old and new values, is idempotent, and is refused once resolved", () => {
    const s = svc.createSituation({ title: "Visit", category: "family_visit", expected_at: ist(23, 19) });
    svc.updateSituation(s.id, { expected_at: ist(23, 20) }, "user");
    const ev = svc.getActivityLog(s.id).find((e) => e.event_type === "situation_updated")!;
    expect(ev.metadata).toMatchObject({ old: { expected_at: ist(23, 19) }, new: { expected_at: ist(23, 20) } });
    svc.updateSituation(s.id, { expected_at: ist(23, 20) }, "user");
    expect(svc.getActivityLog(s.id).filter((e) => e.event_type === "situation_updated")).toHaveLength(1);
    expect(code(() => svc.updateSituation(s.id, { expected_at: "tomorrow" }))).toBe("INVALID_INPUT");
    svc.resolveSituation(s.id, { confirmed_by_user: true });
    expect(code(() => svc.updateSituation(s.id, { title: "x" }))).toBe("INVALID_STATE");
  });
});

describe("workload summary", () => {
  it("derives overdue, due today, blocked, waiting-for-approval and ready-to-resolve from real state and the clock", () => {
    const a = svc.createSituation({ title: "A", category: "general" }, "user");
    const overdue = svc.addTask({ situation_id: a.id, title: "Overdue", due_at: ist(22, 12) }, "user"); // 12:00 IST, now is 14:30
    svc.addTask({ situation_id: a.id, title: "Today", due_at: ist(22, 20) }, "user");
    svc.addTask({ situation_id: a.id, title: "Tomorrow", due_at: ist(23, 9) }, "user");
    const dep = svc.addTask({ situation_id: a.id, title: "Waits", depends_on_task_id: overdue.id }, "user");
    const b = svc.createSituation({ title: "B", category: "delivery", expected_at: ist(22, 17), constraints: { available_from: ist(22, 18) } }, "user");
    svc.proposePlan(b.id);
    const done = svc.createSituation({ title: "C", category: "general" }, "user");
    const t = svc.addTask({ situation_id: done.id, title: "Only task" }, "user");
    svc.updateTaskStatus(t.id, "completed", { confirmed_by_user: true });

    const w = svc.workloadSummary();
    expect(w.open_situations).toBe(3);
    expect(w.overdue.map((x) => x.title)).toEqual(["Overdue"]);
    expect(w.due_today.map((x) => x.title)).toEqual(["Today"]);
    expect(w.blocked.map((x) => x.title)).toEqual(["Waits"]);
    expect(w.blocked[0].waiting_on).toBe("Overdue");
    expect(w.waiting_approval.map((x) => x.situation_title)).toEqual(["B"]);
    expect(w.can_resolve.map((x) => x.situation_title)).toEqual(["C"]);
    expect(w.recent_activity.length).toBeGreaterThan(0);
    expect(w.recent_activity[0].situation_title).toBeTruthy();
    expect(dep.id).toBeTruthy();

    now = new Date(ist(22, 21)); // later that evening: "Today" is now overdue
    const later = svc.workloadSummary();
    expect(later.overdue.map((x) => x.title).sort()).toEqual(["Overdue", "Today"]);
    expect(later.due_today).toEqual([]);
  });
  it("resolved situations drop out of the workload", () => {
    const a = svc.createSituation({ title: "A", category: "general" }, "user");
    svc.addTask({ situation_id: a.id, title: "x", due_at: ist(22, 10) });
    svc.resolveSituation(a.id, { confirmed_by_user: true, close_outstanding: true });
    const w = svc.workloadSummary();
    expect(w.open_situations).toBe(0); expect(w.overdue).toEqual([]);
  });
});

describe("time handling", () => {
  it("parses clock ranges with shared meridiems and rejects invalid or inverted ranges", () => {
    expect(parseTimeRange("between 2 PM and 4 PM")).toEqual({ start: { h: 14, mi: 0 }, end: { h: 16, mi: 0 } });
    expect(parseTimeRange("between 2 and 4 PM")).toEqual({ start: { h: 14, mi: 0 }, end: { h: 16, mi: 0 } });
    expect(parseTimeRange("2:30pm - 4:15pm")).toEqual({ start: { h: 14, mi: 30 }, end: { h: 16, mi: 15 } });
    expect(parseTimeRange("14:00 to 16:00")).toEqual({ start: { h: 14, mi: 0 }, end: { h: 16, mi: 0 } });
    expect(parseTimeRange("4 PM to 2 PM")).toBeNull();
    expect(parseTimeRange("sometime later")).toBeNull();
    expect(parseTimeRange("between 13 PM and 14 PM")).toBeNull();
  });
  it("calendar-day logic uses the local day, not the UTC day (IST is UTC+5:30)", () => {
    // 22:30 IST on the 22nd and 00:30 IST on the 23rd share a UTC date prefix pattern but not a local day
    expect(sameLocalDay("2026-10-22T17:00:00Z", "2026-10-22T19:00:00Z", TZ)).toBe(false); // 22:30 vs 00:30 next day
    expect(sameLocalDay("2026-10-22T05:00:00Z", "2026-10-22T17:00:00Z", TZ)).toBe(true); // 10:30 vs 22:30
    expect(localDatePlus(new Date("2026-10-22T19:00:00Z"), 0, TZ)).toEqual({ y: 2026, mo: 10, d: 23 }); // already the 23rd in India
    expect(localDatePlus(new Date("2026-10-22T19:00:00Z"), 1, TZ)).toEqual({ y: 2026, mo: 10, d: 24 });
  });
  it("next occurrence of a clock time rolls to tomorrow exactly at the boundary", () => {
    expect(nextLocalTimeIso(new Date(ist(22, 16, 59)), 17, 0, TZ)).toBe(ist(22, 17));
    expect(nextLocalTimeIso(new Date(ist(22, 17, 0)), 17, 0, TZ)).toBe(ist(23, 17));
    expect(nextLocalTimeIso(new Date(ist(22, 23, 59)), 0, 30, TZ)).toBe(ist(23, 0, 30));
  });
  it("handles daylight-saving zones without crashing and keeps instants ordered", () => {
    const NY = "America/New_York";
    const before = zonedToUtcIso(2026, 3, 8, 1, 30, NY); const after = zonedToUtcIso(2026, 3, 8, 3, 30, NY); // spring-forward day
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(3600_000); // 01:30 EST -> 03:30 EDT is one real hour
    const fall = zonedToUtcIso(2026, 11, 1, 12, 0, NY);
    expect(fall).toBe("2026-11-01T17:00:00.000Z"); // EST (UTC-5) after the fall-back
  });
  it("a service constructed with a different zone formats the same instant differently without changing it", () => {
    const ny = new HomeRelayService(openDb(":memory:"), { tz: "America/New_York", now: () => now });
    const s = ny.createSituation({ title: "X", category: "general", expected_at: "2026-10-22T11:30:00.000Z" });
    expect(ny.getSituation(s.id).situation.expected_at).toBe("2026-10-22T11:30:00.000Z");
  });
});

describe("schema migration v1 -> v2", () => {
  it("upgrades an existing v1 database in place, keeping its data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-mig-")); const file = path.join(dir, "old.db");
    const old = new Database(file); old.pragma("foreign_keys = ON");
    migrate(old, 1);
    expect(old.pragma("user_version", { simple: true })).toBe(1);
    expect(old.prepare("PRAGMA table_info(tasks)").all().some((c: any) => c.name === "template_key")).toBe(false);
    old.prepare(`INSERT INTO situations (id,title,category,status,created_at,updated_at) VALUES ('s1','Old','general','open','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();
    old.prepare(`INSERT INTO tasks (id,situation_id,title,status,created_at,updated_at) VALUES ('t1','s1','Old task','pending','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();
    migrate(old); migrate(old); // repeatable
    expect(old.pragma("user_version", { simple: true })).toBe(4); // latest schema (v3 document vault, v4 standalone tasks + task documents)
    expect(old.prepare("SELECT title, template_key FROM tasks WHERE id='t1'").get()).toEqual({ title: "Old task", template_key: null });
    old.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
