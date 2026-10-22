import { expect, test } from "@playwright/test";
import { MEETING, ask, assistant, closeAssistant, goTo, shot, waitForStack } from "./helpers";

test("hero scenario in the browser: event -> plan -> approve -> replan -> reload -> collected", async ({ page, request }) => {
  await waitForStack(request); // a fresh e2e database: the tool server may still be starting
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // Empty state
  await expect(page.getByRole("heading", { name: "Tell HomeRelay what is happening" })).toBeVisible();
  await page.screenshot({ path: shot("01-empty") });

  // One-click demo event creates a real, labelled situation
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  await expect(page.getByText("Simulated").first()).toBeVisible();

  // Conflict + proposal via the assistant (real MCP calls)
  const dlg = await ask(page, MEETING);
  const proposal = dlg.getByRole("region", { name: "Proposed plan" });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText("Awaiting your decision")).toBeVisible();
  await expect(page.getByText("0 open")).toBeVisible(); // a proposal alone created no tasks
  await expect(dlg.getByText("3 tool calls").first()).toBeVisible();
  await expect(dlg.getByLabel("What was saved")).toContainText("Plan drafted"); // derived from the real trace
  await page.screenshot({ path: shot("02-proposal") });

  // Approve (user action) -> tasks saved
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  await expect(page.getByText("3 open")).toBeVisible();
  await expect(page.getByText("Check delivery status and collect the package").first()).toBeVisible();
  await page.screenshot({ path: shot("03-approved") });

  // Meeting extended -> replan -> reschedule (no duplicates)
  await ask(page, "My meeting has been extended until 7 PM");
  await expect(dlg.getByText("Reschedule: Check delivery status and collect the package")).toBeVisible();
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  await expect(page.getByText("3 open")).toBeVisible();
  await closeAssistant(page);
  const tasksPanel = page.getByRole("region", { name: "Tasks" });
  await expect(tasksPanel.getByText("Due 7:00 PM").first()).toBeVisible();
  await expect(tasksPanel.locator(".task-title", { hasText: /^Check delivery status/ })).toHaveCount(1);
  await page.screenshot({ path: shot("04-replanned") });

  // Persistence across reload, including this situation's own conversation
  await page.reload();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tasks" }).getByText("Due 7:00 PM").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity timeline" }).getByText("Rescheduled").first()).toBeVisible();
  await page.getByRole("button", { name: "Ask about this situation" }).click();
  await expect(assistant(page).getByText(MEETING)).toBeVisible();
  await closeAssistant(page);

  // Task completion needs explicit confirmation
  const task = page.locator("li.task").filter({ has: page.locator(".task-title", { hasText: /^Check delivery status/ }) });
  await task.getByRole("button", { name: "Mark done" }).click();
  await expect(task.getByText("Did you actually do this?")).toBeVisible();
  await task.getByRole("button", { name: "Not yet" }).click();
  await expect(task.getByRole("button", { name: "Mark done" })).toBeVisible();

  // Collected via the assistant -> resolved, honestly worded
  await ask(page, "I collected the package");
  await expect(dlg.getByText(/based on your confirmation/i).first()).toBeVisible();
  await expect(dlg.getByText(/not verified this with the courier/i).first()).toBeVisible();
  await closeAssistant(page);
  await expect(page.getByText(/Resolved .*based on your confirmation/)).toBeVisible();
  await page.getByRole("button", { name: /All situations/ }).click();
  await expect(page.getByRole("heading", { name: "Recently resolved" })).toBeVisible();
  await page.screenshot({ path: shot("05-resolved") });

  // Demo reset only removes simulated data (the control lives on Home)
  await goTo(page, "Home");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await expect(page.getByRole("heading", { name: "Tell HomeRelay what is happening" })).toBeVisible();
});

test("duplicate clicks do not duplicate the demo event; mobile layout is usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const url = page.url();
  await page.getByRole("button", { name: /All situations/ }).click();
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByText(/already active/)).toBeVisible();
  await expect(page).toHaveURL(url); // opened the SAME situation, not a new one
  await page.getByRole("button", { name: /All situations/ }).click();
  await expect(page.getByRole("list", { name: "Open situations" }).getByRole("listitem")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.screenshot({ path: shot("06-mobile") });
  // the assistant workspace is reachable from the bottom bar and uses the full width
  await goTo(page, "Assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await expect(chat.getByLabel("Message HomeRelay")).toBeVisible();
  const box = await chat.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(340);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.screenshot({ path: shot("07-mobile-assistant") });
});
