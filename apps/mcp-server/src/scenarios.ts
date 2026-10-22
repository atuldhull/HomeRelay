import type { Category, Situation, Task, TaskKind } from "@homerelay/shared";
import { formatClock } from "@homerelay/shared";

/**
 * Scenario definitions: WHAT each kind of household situation needs, kept separate from the shared planner that
 * executes them. Adding a scenario means adding one object here (plus tests), not touching the planner.
 */

export type Anchor = "expected" | "available" | "window_end";

export interface PlanContext {
  situation: Situation;
  tasks: Task[];
  tz: string;
  now: Date;
}

export interface TaskTemplate {
  /** Stable identity stored on the task as template_key; replanning matches on it. */
  key: string;
  title: string | ((c: PlanContext) => string);
  description: string | ((c: PlanContext) => string);
  kind: TaskKind;
  /** Due time = anchor instant + offset. */
  anchor: Anchor;
  offsetMin: number;
  /** Another template that must be completed first. */
  dependsOn?: string;
  /** Include this template only when the predicate holds (e.g. only when there is a conflict). */
  when?: (c: PlanContext, conflicts: string[]) => boolean;
  rationale: (c: PlanContext) => string;
}

export interface RequiredInfo {
  /** True when the information is already known. */
  known: (c: PlanContext) => boolean;
  question: string;
}

export interface Scenario {
  category: Category;
  label: string;
  summary: string;
  /** Asked, in order, before any plan is proposed. The planner never guesses these. */
  required: RequiredInfo[];
  conflicts: (c: PlanContext) => string[];
  templates: TaskTemplate[];
  /** Human description of when the situation counts as resolved. */
  resolution: string;
  /** Explicit resolution rule evaluated against real task state. */
  canResolve: (c: PlanContext) => boolean;
  assumptions: string[];
}

const t = (c: PlanContext, iso: string | null | undefined) => formatClock(iso, c.tz);
const done = (c: PlanContext, key: string) => c.tasks.some((x) => x.template_key === key && x.status === "completed");
const COMMON_ASSUMPTIONS = [
  "Reminders are in-app tasks with a due time. HomeRelay does not send external notifications.",
  "Nobody has been contacted. Anything involving another person is a task for you to confirm.",
];

export const DELIVERY: Scenario = {
  category: "delivery",
  label: "Delivery coordination",
  summary: "A package arrives while you may be unavailable.",
  required: [{ known: (c) => !!c.situation.constraints.available_from, question: "When will you be free to collect the package?" }],
  conflicts: (c) => {
    const s = c.situation; const k = s.constraints; const out: string[] = [];
    if (s.expected_at && k.available_from && new Date(k.available_from) > new Date(s.expected_at)) {
      out.push(`The delivery is expected ${t(c, s.expected_at)}${k.window_end ? `–${t(c, k.window_end)}` : ""}, but you are unavailable until ${t(c, k.available_from)}.`);
    }
    if (k.nobody_else_home) out.push("No one else is home to receive the package.");
    return out;
  },
  templates: [
    {
      key: "collect", kind: "followup", anchor: "available", offsetMin: 0,
      title: "Check delivery status and collect the package",
      description: "Look for the package as soon as you are free. Mark it collected only once you actually have it.",
      rationale: (c) => `You are free from ${t(c, c.situation.constraints.available_from)}.`,
    },
    {
      key: "ask_household", kind: "coordination", anchor: "expected", offsetMin: -30,
      title: "Ask a trusted household member if they can collect it",
      description: "HomeRelay has not contacted anyone. Confirm their availability yourself before relying on this.",
      when: (_c, conflicts) => conflicts.length > 0,
      rationale: () => "Optional backup in case the delivery arrives while you are unavailable.",
    },
    {
      key: "redeliver", kind: "contingency", anchor: "available", offsetMin: 60, dependsOn: "collect",
      title: "If it was not delivered: arrange redelivery or pickup",
      description: "Only needed if the package is not there when you check.",
      rationale: () => "Follow-up that only matters if the first check fails.",
    },
  ],
  resolution: "Resolved when you confirm the package is collected (or you close it yourself).",
  canResolve: (c) => done(c, "collect"),
  assumptions: COMMON_ASSUMPTIONS,
};

export const MAINTENANCE: Scenario = {
  category: "maintenance",
  label: "Maintenance appointment",
  summary: "A technician visits during a time window and someone needs to be there.",
  required: [
    { known: (c) => !!c.situation.expected_at, question: "When is the technician coming?" },
    { known: (c) => !!c.situation.constraints.window_end, question: "What time window did the technician give (for example 2 PM to 4 PM)?" },
    { known: (c) => !!c.situation.constraints.available_from, question: "When will you be home?" },
  ],
  conflicts: (c) => {
    const s = c.situation; const k = s.constraints; const out: string[] = [];
    if (!s.expected_at || !k.window_end || !k.available_from) return out;
    const start = new Date(s.expected_at).getTime(); const end = new Date(k.window_end).getTime(); const home = new Date(k.available_from).getTime();
    const win = `${t(c, s.expected_at)}–${t(c, k.window_end)}`;
    if (home >= end) out.push(`You will not be home during the technician's window (${win}); you are home from ${t(c, k.available_from)}.`);
    else if (home > start) out.push(`The technician's window is ${win}, but you are not home until ${t(c, k.available_from)}, so the start of the window overlaps your absence.`);
    return out;
  },
  templates: [
    {
      key: "be_home", kind: "followup", anchor: "expected", offsetMin: -30,
      title: "Be home or arrange access before the technician arrives",
      description: "Make sure someone can let the technician in when the window opens.",
      rationale: (c) => `The window opens at ${t(c, c.situation.expected_at)}.`,
    },
    {
      key: "access_instructions", kind: "coordination", anchor: "expected", offsetMin: -60,
      title: "Prepare access instructions for the technician",
      description: "Where the key is, building entry, a phone number. HomeRelay has not contacted the technician.",
      when: (_c, conflicts) => conflicts.length > 0,
      rationale: () => "You may not be home when they arrive.",
    },
    {
      key: "ask_later_slot", kind: "contingency", anchor: "expected", offsetMin: -120,
      title: "Ask the technician for a later slot",
      description: "You would miss the whole window. Contact them yourself; HomeRelay cannot change the appointment.",
      when: (c) => !!c.situation.constraints.available_from && !!c.situation.constraints.window_end && new Date(c.situation.constraints.available_from) >= new Date(c.situation.constraints.window_end),
      rationale: () => "You are not home at any point in the window.",
    },
    {
      key: "confirm_done", kind: "followup", anchor: "window_end", offsetMin: 30, dependsOn: "be_home",
      title: "Confirm the repair was completed",
      description: "After the visit, check the work and note anything left to do.",
      rationale: (c) => `The window ends at ${t(c, c.situation.constraints.window_end)}.`,
    },
  ],
  resolution: "Resolved when you confirm the repair was completed (or you close it yourself).",
  canResolve: (c) => done(c, "confirm_done"),
  assumptions: COMMON_ASSUMPTIONS,
};

export const FAMILY_VISIT: Scenario = {
  category: "family_visit",
  label: "Family visit preparation",
  summary: "People are arriving and the home needs preparing beforehand.",
  required: [{ known: (c) => !!c.situation.expected_at, question: "When do they arrive?" }],
  conflicts: (c) => {
    const s = c.situation; const k = s.constraints;
    return s.expected_at && k.available_from && new Date(k.available_from) > new Date(s.expected_at)
      ? [`They arrive ${t(c, s.expected_at)}, but you are not home until ${t(c, k.available_from)}.`] : [];
  },
  templates: [
    { key: "groceries", kind: "general", anchor: "expected", offsetMin: -360, title: "Buy groceries and essentials for the visit", description: "Food, drinks and anything the guests usually need.", rationale: () => "Scheduled well before arrival." },
    { key: "prepare_room", kind: "general", anchor: "expected", offsetMin: -240, title: "Prepare the guest room", description: "Linens, towels, a clear space for luggage.", rationale: () => "Done before the final tidy." },
    { key: "tidy_common", kind: "general", anchor: "expected", offsetMin: -90, dependsOn: "prepare_room", title: "Tidy the common areas", description: "Living room, kitchen and bathroom.", rationale: () => "After the room is ready." },
    { key: "confirm_arrival", kind: "followup", anchor: "expected", offsetMin: -45, title: "Confirm arrival time and pickup plan", description: "Check the latest travel plans with them yourself.", rationale: () => "A last check shortly before they arrive." },
    {
      key: "arrange_welcome", kind: "coordination", anchor: "expected", offsetMin: -60,
      title: "Arrange for someone to welcome them",
      description: "You will not be home on arrival. HomeRelay has not contacted anyone; confirm with them yourself.",
      when: (_c, conflicts) => conflicts.length > 0,
      rationale: () => "You are not home when they arrive.",
    },
  ],
  resolution: "Resolved when all preparation tasks are completed or cancelled and you confirm.",
  canResolve: (c) => c.tasks.length > 0 && c.tasks.every((x) => x.status === "completed" || x.status === "cancelled"),
  assumptions: COMMON_ASSUMPTIONS,
};

export const GENERAL: Scenario = {
  category: "general",
  label: "General follow-up",
  summary: "Anything else you want tracked.",
  required: [],
  conflicts: () => [],
  templates: [{
    key: "follow_up", kind: "followup", anchor: "expected", offsetMin: 0, title: (c) => `Follow up: ${c.situation.title}`, description: (c) => c.situation.description,
    rationale: () => "No planning rules exist for this category yet, so a single follow-up is proposed.",
  }],
  resolution: "Resolved when you confirm.",
  canResolve: (c) => c.tasks.length > 0 && c.tasks.every((x) => x.status === "completed" || x.status === "cancelled"),
  assumptions: COMMON_ASSUMPTIONS,
};

export const SCENARIOS: Record<Category, Scenario> = {
  delivery: DELIVERY, maintenance: MAINTENANCE, family_visit: FAMILY_VISIT, general: GENERAL,
};

/** Read-only description for the MCP workflow-catalog resource and the UI. */
export function scenarioCatalog() {
  return Object.values(SCENARIOS).map((s) => ({
    category: s.category, label: s.label, summary: s.summary,
    required_information: s.required.map((r) => r.question),
    tasks: s.templates.map((x) => ({ key: x.key, title: x.title, kind: x.kind, depends_on: x.dependsOn ?? null, conditional: !!x.when })),
    resolution: s.resolution,
  }));
}
