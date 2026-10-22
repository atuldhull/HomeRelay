import { Readable } from "node:stream";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { DOCUMENT_CATEGORIES, type DocumentHit, type DocumentSummary, type DocumentText } from "@homerelay/shared";
import type { ApiConfig } from "./config";
import type { McpGateway } from "./gateway";

/**
 * Document vault routes. Binary upload/download go API → MCP server internal endpoints (service secret); everything
 * else (search, metadata, links, deletion) goes through MCP tools like every other domain operation.
 */

export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;
const id = z.string().min(1).max(100);
const metaBody = z.object({
  title: z.string().trim().min(1).max(200).optional(), category: z.enum(DOCUMENT_CATEGORIES).optional(),
  tags: z.array(z.string().trim().max(40)).max(12).optional(), description: z.string().max(2000).optional(), notes: z.string().max(4000).optional(),
});
const linkBody = z.object({ situationId: id });

class RouteError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new RouteError(400, "INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};

export function documentRoutes(gw: McpGateway, cfg: ApiConfig, uploadLimit = DEFAULT_UPLOAD_LIMIT): Router {
  const r = express.Router();
  const via = { via: "api" as const };
  const base = cfg.mcpUrl.replace(/\/mcp$/, "");
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

  r.get("/documents", wrap(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const category = typeof req.query.category === "string" && req.query.category ? parse(z.enum(DOCUMENT_CATEGORIES), req.query.category) : undefined;
    const situation_id = typeof req.query.situationId === "string" && req.query.situationId ? req.query.situationId : undefined;
    const sort = typeof req.query.sort === "string" ? parse(z.enum(["recent", "name", "size"]), req.query.sort) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);
    if (q.trim()) {
      const out = await gw.call<{ results: DocumentHit[] }>("search_documents", { query: q, category, situation_id, limit: Math.min(limit, 100) }, via);
      res.json({ query: q, results: out.results });
    } else {
      const out = await gw.call<{ documents: DocumentSummary[] }>("list_documents", { category, situation_id, sort, limit }, via);
      res.json({ query: "", results: out.documents.map((d) => ({ document: d, snippet: null, page: null, matched: [] })) });
    }
  }));

  // Upload: raw bytes (one file per request; the browser sends several requests for several files so progress is real).
  r.post("/documents", express.raw({ type: "application/octet-stream", limit: uploadLimit + 1 }), wrap(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const filename = req.get("X-Filename") ?? "";
    if (!filename) throw new RouteError(400, "INVALID_REQUEST", "X-Filename header is required.");
    const q = req.query;
    const category = typeof q.category === "string" && q.category ? parse(z.enum(DOCUMENT_CATEGORIES), q.category) : "";
    const situationId = typeof q.situationId === "string" ? parse(id.optional(), q.situationId || undefined) : undefined;
    const upstream = await fetch(`${base}/internal/documents`, {
      method: "POST", body,
      headers: {
        "content-type": "application/octet-stream", "x-homerelay-service": cfg.approvalSecret,
        "x-filename": filename, "x-declared-type": (req.get("X-Declared-Type") ?? "").slice(0, 100), "x-category": category,
        "x-title": typeof q.title === "string" ? encodeURIComponent(q.title.slice(0, 200)) : "",
        "x-tags": typeof q.tags === "string" ? encodeURIComponent(q.tags.slice(0, 500)) : "",
        ...(situationId ? { "x-situation-id": situationId } : {}),
      },
    }).catch(() => { throw new RouteError(503, "MCP_UNAVAILABLE", "The tool server is unavailable. Nothing was saved."); });
    const json = await upstream.json().catch(() => ({ error: { code: "INTERNAL", message: "Unexpected response from the tool server." } }));
    res.status(upstream.status).json(json);
  }));

  r.get("/documents/:id", wrap(async (req, res) => { res.json(await gw.call("get_document", { document_id: req.params.id }, via)); }));
  r.get("/documents/:id/text", wrap(async (req, res) => {
    const page = req.query.page ? Number(req.query.page) : undefined;
    res.json(await gw.call<DocumentText>("get_document_text", { document_id: req.params.id, page: Number.isInteger(page) && page! > 0 ? page : undefined, max_chars: 60_000 }, via));
  }));

  /** Streams stored bytes with headers that stop the browser from treating user content as active content. */
  r.get("/documents/:id/content", wrap(async (req, res) => {
    const { document } = await gw.call<{ document: DocumentSummary }>("get_document", { document_id: req.params.id }, via);
    const upstream = await fetch(`${base}/internal/documents/${encodeURIComponent(document.id)}/content`, { headers: { "x-homerelay-service": cfg.approvalSecret } })
      .catch(() => { throw new RouteError(503, "MCP_UNAVAILABLE", "The tool server is unavailable."); });
    if (!upstream.ok || !upstream.body) throw new RouteError(upstream.status === 404 ? 404 : 502, "NOT_FOUND", "The stored file could not be read.");
    const attach = req.query.download === "1";
    res.setHeader("Content-Type", document.mime_type);
    res.setHeader("Content-Length", String(document.size_bytes));
    res.setHeader("Content-Disposition", `${attach ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(document.original_filename)}`);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // PDFs need the browser's viewer; everything else is shown with all active content disabled.
    if (document.kind !== "pdf") res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    Readable.fromWeb(upstream.body as any).pipe(res);
  }));

  r.post("/documents/:id/metadata", wrap(async (req, res) => {
    const b = parse(metaBody, req.body);
    res.json(await gw.call("update_document_metadata", { document_id: req.params.id, ...b, actor: "user" }, via));
  }));
  r.post("/documents/:id/link", wrap(async (req, res) => {
    const b = parse(linkBody, req.body);
    res.json(await gw.call("link_document_to_situation", { document_id: req.params.id, situation_id: b.situationId, actor: "user" }, via));
  }));
  r.post("/documents/:id/unlink", wrap(async (req, res) => {
    const b = parse(linkBody, req.body);
    res.json(await gw.call("unlink_document_from_situation", { document_id: req.params.id, situation_id: b.situationId, actor: "user" }, via));
  }));
  // Destructive user action: needs an explicit confirmation header; the token lives only here.
  r.post("/documents/:id/delete", wrap(async (req, res) => {
    if (req.get("X-HomeRelay-Confirm") !== "delete-document") throw new RouteError(400, "CONFIRMATION_REQUIRED", "Missing delete confirmation header.");
    res.json(await gw.call("delete_document", { document_id: req.params.id, approval_token: cfg.approvalSecret }, via));
  }));
  r.get("/situations/:id/documents", wrap(async (req, res) => { res.json(await gw.call("list_documents", { situation_id: req.params.id }, via)); }));


  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof RouteError) { res.status(err.status).json({ error: { code: err.code, message: err.message } }); return; }
    if ((err as any)?.type === "entity.too.large") { res.status(413).json({ error: { code: "TOO_LARGE", message: "The file is larger than the size limit." } }); return; }
    next(err);
  });
  return r;
}
