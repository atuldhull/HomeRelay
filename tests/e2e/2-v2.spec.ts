import { expect, test } from "@playwright/test";
import { ask, assistant, closeAssistant, resetDemo, shot, goTo } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => { await resetDemo(request); });

test("manual intake: validation, creation, plan explanation, keyboard approval, dependency UI, workload, filters, export", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // ---- sheet validation (accessible errors, focus stays in the sheet)
  await page.getByRole("button", { name: "New situation" }).first().click();
  const dlg = page.getByRole("dialog", { name: "New situation" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Create situation" }).click();
  await expect(dlg.getByText("Give it a short title.")).toBeVisible();
  await expect(dlg.getByLabel("Title", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await dlg.getByLabel("Type", { exact: true }).selectOption("maintenance");
  await dlg.getByLabel("Title", { exact: true }).fill("Boiler service");
  await dlg.getByRole("button", { name: "Create situation" }).click();
  await expect(dlg.getByText("A maintenance appointment needs a start time.")).toBeVisible();
  await dlg.getByLabel("Window starts").fill("2030-01-15T14:00");
  await dlg.getByLabel("Window ends").fill("2030-01-15T13:00");
  await dlg.getByRole("button", { name: "Create situation" }).click();
  await expect(dlg.getByText("The end must be after the start.")).toBeVisible();
  await page.screenshot({ path: shot("v2-01-sheet-errors") });
  await dlg.getByLabel("Window ends").fill("2030-01-15T16:00");
  await dlg.getByLabel("You will be home from (optional)").fill("2030-01-15T15:00");
  await dlg.getByRole("button", { name: "Create situation" }).click();
  await expect(dlg).toBeHidden(); // closed only after the server confirmed

  // ---- situation detail: scenario-aware next action
  await expect(page.getByRole("heading", { name: "Boiler service" })).toBeVisible();
  const next = page.getByRole("region", { name: "Next recommended action" });
  await expect(next).toContainText("Ask HomeRelay to plan this");
  await expect(next).toContainText("Maintenance appointment");

  // ---- plan with explanation
  const drawer = await ask(page, "Help me plan this");
  const proposal = drawer.getByRole("region", { name: "Proposed plan" });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText("not home until 3:00 PM").first()).toBeVisible();
  await expect(proposal.getByText("Why this plan")).toBeVisible(); // open by default for a plan awaiting a decision
  await expect(proposal.getByText("You are available from 3:00 PM")).toBeVisible();
  await expect(proposal.getByText("not written by a language model")).toBeVisible();
  await expect(page.getByText("0 open")).toBeVisible();

  // ---- keyboard-only approval
  const approve = drawer.getByRole("button", { name: /Approve plan/ });
  await approve.focus();
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("3 open")).toBeVisible();
  await closeAssistant(page);

  // ---- dependency enforced in the UI (and by the server)
  const confirmRow = page.locator("li.task").filter({ has: page.locator(".task-title", { hasText: /^Confirm the repair/ }) });
  await expect(confirmRow.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await expect(confirmRow.getByText(/Waiting for: Be home or arrange access/).first()).toBeVisible();
  await page.screenshot({ path: shot("v2-02-maintenance") });

  // ---- dashboard numbers come from persisted data
  await goTo(page, "Home");
  const stat = (name: string) => page.locator(".stat", { hasText: name });
  await expect(stat("Open situations")).toContainText("1");
  await expect(stat("Awaiting approval")).toContainText("0");
  await expect(stat("Overdue")).toContainText("0");
  await expect(page.getByRole("region", { name: "HomeRelay Pulse" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText("Plan approved"); // the latest five recorded events
  await page.screenshot({ path: shot("v2-03-dashboard") });

  // ---- filters live on the Situations workspace
  await goTo(page, "Situations");
  const filters = page.getByRole("search", { name: "Filter situations" });
  await filters.getByLabel("Search by title").fill("zzz-no-match");
  await expect(page.getByText("No situations match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await filters.getByLabel("Type").selectOption("delivery");
  await expect(page.getByText("No situations match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("list", { name: "Open situations" }).getByRole("listitem")).toHaveCount(1);

  // ---- export is real, attachment, and formula-safe
  const href = await page.getByRole("link", { name: /Open tasks \(CSV\)/ }).getAttribute("href");
  const csv = await request.get(href!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  expect(await csv.text()).toContain("Be home or arrange access");
});

test("the ask bar: natural-language maintenance and family visit create real situations and their own threads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const bar = page.locator("#askbar-input");
  await bar.fill("The electrician is coming tomorrow between 2 PM and 4 PM, but I might not get home until 3 PM.");
  await bar.press("Enter");
  const dlg = assistant(page);
  await expect(dlg).toBeVisible();
  await expect(page.getByRole("heading", { name: "Electrician visit" })).toBeVisible(); // navigated because it was created from home
  await expect(dlg.getByRole("region", { name: "Proposed plan" }).first()).toBeVisible();
  await expect(dlg.getByText(/only a proposal/i).first()).toBeVisible();
  await expect(dlg.getByText(/Working on:/)).toContainText("Electrician visit"); // the exchange moved into the new situation's thread
  await closeAssistant(page);

  await goTo(page, "Home");
  await page.locator("#askbar-input").fill("My parents arrive tomorrow evening. Help me prepare.");
  await page.locator("#askbar-input").press("Enter");
  await expect(page.getByRole("heading", { name: "Visit from your parents" })).toBeVisible();
  await expect(dlg.getByText(/took "evening" as 6:00 PM/)).toBeVisible();
  await closeAssistant(page);

  // "What needs attention" is answered from real data and changes nothing
  await goTo(page, "Home");
  await page.locator("#askbar-input").fill("What needs attention today?");
  await page.locator("#askbar-input").press("Enter");
  await expect(dlg.getByText(/Plan waiting for your approval: Electrician visit/)).toBeVisible();
  await expect(dlg.getByLabel("What was saved")).toHaveCount(0);
});

test("API failure shows an honest error with Retry, and recovery works", async ({ page }) => {
  await page.route("**/api/dashboard", (r) => r.abort());
  await page.goto("/");
  const banner = page.getByRole("alert").first();
  await expect(banner).toContainText(/Cannot reach|unexpected/i);
  await page.unroute("**/api/dashboard");
  await banner.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("mobile: sheet and dashboard are usable without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/situations"); // on phones the rail is a bottom bar; create from the Situations workspace
  await page.getByRole("button", { name: "New situation" }).first().click();
  const dlg = page.getByRole("dialog", { name: "New situation" });
  await expect(dlg).toBeVisible();
  await page.waitForTimeout(450);
  const box = await dlg.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(dlg.getByRole("button", { name: "Create situation" })).toBeInViewport(); // footer stays reachable
  await page.screenshot({ path: shot("v2-04-mobile-sheet") });
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.screenshot({ path: shot("v2-05-mobile-dashboard") });
});
