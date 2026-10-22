import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../apps/mcp-server/src/db";
import { DomainError, HomeRelayService } from "../apps/mcp-server/src/domain";
import { DocumentService, detectFile, guessCategory, queryTokens, sanitizeFilename } from "../apps/mcp-server/src/documents";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { JPEG_1PX, PNG_1PX, makePdf } from "./fixtures/pdf";

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const txt = (s: string) => Buffer.from(s, "utf8");
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return e instanceof DomainError ? e.code : `non-domain:${String(e)}`; }
  return "no-error";
};

describe("file validation (signature, not the browser's word)", () => {
  it("accepts the supported types by content", () => {
    expect(detectFile(makePdf(["x"]), "a.pdf", "application/pdf")).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(detectFile(PNG_1PX, "a.png", "image/png")).toEqual({ kind: "image", mime: "image/png" });
    expect(detectFile(JPEG_1PX, "a.JPG", "")).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(detectFile(txt("# notes"), "n.md", "application/octet-stream")).toEqual({ kind: "text", mime: "text/markdown" });
    expect(detectFile(txt("hello"), "n.txt", "text/plain")).toEqual({ kind: "text", mime: "text/plain" });
  });
  it("rejects disguised, active or unsupported content", () => {
    const c = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as DomainError).code; } return "ok"; };
    expect(c(() => detectFile(txt("not a pdf"), "fake.pdf"))).toBe("INVALID_FILE");
    expect(c(() => detectFile(PNG_1PX, "photo.jpg"))).toBe("INVALID_FILE");
    expect(c(() => detectFile(txt("<script>alert(1)</script>"), "page.html", "text/html"))).toBe("UNSUPPORTED_TYPE");
    expect(c(() => detectFile(txt("hello"), "x.txt", "text/html"))).toBe("UNSUPPORTED_TYPE");
    expect(c(() => detectFile(Buffer.from([0x4d, 0x5a, 0, 1]), "tool.exe"))).toBe("UNSUPPORTED_TYPE");
    expect(c(() => detectFile(Buffer.from([0x68, 0, 0x69]), "binary.txt"))).toBe("INVALID_FILE");
    expect(c(() => detectFile(Buffer.from([0xc3, 0x28]), "bad-utf8.txt"))).toBe("INVALID_FILE");
  });
  it("sanitizes names: strips paths and control characters, bounds length", () => {
    expect(sanitizeFilename("C:\\Users\\me\\..\\secret\\receipt.pdf")).toBe("receipt.pdf");
    expect(sanitizeFilename("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFilename("we\u0000ird\u0007 <name>.md")).toBe("weird name.md");
    expect(sanitizeFilename("a".repeat(300) + ".pdf")).toHaveLength(180);
    expect(() => sanitizeFilename("../")).toThrow();
  });
  it("tokenizes queries without FTS syntax leaking through", () => {
    expect(queryTokens('find the "warranty" for my washing-machine* OR NEAR(')).toEqual(["warranty", "washing", "machine", "near"]);
  });
});

describe("document service", () => {
  let db: Db; let dir: string; let docs: DocumentService; let svc: HomeRelayService;
  beforeEach(() => { db = openDb(":memory:"); dir = tmpDir("hr-docs-"); docs = new DocumentService(db, { dir, maxBytes: 64 * 1024 }); svc = new HomeRelayService(db); });

  it("stores a PDF under an opaque name, extracts every page, indexes it, and records the event", async () => {
    const d = await docs.ingest({ bytes: makePdf(["Washing machine warranty", "Model WM-4420 covered until 2028-03-31"]), filename: "washer-warranty.pdf", category: "warranty", tags: ["Washing Machine"] });
    expect(d).toMatchObject({ kind: "pdf", mime_type: "application/pdf", category: "warranty", extraction_status: "completed", page_count: 2, tags: ["washing-machine"], title: "washer-warranty" });
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}$/); // opaque: neither the user's name nor extension
    expect(fs.readFileSync(path.join(dir, files[0])).subarray(0, 5).toString()).toBe("%PDF-");
    expect((d as any).storage_key).toBeUndefined(); // never exposed
    expect(docs.getText(d.id).pages.map((p) => p.page)).toEqual([1, 2]);
    expect(db.prepare("SELECT event_type FROM activity_events").all()).toEqual([{ event_type: "document_added" }]);
  });

  it("is honest about what could not be extracted", async () => {
    const img = await docs.ingest({ bytes: PNG_1PX, filename: "label.png" });
    expect(img).toMatchObject({ kind: "image", category: "photo", extraction_status: "unsupported" });
    expect(img.extraction_note).toMatch(/no OCR/);
    expect(docs.getText(img.id)).toMatchObject({ status: "unsupported", pages: [] });
    const broken = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("garbage that is not a pdf body")]);
    const bad = await docs.ingest({ bytes: broken, filename: "damaged.pdf" });
    expect(bad.extraction_status).toBe("failed");
    expect(bad.extraction_note).toMatch(/could not be read/);
    expect(docs.search("garbage")).toEqual([]); // failed extraction is never indexed as text
  });

  it("rejects empty, oversized and duplicate files without writing anything", async () => {
    expect(await code(docs.ingest({ bytes: Buffer.alloc(0), filename: "e.txt" }))).toBe("INVALID_FILE");
    expect(await code(docs.ingest({ bytes: Buffer.alloc(70 * 1024, 65), filename: "big.txt" }))).toBe("TOO_LARGE");
    const first = await docs.ingest({ bytes: txt("Boiler service notes"), filename: "boiler.txt" });
    try { await docs.ingest({ bytes: txt("Boiler service notes"), filename: "copy.txt" }); expect.unreachable(); }
    catch (e) { expect((e as DomainError).code).toBe("DUPLICATE"); expect((e as DomainError).details).toEqual({ document_id: first.id }); }
    expect(await code(docs.ingest({ bytes: txt("x"), filename: "x.txt", situation_id: "missing" }))).toBe("NOT_FOUND");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) c FROM documents").get()).toEqual({ c: 1 });
  });

  it("searches metadata and extracted text, ranks by coverage, cites PDF pages, filters, and never invents", async () => {
    const w = await docs.ingest({ bytes: makePdf(["Washing machine warranty", "Model WM-4420 covered until 2028-03-31"]), filename: "w.pdf", title: "Washer warranty", category: "warranty" });
    await docs.ingest({ bytes: txt("Receipt: dishwasher, paid 450"), filename: "dish.txt", category: "receipt" });
    await docs.ingest({ bytes: PNG_1PX, filename: "machine-label.png", description: "Model label on the washing machine" });

    const hits = docs.search("washing machine warranty");
    expect(hits[0].document.id).toBe(w.id);
    const byModel = docs.search("WM-4420");
    expect(byModel.map((h) => h.document.id)).toEqual([w.id]);
    expect(byModel[0]).toMatchObject({ page: 2, matched: ["text"] });
    expect(byModel[0].snippet).toContain("«");
    const img = docs.search("model label");
    expect(img[0].document.kind).toBe("image");
    expect(img[0].matched).toEqual(["metadata"]); // found by description, not by imaginary OCR
    expect(docs.search("warranty", { category: "receipt" })).toEqual([]);
    expect(docs.search("refrigerator")).toEqual([]);
    expect(docs.search('" OR *')).toHaveLength(3); // FTS syntax is neutralised; empty query lists documents
  });

  it("links and unlinks idempotently, records events on the situation, and searches by linked situation", async () => {
    const s = svc.createSituation({ title: "Washer repair", category: "maintenance" }, "user");
    const d = await docs.ingest({ bytes: txt("Purchase receipt"), filename: "r.txt", category: "receipt" });
    expect(docs.link(d.id, s.id).already_linked).toBe(false);
    expect(docs.link(d.id, s.id).already_linked).toBe(true);
    expect(docs.situationDocuments(s.id).map((x) => x.id)).toEqual([d.id]);
    expect(docs.get(d.id).linked_situations).toEqual([{ id: s.id, title: "Washer repair", status: "open", category: "maintenance" }]);
    expect(docs.search("washer repair").map((h) => h.document.id)).toEqual([d.id]);
    expect(svc.getActivityLog(s.id).map((e) => e.event_type)).toContain("document_linked");
    docs.unlink(d.id, s.id);
    expect(await code(() => docs.unlink(d.id, s.id))).toBe("NOT_LINKED");
    expect(await code(() => docs.link("nope", s.id))).toBe("NOT_FOUND");
    expect(await code(() => docs.link(d.id, "nope"))).toBe("NOT_FOUND");
    expect(svc.getActivityLog(s.id).map((e) => e.event_type)).toContain("document_unlinked");
  });

  it("validates metadata edits and keeps the index in sync", async () => {
    const d = await docs.ingest({ bytes: txt("notes"), filename: "n.txt" });
    const u = docs.updateMetadata(d.id, { title: "Fridge manual", category: "manual", tags: ["kitchen", "Fridge"] });
    expect(u).toMatchObject({ title: "Fridge manual", category: "manual", tags: ["kitchen", "fridge"] });
    expect(docs.search("fridge").map((h) => h.document.id)).toEqual([d.id]);
    expect(await code(() => docs.updateMetadata(d.id, { title: "" }))).toBe("INVALID_INPUT");
    expect(await code(() => docs.updateMetadata(d.id, { category: "spaceship" as any }))).toBe("INVALID_INPUT");
    expect(await code(() => docs.updateMetadata(d.id, { tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }))).toBe("INVALID_INPUT");
  });

  it("deletes one document and its file, detaches it, and leaves situations and other files alone", async () => {
    const s = svc.createSituation({ title: "Keep me", category: "general" });
    const a = await docs.ingest({ bytes: txt("delete me"), filename: "a.txt", situation_id: s.id });
    const b = await docs.ingest({ bytes: txt("keep me"), filename: "b.txt" });
    const r = docs.delete(a.id);
    expect(r).toMatchObject({ deleted: a.id, detached_from: [s.id] });
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(docs.get(b.id).title).toBe("b");
    expect(svc.getSituation(s.id).situation.title).toBe("Keep me");
    expect(docs.search("delete")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM document_links").get()).toEqual({ c: 0 });
    expect(await code(() => docs.get(a.id))).toBe("NOT_FOUND");
  });

  it("only ever serves files it stored itself", async () => {
    const d = await docs.ingest({ bytes: txt("x"), filename: "x.txt" });
    expect(path.dirname(docs.content(d.id).file)).toBe(path.resolve(dir));
    db.prepare("UPDATE documents SET storage_key='../../etc/passwd' WHERE id=?").run(d.id); // even a tampered row cannot escape
    expect(await code(() => docs.content(d.id))).toBe("INTERNAL");
    expect(await code(() => docs.content("../../secret"))).toBe("NOT_FOUND");
  });

  it("persists across a restart (new connection and service on the same database and folder)", async () => {
    const dbDir = tmpDir("hr-persist-"); const file = path.join(dbDir, "h.db"); const store = path.join(dbDir, "docs");
    const db1 = openDb(file); const d1 = new DocumentService(db1, { dir: store });
    const s = new HomeRelayService(db1).createSituation({ title: "Delivery", category: "delivery" });
    const d = await d1.ingest({ bytes: makePdf(["Courier receipt 7781"]), filename: "courier.pdf", category: "delivery", situation_id: s.id });
    db1.close();
    const db2 = openDb(file); const d2 = new DocumentService(db2, { dir: store });
    expect(d2.get(d.id)).toMatchObject({ title: "courier", linked_situations: [{ id: s.id }] });
    expect(d2.search("7781")[0].document.id).toBe(d.id);
    expect(fs.existsSync(d2.content(d.id).file)).toBe(true);
    db2.close();
  });
});

describe("documents over real MCP and the internal binary endpoints", () => {
  const SECRET = "docs-test-secret-0123456789ab";
  let srv: Awaited<ReturnType<typeof startMcpServer>>; let client: Client; let tmp: string; let reader: Database.Database;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse((r.content as any[])[0].text) as any };
  };
  const upload = (bytes: Buffer, name: string, headers: Record<string, string> = {}) =>
    fetch(`${srv.base}/internal/documents`, { method: "POST", body: bytes, headers: { "x-homerelay-service": SECRET, "x-filename": encodeURIComponent(name), "content-type": "application/octet-stream", ...headers } });

  beforeAll(async () => {
    tmp = tmpDir("hr-mcp-docs-");
    srv = await startMcpServer({ port: 0, dbPath: path.join(tmp, "t.db"), approvalSecret: SECRET, allowDemoReset: true, maxDocumentBytes: 200 * 1024 });
    client = new Client({ name: "doc-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
    reader = new Database(path.join(tmp, "t.db"), { readonly: true });
  });
  afterAll(async () => { reader.close(); await client.close(); await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("internal endpoints require the service secret", async () => {
    expect((await fetch(`${srv.base}/internal/documents`, { method: "POST", body: txt("x"), headers: { "x-filename": "x.txt" } })).status).toBe(401);
    expect((await fetch(`${srv.base}/internal/documents/abc/content`)).status).toBe(401);
  });

  it("maps upload problems to precise statuses", async () => {
    expect((await upload(txt("<html>"), "a.html")).status).toBe(415);
    expect((await upload(txt("plain"), "fake.pdf")).status).toBe(400);
    expect((await upload(Buffer.alloc(300 * 1024, 65), "big.txt")).status).toBe(413);
    expect((await upload(txt("x"), "x.txt", { "x-category": "spaceship" })).status).toBe(400);
  });

  it("search → get → text → link → situation documents: ids from one tool work in the next", async () => {
    const up = await upload(makePdf(["Dishwasher manual", "Error E24 means the drain is blocked"]), "dw-manual.pdf", { "x-category": "manual", "x-declared-type": "application/pdf", "x-tags": encodeURIComponent("kitchen,dishwasher") });
    expect(up.status).toBe(201);
    const stored = (await up.json()).document;
    expect((await upload(makePdf(["Dishwasher manual", "Error E24 means the drain is blocked"]), "again.pdf")).status).toBe(409);

    const s = (await call("create_situation", { title: "Dishwasher not draining", category: "maintenance" })).data.situation;
    const found = await call("search_documents", { query: "E24 drain" });
    expect(found.isError).toBe(false);
    const hit = found.data.results[0];
    expect(hit).toMatchObject({ page: 2, document: { id: stored.id, category: "manual" } });
    const got = await call("get_document", { document_id: hit.document.id });
    expect(got.data.document.storage_key).toBeUndefined();
    expect(JSON.stringify(got.data)).not.toMatch(/[\\/]documents[\\/]/); // no server paths
    const text = await call("get_document_text", { document_id: got.data.document.id, page: 2 });
    expect(text.data).toMatchObject({ status: "completed", pages: [{ page: 2, text: expect.stringContaining("E24") }] });
    const linked = await call("link_document_to_situation", { document_id: stored.id, situation_id: s.id });
    expect(linked.data.already_linked).toBe(false);
    const sd = await call("list_documents", { situation_id: s.id });
    expect(sd.data.documents.map((d: any) => d.id)).toEqual([stored.id]);
    expect(reader.prepare("SELECT COUNT(*) c FROM document_links WHERE situation_id=?").get(s.id)).toEqual({ c: 1 });

    const bytes = await fetch(`${srv.base}/internal/documents/${stored.id}/content`, { headers: { "x-homerelay-service": SECRET } });
    expect(bytes.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await bytes.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("tool errors are structured; deletion needs the user-action token", async () => {
    expect((await call("get_document", { document_id: "missing" })).data.error.code).toBe("NOT_FOUND");
    expect((await call("get_document_text", { document_id: "missing" })).data.error.code).toBe("NOT_FOUND");
    const first = (await call("list_documents")).data.documents[0];
    expect((await call("delete_document", { document_id: first.id, approval_token: "wrong-wrong-wrong-wrong" })).data.error.code).toBe("UNAUTHORIZED");
    expect(reader.prepare("SELECT COUNT(*) c FROM documents").get()).toEqual({ c: 1 });
    const del = await call("delete_document", { document_id: first.id, approval_token: SECRET });
    expect(del.data.deleted).toBe(first.id);
    expect(reader.prepare("SELECT COUNT(*) c FROM documents").get()).toEqual({ c: 0 });
  });

  it("list_tasks returns tasks across situations with context", async () => {
    const s = (await call("create_situation", { title: "Errand", category: "general", initial_task_title: "Buy bulbs", initial_task_due_at: "2020-01-01T10:00:00.000Z" })).data.situation;
    const overdue = await call("list_tasks", { filter: "overdue" });
    expect(overdue.data.tasks.map((t: any) => [t.title, t.situation_title, t.overdue])).toEqual([["Buy bulbs", "Errand", true]]);
    expect((await call("list_tasks", { situation_id: s.id })).data.tasks).toHaveLength(1);
    expect((await call("list_tasks", { filter: "done" })).data.tasks).toHaveLength(0);
  });
});

describe("automatic category", () => {
  it("guesses from the file name only, and falls back honestly", () => {
    expect(guessCategory("Washer warranty.pdf", "pdf")).toBe("warranty");
    expect(guessCategory("amazon_invoice-2026.pdf", "pdf")).toBe("receipt");
    expect(guessCategory("Courier receipt.txt", "text")).toBe("receipt");
    expect(guessCategory("dishwasher-user-guide.pdf", "pdf")).toBe("manual");
    expect(guessCategory("AC service report.pdf", "pdf")).toBe("maintenance_record");
    expect(guessCategory("IMG_2041.jpg", "image")).toBe("photo");
    expect(guessCategory("scan.pdf", "pdf")).toBe("other");
    expect(guessCategory("billing.txt", "text")).toBe("other"); // whole words only for "bill"
  });
});

describe("concurrent uploads and storage quota", () => {
  it("two simultaneous uploads of the same file store it once; the other gets DUPLICATE, not an internal error", async () => {
    const db = openDb(":memory:"); const dir = tmpDir("hr-race-");
    const docs = new DocumentService(db, { dir, maxBytes: 64 * 1024 });
    const bytes = makePdf(["Same warranty card, uploaded twice at once"]);
    const results = await Promise.allSettled([docs.ingest({ bytes, filename: "a.pdf" }), docs.ingest({ bytes, filename: "b.pdf" })]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(DomainError);
    expect((failed[0].reason as DomainError).code).toBe("DUPLICATE");
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
    expect(fs.readdirSync(dir)).toHaveLength(1); // the losing upload's file was removed
  });

  it("refuses an upload that would exceed the total storage quota, and stores nothing", async () => {
    const db = openDb(":memory:"); const dir = tmpDir("hr-quota-");
    const docs = new DocumentService(db, { dir, maxBytes: 64 * 1024, maxTotalBytes: 100 });
    await docs.ingest({ bytes: Buffer.from("x".repeat(60)), filename: "first.txt" });
    const err = await docs.ingest({ bytes: Buffer.from("y".repeat(60)), filename: "second.txt" }).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("STORAGE_FULL");
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});
