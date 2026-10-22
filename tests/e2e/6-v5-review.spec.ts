import { expect, test, type Page } from "@playwright/test";
import { MEETING, apiPost, ask, closeAllOpen, closeAssistant, localIn, overflowing, resetDemo, waitForStack } from "./helpers";

// UI review: seeds real records through the API, visits every workspace, checks layout at five viewports and saves
// screenshots to artifacts/homerelay-v5-ui-review/<V5_SHOTS or "final">/ (git-ignored).
const dir = `artifacts/homerelay-v5-ui-review/${process.env.V5_SHOTS ?? "final"}`;
const shot = (page: Page, n: string, fullPage = false) => page.screenshot({ animations: "disabled", path: `${dir}/${n}.png`, fullPage });
const json = (r: { json: () => Promise<any> }) => r.json();
const ids: Record<string, string> = {};
const upload = async (request: any, name: string, text: string) =>
  (await (await request.post("/api/documents", { headers: { "x-homerelay-client": "web", "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) }, data: Buffer.from(text) })).json()).document.id as string;

test.beforeAll(async ({ request }) => {
  await waitForStack(request); await resetDemo(request); await closeAllOpen(request);
  ids.sit = (await json(await apiPost(request, "/situations", { title: "Boiler service visit", category: "maintenance", startLocal: localIn(30), windowEndLocal: localIn(32), description: "Annual boiler service by the gas engineer." }))).situation.id;
  ids.order = (await json(await apiPost(request, "/tasks", { title: "Order a replacement filter", category: "shopping", priority: "high", dueLocal: localIn(3) }))).task.id;
  ids.fit = (await json(await apiPost(request, "/tasks", { title: "Fit the new filter", situationId: ids.sit, dependsOnTaskId: ids.order, dueLocal: localIn(28) }))).task.id;
  ids.bleed = (await json(await apiPost(request, "/tasks", { title: "Bleed the radiators", category: "maintenance", recurrence: "monthly", dueLocal: localIn(50) }))).task.id;
  ids.bill = (await json(await apiPost(request, "/tasks", { title: "Pay the water bill", category: "bills", dueLocal: localIn(-5) }))).task.id;
  ids.warranty = await upload(request, "Boiler warranty.txt", "Boiler warranty: model GB-210, serial 4471-K. Covered until June 2028. Service every 12 months.");
  ids.invoice = await upload(request, "Plumber invoice.txt", "Invoice 2209: radiator valve replaced. Paid.");
  await apiPost(request, `/documents/${ids.warranty}/link`, { situationId: ids.sit });
  await apiPost(request, `/tasks/${ids.fit}/documents/link`, { documentId: ids.warranty });
});

test("desktop review of every workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const visit = async (hash: string, name: string, h1: string | RegExp) => {
    await page.goto(`/${hash}`);
    await expect(page.getByRole("heading", { level: 1, name: h1 }).first()).toBeVisible();
    await page.waitForTimeout(350);
    expect(await overflowing(page), name).toEqual([]);
    await shot(page, name);
  };
  await visit("#/", "01-home", /./);
  await visit("#/situations", "02-situations", "Situations");
  await visit(`#/situation/${ids.sit}`, "03-situation-detail", "Boiler service visit");
  await visit("#/tasks", "04-tasks", "Tasks");
  await visit(`#/task/${ids.fit}`, "05-task-detail", "Fit the new filter");
  await visit("#/documents", "06-documents", "Documents");
  await visit(`#/document/${ids.warranty}`, "07-document-preview", "Boiler warranty");
  await visit("#/map", "08-map", /knowledge map|Relay Map/i);
  await page.getByRole("button", { name: /^Situation: Boiler service visit/ }).click();
  await page.waitForTimeout(400);
  await shot(page, "08b-map-selected");
  await visit("#/activity", "09-activity", "Activity");

  // assistant page with real answers
  await page.goto("/#/assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await chat.getByLabel("Message HomeRelay").fill("What's on my plate today?");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByText(/Pay the water bill/).first()).toBeVisible();
  await chat.getByLabel("Message HomeRelay").fill("Which tasks are blocked?");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByText(/waiting for "Order a replacement filter"/).first()).toBeVisible();
  await shot(page, "10-assistant");

  // contextual drawer on a situation
  await page.goto(`/#/situation/${ids.sit}`);
  const dlg = await ask(page, "Show me everything connected to this");
  await expect(dlg.getByText(/connected to "Boiler service visit"/).first()).toBeVisible();
  await shot(page, "11-assistant-drawer");
  await closeAssistant(page);

  // command palette
  await page.keyboard.press("Control+k");
  const pal = page.getByRole("dialog", { name: "Search and commands" });
  await expect(pal).toBeVisible();
  await pal.getByRole("combobox").fill("boiler");
  await expect(pal.getByRole("option", { name: /Boiler warranty/ })).toBeVisible();
  await shot(page, "12-command-palette");
  await page.keyboard.press("Escape");

  // forms
  await page.getByRole("button", { name: "New situation" }).first().click();
  await expect(page.getByRole("dialog", { name: "New situation" })).toBeVisible();
  await shot(page, "13-new-situation-form");
  await page.keyboard.press("Escape");
  await page.goto("/#/tasks");
  await page.getByRole("button", { name: "New task" }).first().click();
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "14-task-form");
  await page.keyboard.press("Escape");

  // approval state: a real proposal awaiting the user's decision
  await page.goto("/#/");
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const d2 = await ask(page, MEETING);
  await expect(d2.getByRole("region", { name: "Proposed plan" })).toBeVisible();
  await shot(page, "15-approval-state");
  await closeAssistant(page);

  // loading, empty and error states (network shaped by the test, UI real)
  await page.route("**/api/tasks?**", async (r) => { await new Promise((ok) => setTimeout(ok, 2500)); await r.fallback(); });
  await page.goto("/#/tasks");
  await expect(page.getByText(/Loading tasks/)).toBeVisible();
  await shot(page, "16-loading-state");
  await page.unroute("**/api/tasks?**");
  await page.goto("/#/documents");
  await page.locator("#doc-q").fill("zzzz-nothing-matches");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await shot(page, "17-empty-state");
  await page.route("**/api/tasks?**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "MCP_UNAVAILABLE", message: "The HomeRelay tool server is unavailable. Nothing was changed." } }) }));
  await page.goto("/#/tasks");
  await expect(page.getByRole("alert").filter({ hasText: "tool server is unavailable" })).toBeVisible();
  await shot(page, "18-error-state");
  await page.unroute("**/api/tasks?**");
});

test("phone review", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "19-mobile-home-nav");
  const more = page.getByRole("button", { name: "More" });
  if (await more.isVisible()) { await more.click(); await page.waitForTimeout(300); await shot(page, "19b-mobile-more"); await page.keyboard.press("Escape"); }
  await page.goto("/#/tasks");
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "20-mobile-tasks");
  await page.goto(`/#/document/${ids.warranty}`);
  await expect(page.getByRole("heading", { level: 1, name: "Boiler warranty" })).toBeVisible();
  await shot(page, "20b-mobile-document");
  await page.goto(`/#/task/${ids.fit}`);
  await expect(page.getByRole("heading", { level: 1, name: "Fit the new filter" })).toBeVisible();
  await shot(page, "20c-mobile-task");
});

test("five viewports, every route: no horizontal overflow and a visible heading", async ({ page }) => {
  const routes: [string, string | RegExp][] = [
    ["#/", /./], ["#/situations", "Situations"], [`#/situation/${ids.sit}`, "Boiler service visit"], ["#/tasks", "Tasks"], [`#/task/${ids.fit}`, "Fit the new filter"],
    ["#/documents", "Documents"], [`#/document/${ids.warranty}`, "Boiler warranty"], ["#/map", /knowledge map|Relay Map/i], ["#/activity", "Activity"], ["#/assistant", "Assistant"],
  ];
  for (const [w, h] of [[1440, 900], [1280, 720], [768, 1024], [390, 844], [360, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [hash, h1] of routes) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole("heading", { level: 1, name: h1 }).first(), `${w} ${hash}`).toBeVisible();
      await page.waitForTimeout(150);
      expect(await overflowing(page), `${w}x${h} ${hash}`).toEqual([]);
    }
  }
});

test("v5 interactions: map connections, layout toggle, activity filters, recurrence, breadcrumbs, More sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // a map connection explains what is stored and links both records
  await page.goto("/#/map");
  await expect(page.getByRole("button", { name: /^Situation: Boiler service visit/ })).toBeVisible();
  await page.locator(".edge-g").first().click({ force: true });
  const detail = page.getByRole("complementary", { name: "Selected record" });
  await expect(detail.getByText("Connection", { exact: true })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(/is a task in|must happen after|is attached to/);
  await shot(page, "08c-map-connection");

  // documents: list layout is remembered across a reload
  await page.goto("/#/documents");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".doc-grid.as-list")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".doc-grid.as-list")).toHaveCount(1);
  await shot(page, "06b-documents-list");
  await page.getByRole("button", { name: "Grid", exact: true }).click();

  // activity: filters narrow the real events; links open the affected record by id
  await page.goto("/#/activity");
  await page.getByRole("button", { name: /^Documents \d+/ }).click();
  const days = page.getByRole("region", { name: "All activity" });
  await expect(days.getByText(/Document added: Boiler warranty/)).toBeVisible();
  await expect(days.getByText(/Task created: Fit the new filter/)).toHaveCount(0);
  await days.getByRole("button", { name: "Open document" }).first().click();
  await expect(page).toHaveURL(/#\/document\//);
  await page.goto("/#/activity");
  await page.getByRole("button", { name: /^Tasks \d+/ }).click();
  await days.getByRole("button", { name: "Open task" }).first().click();
  await expect(page).toHaveURL(/#\/task\//);

  // recurrence: the panel explains completion, and completing links the next occurrence
  await page.goto(`/#/task/${ids.bleed}`);
  const rep = page.getByRole("region", { name: "Repeats" });
  await expect(rep).toContainText("Every month");
  await expect(rep).toContainText("saves the next one");
  await page.getByRole("button", { name: "Mark done" }).click();
  await page.getByRole("button", { name: "Yes, it is done" }).click();
  await expect(rep).toContainText("This occurrence is finished");
  await expect(rep.getByRole("button").last()).toBeVisible();
  await rep.locator("li").last().getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: "Bleed the radiators" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Repeats" })).toContainText("Previous");
  await shot(page, "05b-task-recurrence");

  // breadcrumbs lead back up
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();

  // a clarification is marked as needing an answer; the status chip explains itself
  await page.goto("/#/assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await chat.getByLabel("Message HomeRelay").fill("What is my fuse down?");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByText("Needs your answer").last()).toBeVisible();
  await expect(page.getByRole("status", { name: /Tools connected\. The MCP tool server is reachable/ })).toBeVisible();
  await expect(page.locator(".msg.agent.working")).toHaveCount(0); // no lingering progress once answered

  // phones: destinations outside the bottom bar are in More
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await expect(more).toBeVisible();
  await shot(page, "19b-mobile-more");
  await more.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(more).toBeHidden();
  await page.getByRole("button", { name: "Search and commands" }).click();
  await expect(page.getByRole("dialog", { name: "Search and commands" })).toBeVisible();
});
