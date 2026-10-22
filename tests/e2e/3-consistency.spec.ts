import { expect, test } from "@playwright/test";
import { MEETING, apiPost, ask, assistant, closeAllOpen, closeAssistant, resetDemo, shot, goTo } from "./helpers";

/**
 * Regression suite for the reported defect: an Open situation with 0 tasks shown beside a conversation that said
 * "collected, resolved". Root cause was one global, persisted conversation unrelated to the selected situation.
 * These tests drive the real browser against the real API, MCP server and SQLite.
 */
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => { await resetDemo(request); await closeAllOpen(request); });

const idOf = (url: string) => decodeURIComponent(url.split("/situation/")[1]);

test("Cases B, C, E: resolve one delivery, create another: no conversation leaks across situations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");

  // first delivery: plan, approve, collect -> resolved
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const firstId = idOf(page.url());
  const dlg = await ask(page, MEETING);
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  await expect(page.getByText("3 open")).toBeVisible();
  await ask(page, "I collected the package");
  await expect(dlg.getByText(/based on your confirmation/i).first()).toBeVisible();
  await closeAssistant(page);
  await expect(page.locator(".d-meta .badge").first()).toContainText("Resolved"); // Case C: detail reflects it

  // dashboard agrees with the same persisted state
  await goTo(page, "Home");
  await expect(page.locator(".stat", { hasText: "Open situations" })).toContainText("0");
  await goTo(page, "Situations");
  await expect(page.getByRole("heading", { name: "Recently resolved" })).toBeVisible();

  // second delivery: a NEW situation with a NEW identifier
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const secondId = idOf(page.url());
  expect(secondId).not.toBe(firstId);
  await expect(page.locator(".d-meta .badge").first()).toContainText("Open");
  await expect(page.getByText("0 open")).toBeVisible();

  // the assistant for the NEW situation knows nothing of the old one
  await page.getByRole("button", { name: "Ask about this situation" }).click();
  await expect(dlg.getByText(/Working on:/)).toContainText("Package arriving while you are at work");
  await expect(dlg.getByText(/based on your confirmation/i)).toHaveCount(0);
  await expect(dlg.locator(".msg.user", { hasText: MEETING })).toHaveCount(0); // (the prompt may appear as a suggestion chip, never as a past message)
  await expect(dlg.getByText(/Tell me what changed/)).toBeVisible(); // empty thread
  await page.screenshot({ path: shot("c-01-new-situation-clean-assistant") });
  await closeAssistant(page);

  // Case E: reload keeps THIS situation's state and does not restore the old thread into it
  await page.reload();
  await expect(page.locator(".d-meta .badge").first()).toContainText("Open");
  await page.getByRole("button", { name: "Ask about this situation" }).click();
  await expect(dlg.getByText(/based on your confirmation/i)).toHaveCount(0);
  await closeAssistant(page);

  // the OLD situation still has its own, correct history
  await page.goto(`/#/situation/${firstId}`);
  await expect(page.locator(".d-meta .badge").first()).toContainText("Resolved");
  await page.getByRole("button", { name: "Ask about this situation" }).click();
  await expect(dlg.getByText(/based on your confirmation/i).first()).toBeVisible();
  await expect(dlg.getByText(/Working on:/)).toContainText("Package arriving");
  await closeAssistant(page);
});

test("Case A: clicking Simulate while one is active opens that same situation and never duplicates it", async ({ page }) => {
  await page.goto("/#/");
  // an active simulated delivery exists from the previous test
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const id = idOf(page.url());
  await page.getByRole("button", { name: /All situations/ }).click();
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByText(/already active/)).toBeVisible();
  await expect.poll(() => idOf(page.url())).toBe(id);
  await page.getByRole("button", { name: /All situations/ }).click();
  await expect(page.getByRole("list", { name: "Open situations" }).getByRole("listitem")).toHaveCount(1);
});

test("assistant context follows the selected situation by identifier, not by title", async ({ page, request }) => {
  // two situations with the SAME title
  const a = await (await apiPost(request, "/situations", { title: "Same title", category: "general" })).json();
  const b = await (await apiPost(request, "/situations", { title: "Same title", category: "general" })).json();
  await page.goto(`/#/situation/${a.situation.id}`);
  await expect(page.getByRole("heading", { name: "Same title" })).toBeVisible();
  const dlg = await ask(page, "What is still pending?");
  await expect(dlg.getByText(/open situation/i).first()).toBeVisible();
  await closeAssistant(page);

  await page.goto(`/#/situation/${b.situation.id}`);
  await expect(page.getByRole("heading", { name: "Same title" })).toBeVisible();
  await page.getByRole("button", { name: "Ask about this situation" }).click();
  await expect(dlg.getByText(/Tell me what changed/)).toBeVisible(); // B has its own, empty thread even though the title matches A
  await expect(dlg.locator(".msg.user", { hasText: "What is still pending?" })).toHaveCount(0);
});

test("Case D: a slow response for a situation the user left cannot overwrite the current view", async ({ page, request }) => {
  const a = await (await apiPost(request, "/situations", { title: "Slow situation A", category: "general" })).json();
  const b = await (await apiPost(request, "/situations", { title: "Quick situation B", category: "general" })).json();
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.route(`**/api/situations/${a.situation.id}`, async (route) => { await new Promise((r) => setTimeout(r, 1800)); await route.continue(); });
  await page.evaluate((id) => { window.location.hash = `#/situation/${id}`; }, a.situation.id);
  await page.evaluate((id) => { window.location.hash = `#/situation/${id}`; }, b.situation.id); // user moves on immediately
  await expect(page.getByRole("heading", { name: "Quick situation B" })).toBeVisible();
  await page.waitForTimeout(2300); // let A's slow response arrive
  await expect(page.getByRole("heading", { name: "Quick situation B" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Slow situation A" })).toHaveCount(0);
});

test("a task is acknowledged as finished only after the server accepts it; failures are shown honestly", async ({ page, request }) => {
  const s = await (await apiPost(request, "/situations", { title: "Honest completion", category: "general", initialTaskTitle: "Water the plants" })).json();
  await page.goto(`/#/situation/${s.situation.id}`);
  const row = page.locator("li.task").filter({ has: page.locator(".task-title", { hasText: "Water the plants" }) });
  // 1) server rejects: no success state, an error toast, and the task is still open
  await page.route("**/api/tasks/*/status", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_STATE", message: "The task could not be completed." } }) }));
  await row.getByRole("button", { name: "Mark done" }).click();
  await row.getByRole("button", { name: "Yes, it is done" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be completed" })).toBeVisible();
  await expect(row).not.toHaveClass(/completed|just-done/);
  await expect(row.getByRole("button", { name: "Mark done" })).toBeVisible();
  await page.unroute("**/api/tasks/*/status");
  // 2) server accepts: the row moves to Finished and is acknowledged
  await row.getByRole("button", { name: "Mark done" }).click();
  await row.getByRole("button", { name: "Yes, it is done" }).click();
  const finished = page.getByRole("list", { name: "Finished" }).locator("li.task", { hasText: "Water the plants" });
  await expect(finished).toBeVisible();
  await expect(finished).toHaveClass(/just-done/);
  await expect(page.getByText("Marked done, based on your confirmation.")).toBeVisible();
});

test("assistant drawer: focus returns to its opener, Escape closes, reduced motion keeps it working", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/");
  const opener = page.getByRole("button", { name: "Ask HomeRelay" }).first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dlg = assistant(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel("Message HomeRelay")).toBeFocused(); // ready to type
  const ms = await dlg.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);
  expect(ms).toBeLessThan(5); // movement removed under prefers-reduced-motion
  // page behind is inert while the drawer is open
  expect(await page.evaluate(() => document.documentElement.classList.contains("scroll-locked"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.classList.contains("scroll-locked"))).toBe(false);
});

test("new-situation sheet has exactly one scroll region and a reachable footer on a short laptop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/#/");
  await page.getByRole("button", { name: "New situation" }).first().click();
  const dlg = page.getByRole("dialog", { name: "New situation" });
  await dlg.getByLabel("Type", { exact: true }).selectOption("maintenance");
  await page.waitForTimeout(450);
  const scrollers = await dlg.evaluate((root) => {
    const out: string[] = [];
    root.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el as Element);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1) out.push((el as HTMLElement).className);
    });
    const self = getComputedStyle(root);
    return { nested: out, dialogScrolls: (self.overflowY === "auto" || self.overflowY === "scroll") && root.scrollHeight > root.clientHeight + 1 };
  });
  expect(scrollers.nested).toEqual(["sheet-scroll"]);
  expect(scrollers.dialogScrolls).toBe(false);
  await expect(dlg.getByRole("button", { name: "Create situation" })).toBeInViewport();
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeInViewport();
  await page.screenshot({ path: shot("c-02-sheet-short-screen") });
});

test("a saved-confirmation toast is visible above the full-screen assistant on a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await (await apiPost(request, "/situations", { title: "Toast check", category: "delivery", startLocal: "2030-03-01T17:00", windowEndLocal: "2030-03-01T18:00", availableFromLocal: "2030-03-01T18:00" })).json();
  await page.goto(`/#/situation/${s.situation.id}`);
  const dlg = await ask(page, "Help me plan this");
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  const toast = page.locator(".toast", { hasText: "Saved:" });
  await expect(toast).toBeVisible();
  await page.screenshot({ path: shot("c-03-toast-above-mobile-drawer") });
  // The region is a top-layer popover (a modal dialog is top layer too); being the later one it stacks above the drawer.
  // (elementFromPoint cannot be used here: content outside a modal dialog is inert and is skipped by hit-testing.)
  await expect(toast).toBeInViewport({ ratio: 0.9 });
  expect(await page.locator(".toast-region").evaluate((el) => el.matches(":popover-open"))).toBe(true);
  await page.screenshot({ path: shot("c-03-toast-above-mobile-drawer") });
});
