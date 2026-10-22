import { expect, test, type Page } from "@playwright/test";
import { makePdf, PNG_1PX } from "../fixtures/pdf";
import { MEETING, ask, closeAllOpen, closeAssistant, goTo, resetDemo } from "./helpers";

// v3 workspaces against the real stack. Screenshots land outside test-results/ (which Playwright wipes) and are git-ignored.
const v3 = (n: string) => `artifacts/homerelay-v3/${n}.png`;
const WARRANTY = makePdf(["Washer warranty card. Model WM-4471, serial 88213. Valid until March 2028.", "Service centre: call 1800-555-0101 and quote the serial number."]);
const RECEIPT = Buffer.from("Courier receipt\nParcel 7731 delivered to the building reception.\nCollected by: pending\n");
const files = (...f: { name: string; mimeType: string; buffer: Buffer }[]) => f;
const sideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test.beforeAll(async ({ request }) => { await resetDemo(request); await closeAllOpen(request); });

test("workspaces, document vault, situation links and document-aware assistant", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Simulate delivery event" }).first().click();
  const situationTitle = "Package arriving while you are at work";
  await expect(page.getByRole("heading", { name: situationTitle })).toBeVisible();

  // ---- every workspace is a real route with its own heading and active nav item
  for (const [nav, heading] of [["Situations", "Situations"], ["Documents", "Documents"], ["Tasks", "Tasks"], ["Activity", "Activity"], ["Assistant", "Assistant"]] as const) {
    await goTo(page, nav);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: nav, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.reload(); // the route survives a reload
  await expect(page.getByRole("heading", { level: 1, name: "Assistant" })).toBeVisible();
  await goTo(page, "Home");
  await expect(page.locator(".stat", { hasText: "Open situations" })).toContainText("1");
  await page.screenshot({ animations: "disabled", path: v3("01-home") });
  await goTo(page, "Situations");
  await page.screenshot({ animations: "disabled", path: v3("02-situations") });

  // ---- upload: several files at once, with the server deliberately slowed so the real in-flight state is visible
  await goTo(page, "Documents");
  await expect(page.getByText(/No documents yet/)).toBeVisible();
  await page.route("**/api/documents", async (r) => { if (r.request().method() === "POST") await new Promise((ok) => setTimeout(ok, 1200)); await r.fallback(); });
  await page.getByLabel("Choose files to upload").setInputFiles(files(
    { name: "Washer warranty.pdf", mimeType: "application/pdf", buffer: WARRANTY },
    { name: "Courier receipt.txt", mimeType: "text/plain", buffer: RECEIPT },
    { name: "Package photo.png", mimeType: "image/png", buffer: PNG_1PX },
  ));
  const uploads = page.getByRole("list", { name: "Uploads" });
  await expect(uploads.getByRole("progressbar").first()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("05-upload-in-progress") });
  await expect(uploads.getByText("Saved")).toHaveCount(3, { timeout: 15_000 });
  await page.unroute("**/api/documents");
  const library = page.getByRole("list", { name: "Document library" });
  await expect(library.getByRole("listitem")).toHaveCount(3);
  await page.screenshot({ animations: "disabled", path: v3("04-document-library") });

  // duplicates and unsupported files are refused with a clear reason, and nothing extra is stored
  await page.getByLabel("Choose files to upload").setInputFiles(files(
    { name: "Washer warranty copy.pdf", mimeType: "application/pdf", buffer: WARRANTY },
    { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ not a document") },
  ));
  await expect(uploads.getByRole("alert").filter({ hasText: /already stored/ })).toBeVisible();
  await expect(uploads.getByRole("alert")).toHaveCount(2);
  await expect(library.getByRole("listitem")).toHaveCount(3);
  await page.screenshot({ animations: "disabled", path: v3("15-upload-errors") });

  // ---- search reaches extracted PDF text on page 2, with the match highlighted
  await page.locator("#doc-q").fill("serial number service");
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await expect(library.locator("mark").first()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("07-search-results") });
  await page.locator("#doc-q").fill("");

  // ---- preview and extracted text
  await library.getByRole("button", { name: /Open document: Washer warranty/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Washer warranty/ })).toBeVisible();
  await expect(page.locator("iframe.doc-pdf")).toBeVisible();
  await expect(page.getByRole("region", { name: "Extracted text" })).toContainText("88213");
  await page.screenshot({ animations: "disabled", path: v3("06-document-preview") });

  // asking about the open document uses only the stored text
  let dlg = await ask(page, "What does this document say?");
  await expect(dlg.getByText(/88213/).first()).toBeVisible();
  await closeAssistant(page);

  // ---- attach from the situation page
  await goTo(page, "Situations");
  await page.getByRole("button", { name: `Open situation: ${situationTitle}` }).first().click();
  const sitDocs = page.getByRole("region", { name: "Situation documents" });
  await sitDocs.getByRole("button", { name: "Attach existing" }).click();
  await sitDocs.getByPlaceholder("Find a document…").fill("warranty");
  await sitDocs.getByRole("button", { name: "Attach", exact: true }).first().click();
  await expect(sitDocs.getByRole("button", { name: /Open document: Washer warranty/ })).toBeVisible();
  await expect(page.getByText("Document attached: Washer warranty").first()).toBeVisible(); // recorded in the timeline
  await sitDocs.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: v3("08-linked-document") });

  // ---- the assistant attaches by name and lists the links from stored data
  dlg = await ask(page, "Attach the courier receipt");
  await expect(dlg.getByText(/Attached/).first()).toBeVisible();
  await expect(sitDocs.getByRole("button", { name: /Open document: Courier receipt/ })).toBeVisible();
  await ask(page, "Which documents are attached to this situation?");
  await expect(dlg.getByRole("button", { name: /Open document: Washer warranty/ }).last()).toBeVisible();
  await expect(dlg.getByLabel("What I did").last()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("12-assistant-searching-documents") });

  // ---- plan -> approval still requires the user
  await ask(page, MEETING);
  const proposal = dlg.getByRole("region", { name: "Proposed plan" });
  await expect(proposal).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("11-proposal") });
  await dlg.getByRole("button", { name: /Approve plan/ }).click();
  await expect(page.getByText("3 open")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("13-approval-feedback") });
  await closeAssistant(page);
  await page.screenshot({ animations: "disabled", path: v3("03-situation-detail") });
  await page.locator(".timeline").first().scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: v3("14-timeline") });

  // ---- tasks workspace reflects the approved plan
  await goTo(page, "Tasks");
  await expect(page.getByText("Check delivery status and collect the package").first()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("09-tasks") });

  // ---- assistant workspace: search documents from Home context
  await goTo(page, "Assistant");
  const chat = page.getByRole("region", { name: "Assistant conversation" });
  await chat.getByLabel("Message HomeRelay").fill("Find my receipts");
  await chat.getByLabel("Message HomeRelay").press("Enter");
  await expect(chat.getByRole("button", { name: /Open document: Courier receipt/ }).last()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: v3("10-assistant-workspace") });

  // ---- deletion needs an explicit confirmation and removes the links too
  await goTo(page, "Documents");
  await library.getByRole("button", { name: /Open document: Courier receipt/ }).click();
  await page.getByRole("button", { name: /Delete document/ }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await expect(library.getByRole("listitem")).toHaveCount(2);
});

test("phone layouts: bottom navigation, documents and assistant fit the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  expect(await sideScroll(page)).toBe(false);
  await page.screenshot({ animations: "disabled", path: v3("16-mobile-home") });
  await goTo(page, "Documents");
  await expect(page.getByRole("list", { name: "Document library" }).getByRole("listitem")).toHaveCount(2);
  expect(await sideScroll(page)).toBe(false);
  await page.screenshot({ animations: "disabled", path: v3("17-mobile-documents") });
  await page.getByRole("button", { name: /Open document: Washer warranty/ }).click();
  await expect(page.getByRole("region", { name: "Extracted text" })).toBeVisible();
  expect(await sideScroll(page)).toBe(false);
  await page.screenshot({ animations: "disabled", path: v3("18-mobile-document") });
  await goTo(page, "Assistant");
  await expect(page.getByRole("region", { name: "Assistant conversation" }).getByLabel("Message HomeRelay")).toBeVisible();
  expect(await sideScroll(page)).toBe(false);
  await page.screenshot({ animations: "disabled", path: v3("19-mobile-assistant") });
  await goTo(page, "Tasks");
  expect(await sideScroll(page)).toBe(false);
  await page.screenshot({ animations: "disabled", path: v3("20-mobile-tasks") });
});
