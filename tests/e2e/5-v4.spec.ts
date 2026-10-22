import { expect, test, type Page } from "@playwright/test";
import { MEETING, apiPost, ask, closeAllOpen, closeAssistant, goTo, localIn, overflowing, resetDemo, waitForStack } from "./helpers";

// v4 connected-platform flows against the real stack. Screenshots go to artifacts/homerelay-v4/ (git-ignored).
const v4 = (n: string) => `artifacts/homerelay-v4/${n}.png`;
const shot = (page: Page, n: string, fullPage = false) => page.screenshot({ animations: "disabled", path: v4(n), fullPage });
const errors: string[] = [];
const watch = (page: Page) => { page.on("pageerror", (e) => errors.push(e.message)); };
const json = (r: { json: () => Promise<any> }) => r.json();

test.beforeAll(async ({ request }) => { await waitForStack(request); await resetDemo(request); await closeAllOpen(request); });
test.afterAll(() => { expect(errors.join("\n"), "uncaught page errors").toBe(""); });

test("Scenario A: document -> task -> situation, visible on the map and found by the assistant", async ({ page, request }) => {
  watch(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sit = (await json(await apiPost(request, "/situations", { title: "Washer repair visit", category: "maintenance", startLocal: localIn(26), windowEndLocal: localIn(28) }))).situation.id;

  // upload a receipt and attach it to the maintenance situation from the document page
  await page.goto("/#/documents");
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "Washer repair receipt.txt", mimeType: "text/plain", buffer: Buffer.from("Receipt: washer drum bearing replaced. Invoice 5521. Paid in full.") });
  await expect(page.getByRole("list", { name: "Uploads" }).getByText("Saved")).toBeVisible();
  await shot(page, "12-upload-saved");
  await page.getByRole("button", { name: /Open document: Washer repair receipt/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Washer repair receipt" })).toBeVisible();
  const linked = page.getByRole("region", { name: "Linked situations" });
  await linked.getByLabel("Attach to a situation").selectOption({ label: "Washer repair visit" });
  await linked.getByRole("button", { name: "Attach" }).click();
  await expect(linked.getByRole("button", { name: "Washer repair visit", exact: true })).toBeVisible();
  await shot(page, "13-document-preview");

  // create a follow-up task in that situation, attaching the receipt while creating it
  await goTo(page, "Tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("dialog", { name: "New task" });
  await sheet.getByLabel("Title").fill("Book the follow-up appointment");
  await sheet.getByLabel("Situation").selectOption({ label: "Washer repair visit" });
  await sheet.getByLabel("Attach documents").fill("washer");
  await sheet.getByRole("checkbox", { name: "Washer repair receipt" }).check();
  await sheet.getByRole("button", { name: "Create task" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Book the follow-up appointment" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Task documents" }).getByRole("button", { name: /Open document: Washer repair receipt/ })).toBeVisible();
  await expect(page).toHaveURL(/#\/task\//);
  const taskUrl = page.url();

  // a household task this one must wait for: the dependency is a real relationship
  const buy = (await json(await apiPost(request, "/tasks", { title: "Buy a drum bearing kit", category: "shopping", priority: "high" }))).task.id;
  const fit = (await json(await apiPost(request, "/tasks", { title: "Fit the new bearing", situationId: sit, dependsOnTaskId: buy, dueLocal: localIn(25) }))).task.id;
  await page.goto(`/#/task/${fit}`);
  await expect(page.getByRole("note")).toContainText('Waiting for "Buy a drum bearing kit"');
  await expect(page.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await shot(page, "05-task-dependencies");

  // the situation shows its tasks and the receipt; the task title opens the task
  await page.goto(`/#/situation/${sit}`);
  const tasks = page.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByRole("button", { name: "Open task: Book the follow-up appointment" })).toBeVisible();
  // its prerequisite is a household task outside this situation: still shown as waiting, and cannot be marked done
  const fitRow = tasks.locator("li.task").filter({ has: page.getByRole("button", { name: "Open task: Fit the new bearing" }) });
  await expect(fitRow.getByText("Waiting for: Buy a drum bearing kit")).toBeVisible();
  await expect(fitRow.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Situation documents" }).getByRole("button", { name: /Open document: Washer repair receipt/ })).toBeVisible();
  await shot(page, "06-document-linked-to-situation");

  // the assistant, on this situation, finds the receipt attached to the repair
  const dlg = await ask(page, "Show me the receipt attached to the repair");
  await expect(dlg.getByRole("button", { name: /Open document: Washer repair receipt/ }).last()).toBeVisible();
  await ask(page, "Show me everything connected to this maintenance issue");
  await expect(dlg.getByRole("list", { name: "Records in this answer" }).last().getByRole("button", { name: "Open task: Fit the new bearing" })).toBeVisible();
  await expect(dlg.getByText(/is waiting for "Buy a drum bearing kit"/).last()).toBeVisible();
  await shot(page, "08-assistant-contextual");
  await dlg.getByRole("list", { name: "Records in this answer" }).last().getByRole("button", { name: "Open task: Fit the new bearing" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fit the new bearing" })).toBeVisible();

  // Relay Map: the same records and links
  await goTo(page, "Map");
  const node = page.getByRole("button", { name: /^Situation: Washer repair visit/ });
  await expect(node).toBeVisible();
  await expect(page.getByRole("button", { name: /^Document: Washer repair receipt/ })).toBeVisible();
  await shot(page, "02-relay-map");
  await node.click();
  const detail = page.getByRole("complementary", { name: "Selected record" });
  await expect(detail.getByRole("heading", { name: "Washer repair visit" })).toBeVisible();
  await expect(detail.getByRole("button", { name: /Washer repair receipt/ })).toBeVisible();
  await expect(detail.getByText('"Fit the new bearing" is waiting for "Buy a drum bearing kit"')).toBeVisible();
  await shot(page, "03-map-selected-node");
  // map list view is an accessible alternative with the same links
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("table")).toContainText("Fit the new bearing");
  await page.getByRole("button", { name: "Map view" }).click();
  await detail.getByRole("button", { name: "Open situation" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Washer repair visit" })).toBeVisible();

  // from Home, by name: the assistant searches the stored documents
  await page.goto(taskUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Book the follow-up appointment" })).toBeVisible();
  await goTo(page, "Assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await chat.getByLabel("Message HomeRelay").fill("Find the receipt for the washer repair");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByRole("button", { name: /Open document: Washer repair receipt/ }).last()).toBeVisible();
  await shot(page, "07-document-search-result");
});

test("Scenarios B + C: overdue task through the assistant, Pulse and activity; plan approval updates every view once", async ({ page, request }) => {
  watch(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const late = (await json(await apiPost(request, "/tasks", { title: "Renew the home insurance", category: "bills", dueLocal: localIn(-5) }))).task.id;
  await page.goto("/");
  const pulse = page.getByRole("region", { name: "HomeRelay Pulse" });
  await expect(pulse.getByRole("button", { name: "Overdue: Renew the home insurance" })).toBeVisible();
  await pulse.getByRole("button", { name: "This week" }).click();
  await shot(page, "01-pulse");

  await goTo(page, "Assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await chat.getByLabel("Message HomeRelay").fill("What's overdue?");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  const entity = chat.getByRole("button", { name: "Open task: Renew the home insurance" }).last();
  await expect(entity).toBeVisible();
  await expect(chat.getByText(/not failed/).last()).toBeVisible();
  await chat.getByLabel("Message HomeRelay").fill("Which tasks are blocked?");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByText(/Fit the new bearing: waiting for "Buy a drum bearing kit"/).last()).toBeVisible();
  await shot(page, "09-assistant-multi-step");
  await entity.click();
  await expect(page).toHaveURL(new RegExp(`#/task/${late}$`));
  await page.getByRole("button", { name: "Mark done" }).click();
  await page.getByRole("button", { name: "Yes, it is done" }).click();
  await expect(page.locator(".d-meta .badge").first()).toContainText(/Completed/i);
  await expect(page.getByRole("region", { name: "Task activity" })).toContainText("Task completed: Renew the home insurance");
  await goTo(page, "Home");
  await expect(pulse.getByRole("button", { name: "Overdue: Renew the home insurance" })).toHaveCount(0);
  await goTo(page, "Activity");
  await expect(page.getByText("Task completed: Renew the home insurance").first()).toBeVisible();

  // Scenario C: a proposal creates nothing until the user approves it, then every view agrees
  await goTo(page, "Home");
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  await expect(page.getByRole("heading", { name: "Package arriving while you are at work" })).toBeVisible();
  const sid = decodeURIComponent(page.url().split("/situation/")[1]);
  const dlg = await ask(page, MEETING);
  await expect(dlg.getByRole("region", { name: "Proposed plan" })).toBeVisible();
  await expect(page.getByText("0 open")).toBeVisible();
  expect((await json(await request.get(`/api/tasks?situationId=${sid}`))).tasks).toHaveLength(0);
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  await expect(page.getByText("3 open")).toBeVisible();
  await shot(page, "10-approved-plan");
  await closeAssistant(page);
  const proposal = (await json(await request.get(`/api/situations/${sid}`))).proposals[0];
  const again = await json(await apiPost(request, `/proposals/${proposal.id}/approve`));
  expect(again.already_applied).toBe(true); // repeating the approval creates nothing
  expect((await json(await request.get(`/api/tasks?situationId=${sid}`))).tasks).toHaveLength(3);
  await goTo(page, "Tasks");
  await expect(page.getByRole("button", { name: "Open task: Check delivery status and collect the package" })).toBeVisible();
  await page.getByRole("tab", { name: /Blocked/ }).click();
  await expect(page.getByRole("button", { name: "Open task: Fit the new bearing" })).toBeVisible();
  await page.getByRole("tab", { name: /All open/ }).click();
  await shot(page, "04-task-workspace");
  await goTo(page, "Map");
  await expect(page.getByRole("button", { name: /^Task: Check delivery status and collect the package/ })).toBeVisible();
});

test("Scenario D: deleting an attached document removes only its links", async ({ page, request }) => {
  watch(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const up = await request.post("/api/documents?category=manual", { headers: { "x-homerelay-client": "web", "content-type": "application/octet-stream", "x-filename": "Old%20dryer%20manual.txt" }, data: Buffer.from("Dryer manual, model D-10") });
  const doc = (await up.json()).document.id;
  const sit = (await json(await apiPost(request, "/situations", { title: "Dryer check", category: "general" }))).situation.id;
  const task = (await json(await apiPost(request, "/tasks", { title: "Clean the dryer filter", situationId: sit }))).task.id;
  await apiPost(request, `/documents/${doc}/link`, { situationId: sit });
  await apiPost(request, `/tasks/${task}/documents/link`, { documentId: doc });
  await page.goto(`/#/situation/${sit}`);
  await expect(page.getByRole("region", { name: "Situation documents" }).getByRole("button", { name: /^Open document: Old dryer manual/ })).toBeVisible();
  await page.goto(`/#/document/${doc}`);
  await expect(page.getByRole("region", { name: "Linked tasks" }).getByRole("button", { name: "Clean the dryer filter", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Delete document/ }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await page.goto(`/#/situation/${sit}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dryer check" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Situation documents" }).getByText(/Old dryer manual/)).toHaveCount(0);
  await page.goto(`/#/task/${task}`);
  await expect(page.getByRole("region", { name: "Task documents" })).toContainText("No documents attached");
  const map = await json(await request.get("/api/map"));
  expect(map.nodes.some((n: any) => n.id === doc)).toBe(false);
  const keys = new Set(map.nodes.map((n: any) => n.key));
  expect(map.edges.every((e: any) => keys.has(e.source) && keys.has(e.target))).toBe(true);
});

test("Scenario E: a slow reply for task A cannot land in task B's conversation", async ({ page, request }) => {
  watch(page);
  const a = (await json(await apiPost(request, "/tasks", { title: "Water the balcony plants" }))).task.id;
  const b = (await json(await apiPost(request, "/tasks", { title: "Sort the recycling" }))).task.id;
  await page.goto(`/#/task/${a}`);
  await expect(page.getByRole("heading", { level: 1, name: "Water the balcony plants" })).toBeVisible();
  await page.route("**/api/chat", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.fallback(); });
  const dlg = await ask(page, "Show me everything connected to this");
  await closeAssistant(page);
  await page.goto(`/#/task/${b}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sort the recycling" })).toBeVisible();
  await page.waitForTimeout(2000);
  await page.unroute("**/api/chat");
  const d2 = await ask(page, "What happened recently?");
  await expect(d2.getByText(/Working on task: Sort the recycling/)).toBeVisible();
  await expect(d2.getByText(/connected to "Water the balcony plants"/)).toHaveCount(0);
  await expect(d2.getByText(/Most recent changes recorded for this task/).last()).toBeVisible();
  await closeAssistant(page);
  await page.goto(`/#/task/${a}`);
  const d3 = await ask(page, "Which tasks are blocked?");
  await expect(d3.getByText(/connected to "Water the balcony plants"/).first()).toBeVisible(); // it landed in A's own thread
  void dlg;
});

test("Command palette: one shortcut to any record or action", async ({ page }) => {
  watch(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible(); // the app has mounted
  await page.keyboard.press("Control+k");
  const pal = page.getByRole("dialog", { name: "Search and commands" });
  await expect(pal).toBeVisible();
  const input = pal.getByRole("combobox", { name: "Search and commands" });
  await expect(input).toBeFocused();
  await input.fill("washer");
  await expect(pal.getByRole("option", { name: /Washer repair visit/ })).toBeVisible();
  await expect(pal.getByRole("option", { name: /Washer repair receipt/ })).toBeVisible();
  await shot(page, "11-command-palette");
  await input.fill("bearing kit");
  await expect(pal.getByRole("option", { name: /Buy a drum bearing kit/ })).toBeVisible();
  await input.press("Enter"); // the first option is the best record match
  await expect(pal).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Buy a drum bearing kit" })).toBeVisible();
  await expect(page.locator("main.arrived")).toHaveCount(1); // brief arrival highlight
  // actions are there too
  await page.keyboard.press("Control+k");
  await input.fill("relay map");
  await input.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Your household knowledge map" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await input.fill("zzzz-nothing");
  await expect(pal.getByText("No situations, tasks or documents match")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pal).toBeHidden();
});

test("Route and link audit: every route renders its record, bad ids fail honestly, history and reload work", async ({ page, request }) => {
  watch(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const sit = (await json(await apiPost(request, "/situations", { title: "Audit situation", category: "general" }))).situation.id;
  const task = (await json(await apiPost(request, "/tasks", { title: "Audit task", situationId: sit }))).task.id;
  const doc = (await (await request.post("/api/documents", { headers: { "x-homerelay-client": "web", "content-type": "application/octet-stream", "x-filename": "audit-note.txt" }, data: Buffer.from("audit note") })).json()).document.id;
  const routes: [string, RegExp | string][] = [
    ["#/", /./], ["#/situations", "Situations"], [`#/situation/${sit}`, "Audit situation"], ["#/documents", "Documents"], [`#/document/${doc}`, "audit-note"],
    ["#/tasks", "Tasks"], [`#/task/${task}`, "Audit task"], ["#/map", "Your household knowledge map"], ["#/activity", "Activity"], ["#/assistant", "Assistant"], [`#/assistant/${sit}`, "Assistant"],
  ];
  for (const [hash, h1] of routes) {
    await page.goto(`/${hash}`); // a fresh load of every deep link
    await expect(page.getByRole("heading", { level: 1, name: h1 }).first(), hash).toBeVisible();
    const unnamed = await page.evaluate(() => [...document.querySelectorAll("main button, nav button")].filter((b) => (b as HTMLElement).offsetParent !== null && !(b.getAttribute("aria-label") || b.textContent?.trim() || b.getAttribute("title"))).length);
    expect(unnamed, `buttons without a name on ${hash}`).toBe(0);
  }
  for (const [hash, msg] of [[`#/task/nope`, "That task no longer exists."], [`#/document/nope`, "That document no longer exists."], [`#/situation/nope`, "That situation no longer exists"]] as const) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole("alert").first(), hash).toContainText(msg);
  }
  await page.goto("/#/no-such-page");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  // back / forward through real navigation
  await page.goto(`/#/task/${task}`);
  await page.getByRole("button", { name: `Open “Audit situation”` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit situation" })).toBeVisible();
  await page.getByRole("region", { name: "Tasks" }).getByRole("button", { name: "Open task: Audit task" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit task" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Audit situation" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Audit task" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Audit task" })).toBeVisible();
  // every primary navigation item lands on its workspace
  for (const [name, h1] of [["Situations", "Situations"], ["Documents", "Documents"], ["Tasks", "Tasks"], ["Map", "Your household knowledge map"], ["Activity", "Activity"], ["Assistant", "Assistant"]] as const) {
    await goTo(page, name);
    await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
  }
  // every record the map links to opens the matching record (by id, not title)
  const map = await json(await request.get("/api/map"));
  for (const n of map.nodes.slice(0, 12)) {
    await page.goto(`/${n.route}`);
    await expect(page.getByRole("heading", { level: 1, name: n.title }).first(), n.route).toBeVisible();
  }
  // search results lead to the same records
  const hits = (await json(await request.get("/api/search?q=audit"))).results;
  expect(hits.map((h: any) => h.id).sort()).toEqual([sit, task, doc].sort());
});

test("Phone, tablet and reduced motion", async ({ page, request }) => {
  watch(page);
  const first = (await json(await request.get("/api/tasks?filter=open"))).tasks[0];
  const task = first.id; const taskTitle = first.title as string;
  for (const [w, h, tag] of [[390, 844, "mobile"], [820, 1180, "tablet"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [hash, n, h1] of [["#/", "home", /./], ["#/tasks", "tasks", "Tasks"], [`#/task/${task}`, "task", taskTitle], ["#/map", "map", "Your household knowledge map"]] as const) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole("heading", { level: 1, name: h1 }).first()).toBeVisible(); // this route, not the previous one mid-transition
      await page.waitForTimeout(250);
      if (n === "map") await expect(page.getByRole("group", { name: /^Knowledge map with/ })).toBeVisible();
      expect(await overflowing(page), `${tag} ${hash}`).toEqual([]);
      if (tag === "mobile" && (n === "tasks" || n === "map")) await shot(page, `14-${tag}-${n}`);
    }
  }
  await page.goto("/#/tasks");
  await goTo(page, "Map"); // through the More sheet on a phone
  await expect(page.getByRole("heading", { level: 1, name: "Your household knowledge map" })).toBeVisible();
  // reduced motion: content is shown at once and route changes skip the transition
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/#/task/${task}`);
  const panel = page.getByRole("region", { name: "Task activity" });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await goTo(page, "Tasks");
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
});

test("Honest empty and error states", async ({ page }) => {
  watch(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route("**/api/map**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ nodes: [], edges: [], truncated: false, generated_at: new Date().toISOString() }) }));
  await page.goto("/#/map");
  await expect(page.getByRole("heading", { name: "Nothing to map yet" })).toBeVisible();
  await page.unroute("**/api/map**");
  await page.route("**/api/tasks?**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "MCP_UNAVAILABLE", message: "The HomeRelay tool server is unavailable. Nothing was changed." } }) }));
  await page.goto("/#/tasks");
  await expect(page.getByRole("alert").filter({ hasText: "tool server is unavailable" })).toBeVisible();
  await shot(page, "16-error-state");
  await page.unroute("**/api/tasks?**");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("region", { name: "Task list" })).toBeVisible();
});
