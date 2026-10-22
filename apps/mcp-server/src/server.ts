import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@homerelay/shared";
import { openDb, type Db } from "./db";
import { DomainError, HomeRelayService } from "./domain";
import { DEFAULT_MAX_BYTES, DocumentService } from "./documents";
import { GraphService } from "./graph";
import { registerContext, registerTools, tokenOk, type ToolConfig } from "./tools";

export interface McpAppOptions extends ToolConfig {
  dbPath: string;
  tz?: string;
  now?: () => Date;
  /** Where uploaded files are stored (opaque names). Defaults to a "documents" folder next to the database. */
  documentsDir?: string;
  maxDocumentBytes?: number;
}

const DOC_STATUS: Record<string, number> = { DUPLICATE: 409, TOO_LARGE: 413, UNSUPPORTED_TYPE: 415, INVALID_FILE: 400, INVALID_INPUT: 400, NOT_FOUND: 404 };
const header = (req: express.Request, name: string) => { const v = req.headers[name]; return typeof v === "string" ? v : ""; };
const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return ""; } };

export function createMcpApp(opts: McpAppOptions) {
  const db: Db = openDb(opts.dbPath);
  const svc = new HomeRelayService(db, { tz: opts.tz, now: opts.now });
  const documentsDir = opts.documentsDir
    ?? (opts.dbPath === ":memory:" ? path.join(os.tmpdir(), `homerelay-docs-${randomUUID()}`) : path.join(path.dirname(path.resolve(opts.dbPath)), "documents"));
  const docs = new DocumentService(db, { dir: documentsDir, maxBytes: opts.maxDocumentBytes ?? DEFAULT_MAX_BYTES, now: opts.now });
  const graph = new GraphService(db, svc, docs);
  const app = express();
  app.disable("x-powered-by");

  // DNS-rebinding guard: only loopback Host headers are accepted.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host" }, id: null });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let oh = "";
      try { oh = new URL(origin).hostname; } catch { /* invalid origin header */ }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(oh)) {
        res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" }, id: null });
        return;
      }
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "homerelay-mcp", transport: "streamable-http" }));

  // ---------- binary document transfer (not MCP) ----------
  // File bytes do not travel through MCP tool arguments. The application API forwards uploads here; only holders of the
  // service secret may call these routes. MCP tools then work on the stored records (metadata, text, links).
  const service = (req: express.Request, res: express.Response) => {
    if (tokenOk(header(req, "x-homerelay-service"), opts.approvalSecret)) return true;
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Service credentials required." } });
    return false;
  };
  app.post("/internal/documents", express.raw({ type: () => true, limit: (opts.maxDocumentBytes ?? DEFAULT_MAX_BYTES) + 1 }), async (req, res) => {
    if (!service(req, res)) return;
    try {
      const category = header(req, "x-category");
      if (category && !(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) throw new DomainError("INVALID_INPUT", `Unknown category "${category}"`);
      const tags = decode(header(req, "x-tags")).split(",").map((t) => t.trim()).filter(Boolean);
      const document = await docs.ingest({
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        filename: decode(header(req, "x-filename")), declaredMime: header(req, "x-declared-type"),
        category: (category || undefined) as DocumentCategory | undefined, title: decode(header(req, "x-title")) || undefined,
        tags, situation_id: header(req, "x-situation-id") || null,
      }, "user");
      res.status(201).json({ document });
    } catch (e) {
      if (e instanceof DomainError) { res.status(DOC_STATUS[e.code] ?? 400).json({ error: { code: e.code, message: e.message, ...(e.details ?? {}) } }); return; }
      console.error("[mcp] upload failed:", (e as Error)?.message);
      res.status(500).json({ error: { code: "INTERNAL", message: "The file could not be stored. Nothing was saved." } });
    }
  });
  app.get("/internal/documents/:id/content", (req, res) => {
    if (!service(req, res)) return;
    try {
      const f = docs.content(req.params.id);
      res.setHeader("Content-Type", f.mime);
      res.setHeader("Content-Length", String(f.size));
      fs.createReadStream(f.file).on("error", () => res.destroy()).pipe(res);
    } catch (e) {
      if (e instanceof DomainError) { res.status(DOC_STATUS[e.code] ?? 400).json({ error: { code: e.code, message: e.message } }); return; }
      res.status(500).json({ error: { code: "INTERNAL", message: "Could not read the file." } });
    }
  });
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large") { res.status(413).json({ error: { code: "TOO_LARGE", message: "The file is larger than the size limit." } }); return; }
    next(err);
  });

  // ---------- MCP: stateless Streamable HTTP; a fresh server + transport per request, state lives in SQLite ----------
  app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
    const server = new McpServer({ name: "homerelay", version: "0.3.0" });
    registerTools(server, svc, opts, docs, graph);
    registerContext(server, svc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp] transport error:", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST /mcp (stateless Streamable HTTP)." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return { app, svc, docs, graph, db };
}

export async function startMcpServer(opts: McpAppOptions & { port: number; host?: string }) {
  const { app, svc, docs, graph, db } = createMcpApp(opts);
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port, svc, docs, graph, db, url: `http://127.0.0.1:${port}/mcp`, base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { httpServer.close(() => { db.close(); r(); }); }),
  };
}
