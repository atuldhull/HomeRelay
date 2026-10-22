import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const MEETING = "I'm working until 6 PM and nobody else is home. Help me manage it.";
export const shot = (n: string) => `test-results/${n}.png`;

const HEADERS = { "content-type": "application/json", "x-homerelay-client": "web" };

export const assistant = (page: Page): Locator => page.getByRole("dialog", { name: "Ask HomeRelay" });

/** Opens the assistant the way a user would: from the situation or document page if there is one, otherwise from the rail. */
export async function openAssistant(page: Page): Promise<Locator> {
  const dlg = assistant(page);
  if (await dlg.isVisible()) return dlg;
  // the page-level button when there is one (always on phones, where the rail has no Ask button), otherwise the rail
  const contextual = page.getByRole("button", { name: /^Ask about this (situation|document)$/ });
  const rail = page.getByRole("button", { name: "Ask HomeRelay", exact: true });
  await contextual.or(rail).first().waitFor();
  if (await contextual.isVisible()) await contextual.click();
  else await rail.first().click();
  await expect(dlg).toBeVisible();
  return dlg;
}

export async function ask(page: Page, text: string): Promise<Locator> {
  const dlg = await openAssistant(page);
  const input = dlg.getByLabel("Message HomeRelay");
  await input.fill(text);
  await input.press("Enter");
  return dlg;
}

export async function closeAssistant(page: Page) {
  const dlg = assistant(page);
  if (await dlg.isVisible()) { await page.keyboard.press("Escape"); await expect(dlg).toBeHidden(); }
}

/** Vite is up before the API/MCP processes are; wait until the tool server is reachable through the API. */
export async function waitForStack(request: APIRequestContext) {
  await expect.poll(async () => { try { return (await (await request.get("/api/health")).json()).mcp; } catch { return "down"; } }, { timeout: 45_000, intervals: [250, 500, 1000] }).toBe("up");
}

/** Removes only demo data (never user data), through the real endpoint. */
export async function resetDemo(request: APIRequestContext) {
  await waitForStack(request);
  const r = await request.post("/api/demo/reset", { headers: { ...HEADERS, "x-homerelay-confirm": "reset-demo" }, data: {} });
  expect(r.ok()).toBe(true);
}

export const apiPost = (request: APIRequestContext, path: string, data: unknown = {}) => request.post(`/api${path}`, { headers: HEADERS, data });

/** Resolves every open user situation (through the real endpoint) so a spec starts from "nothing open". */
export async function closeAllOpen(request: APIRequestContext) {
  const r = await request.get("/api/situations?status=open,in_progress,blocked");
  for (const s of (await r.json()).situations) await apiPost(request, `/situations/${s.id}/resolve`, { confirmed: true, closeOutstanding: true });
}

/** Moves between workspaces through the primary navigation (left rail on desktop; bottom bar, then More, on phones). */
export async function goTo(page: Page, name: "Home" | "Situations" | "Documents" | "Tasks" | "Map" | "Activity" | "Assistant") {
  const direct = page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
  if (await direct.isVisible()) { await direct.click(); return; }
  // phones: destinations outside the bottom bar live in the More sheet
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name, exact: true }).click();
}

/** Local wall-clock "YYYY-MM-DDTHH:mm" in the app time zone, offset from now (the format the API's *Local fields take). */
export function localIn(hours: number, tz = "Asia/Kolkata"): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(Date.now() + hours * 3600_000));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Elements that make the page wider than the viewport (empty when there is no horizontal scroll). */
export const overflowing = (page: Page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth; const out: string[] = [];
  if (document.documentElement.scrollWidth <= vw + 1) return out;
  const wide = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; };
  // innermost offenders: overflowing elements none of whose children overflow
  for (const el of document.querySelectorAll("body *")) if (wide(el) && ![...el.children].some(wide)) out.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 40)} \"${(el.textContent ?? "").trim().slice(0, 30)}\"`);
  return out.slice(0, 6);
});
