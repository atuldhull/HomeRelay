import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDb, type Db } from "./db";
import { HomeRelayService } from "./domain";
import { DocumentService } from "./documents";
import { GraphService } from "./graph";
import { OAuthError, OAuthServer, SCOPES, type AuthRequest, type OAuthConfig } from "./oauth";
import { registerContext, registerTools, type ToolProfile } from "./tools";
import { privacyHtml, termsHtml, type LegalInfo } from "./legal";

/**
 * The opt-in REMOTE profile: what an external MCP client (e.g. an Alexa+ add-on) may reach, behind OAuth.
 * It is a separate HTTP app from the local MCP server (which only ever accepts loopback hosts), shares the same
 * SQLite database, binds to 127.0.0.1 and is meant to sit behind a TLS-terminating reverse proxy.
 *
 * Least privilege: approval, rejection, deletion, demo reset and document contents are never exposed here. Approval
 * stays in the HomeRelay app. Writes are limited to recording what the owner said and drafting proposals.
 */

export const READ_TOOLS = ["get_workload_summary", "list_open_situations", "get_situation", "list_tasks", "get_task", "get_connections", "search_household"];
export const PLAN_TOOLS = ["create_situation", "set_constraints", "propose_plan"];
const REMOTE_DESCRIPTIONS: Record<string, string> = {
  search_household: "Find a household situation or task by name or content. Every result has its type, id (usable with get_situation or get_task) and status. Documents are not searchable through this connection.",
  propose_plan: "Draft a plan for a situation from its stored constraints and tasks. This only saves a proposal: nothing is created or changed until the household owner approves it in the HomeRelay app, which is the only place approval happens.",
};

export interface RemoteOptions extends OAuthConfig {
  dbPath?: string;
  db?: Db;
  tz?: string;
  documentsDir: string;
  /** Trust X-Forwarded-For for rate limiting (only behind your own reverse proxy). */
  trustProxy?: boolean;
  /** Requests per minute per client IP (defaults: 30 for sign-in/token, 120 for MCP). */
  rateLimits?: { auth?: number; mcp?: number };
  /** Operator details shown on /privacy and /terms (unset values appear as placeholders). */
  legal?: LegalInfo;
  /** One JSON line per request (method, path without query, status, ms). Off in tests. */
  logRequests?: boolean;
  /** Folder with the add-on images (icons, carousel, banner) served at /assets/addon/<name>.png. */
  assetsDir?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SCOPE_TEXT: Record<string, string> = { [SCOPES.read]: "See your situations, tasks and their connections (not document contents)", [SCOPES.plan]: "Record situations and availability you state, and draft plans for your approval in HomeRelay" };

/** Fixed-window per-key limiter, bounded in memory. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string) => {
    const t = Date.now(); const h = hits.get(key);
    if (!h || t - h.start > windowMs) { if (hits.size > 5000) hits.clear(); hits.set(key, { start: t, n: 1 }); return true; }
    return ++h.n <= max;
  };
}

export function createRemoteApp(opts: RemoteOptions) {
  const db = opts.db ?? openDb(opts.dbPath!);
  const svc = new HomeRelayService(db, { tz: opts.tz, now: opts.now });
  const docs = new DocumentService(db, { dir: opts.documentsDir, now: opts.now });
  const graph = new GraphService(db, svc, docs);
  const oauth = new OAuthServer(db, opts);
  const publicHost = new URL(oauth.issuer).host;
  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxy) app.set("trust proxy", "loopback, uniquelocal"); // a reverse proxy on this host or its container network

  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    if (host !== publicHost && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) { res.status(403).json({ error: "forbidden_host" }); return; }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (opts.logRequests) {
      const t = Date.now();
      // the path only: query strings (authorization requests) and headers (tokens) are never logged
      res.on("finish", () => console.log(JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t })));
    }
    next();
  });
  const authLimit = limiter(opts.rateLimits?.auth ?? 30, 60_000); const mcpLimit = limiter(opts.rateLimits?.mcp ?? 120, 60_000);
  const ip = (req: express.Request) => req.ip ?? "unknown";

  app.get("/health", (_req, res) => res.json({ ok: true, service: "homerelay-remote" }));
  app.get("/ready", (_req, res) => {
    try { db.prepare("SELECT 1").get(); res.json({ ready: true }); } catch { res.status(503).json({ ready: false }); }
  });
  const legalPage = (html: string) => (_req: express.Request, res: express.Response) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(html);
  };
  // add-on images must be reachable over HTTPS; only plain *.png names from one folder, no listing, no traversal
  app.get("/assets/addon/:file", (req, res) => {
    const file = String(req.params.file);
    const full = opts.assetsDir && /^[a-z0-9-]+.png$/.test(file) ? path.join(opts.assetsDir, file) : "";
    if (!full || !fs.existsSync(full)) { res.status(404).json({ error: "not_found" }); return; }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(fs.readFileSync(full));
  });
  app.get("/privacy", legalPage(privacyHtml(opts.legal ?? {})));
  app.get("/terms", legalPage(termsHtml(opts.legal ?? {})));
  const prm = (_req: express.Request, res: express.Response) => res.json(oauth.protectedResourceMetadata());
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(oauth.authorizationServerMetadata()));

  // ---------- authorization: owner sign-in + consent, CSRF-protected, pending requests kept server-side ----------
  const pending = new Map<string, { req: AuthRequest; csrf: string; expires: number }>();
  const page = (res: express.Response, status: number, body: string, formTarget?: string) => {
    res.status(status).setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ""}; frame-ancestors 'none'; base-uri 'none'`);
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeRelay sign-in</title>
<style>body{font:16px system-ui,sans-serif;background:#f5f1e6;color:#13221d;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e6e0cf;border-radius:14px;padding:28px;max-width:420px;width:calc(100% - 32px)}h1{font-size:22px;margin:0 0 8px}ul{padding-left:20px}input{width:100%;padding:10px;border:1px solid #d6cfba;border-radius:8px;font:inherit;box-sizing:border-box}button{margin-top:12px;padding:10px 16px;border-radius:8px;border:1px solid #0c3128;background:#0c3128;color:#fff;font:inherit;cursor:pointer}button.secondary{background:#fff;color:#13221d;border-color:#d6cfba}.err{color:#a8332a}</style></head><body><main>${body}</main></body></html>`);
  };
  const consent = (res: express.Response, id: string, p: { req: AuthRequest; csrf: string }, error?: string) => {
    res.cookie("hr_csrf", p.csrf, { httpOnly: true, sameSite: "strict", secure: oauth.issuer.startsWith("https://"), path: "/oauth" });
    page(res, error ? 401 : 200, `<h1>Connect ${esc(p.req.client.name ?? p.req.client.client_id)} to HomeRelay</h1>
<p>It is asking to:</p><ul>${p.req.scope.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`).join("")}</ul>
<p>It can never approve plans, delete anything or read document contents. Information it reads is sent to that service to answer you. <a href="/privacy" target="_blank" rel="noopener">Privacy policy</a> · <a href="/terms" target="_blank" rel="noopener">Terms</a></p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${esc(id)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label for="pw">HomeRelay owner password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button></form>`, new URL(p.req.redirect_uri).origin);
  };
  const q = (v: unknown) => (typeof v === "string" ? v : undefined);

  app.get("/oauth/authorize", (req, res) => {
    if (!authLimit(ip(req))) { page(res, 429, "<h1>Too many requests</h1><p>Try again in a minute.</p>"); return; }
    try {
      const r = oauth.validateAuthorize(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, q(v)])));
      if (pending.size > 500) for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
      const id = randomBytes(16).toString("base64url");
      const p = { req: r, csrf: randomBytes(24).toString("base64url"), expires: Date.now() + 10 * 60_000 };
      pending.set(id, p);
      consent(res, id, p);
    } catch (e) {
      // the redirect URI is not trusted yet, so errors are shown here rather than redirected
      page(res, 400, `<h1>Cannot connect</h1><p class="err">${esc(e instanceof OAuthError ? e.description : "Invalid request.")}</p>`);
    }
  });

  app.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    if (!authLimit(ip(req))) { page(res, 429, "<h1>Too many requests</h1><p>Try again in a minute.</p>"); return; }
    const id = q(req.body.request_id) ?? ""; const p = pending.get(id);
    const cookie = /(?:^|;\s*)hr_csrf=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!p || p.expires < Date.now() || !cookie || cookie !== p.csrf || q(req.body.csrf) !== p.csrf) {
      page(res, 400, "<h1>This sign-in page has expired</h1><p>Start the connection again from the app you are linking.</p>"); return;
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(p.req.redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.req.state !== null) u.searchParams.set("state", p.req.state);
      u.searchParams.set("iss", oauth.issuer);
      pending.delete(id);
      res.redirect(302, u.toString());
    };
    if (q(req.body.decision) !== "allow") { back({ error: "access_denied" }); return; }
    try {
      if (!oauth.signIn(q(req.body.password) ?? "")) { consent(res, id, p, "That password is not correct."); return; }
    } catch (e) {
      if (e instanceof OAuthError) { page(res, e.status, `<h1>Sign-in locked</h1><p class="err">${esc(e.description)}</p>`); return; }
      throw e;
    }
    back({ code: oauth.issueCode(p.req) });
  });

  const tokenRoute = (fn: (req: express.Request) => Record<string, unknown> | void) => [express.urlencoded({ extended: false, limit: "8kb" }), (req: express.Request, res: express.Response) => {
    if (!authLimit(ip(req))) { res.status(429).json({ error: "slow_down", error_description: "Too many requests." }); return; }
    try { const out = fn(req); res.status(200).json(out ?? {}); }
    catch (e) {
      if (e instanceof OAuthError) {
        if (e.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="homerelay"');
        res.status(e.status).json({ error: e.error, error_description: e.description }); return;
      }
      console.error("[remote] token endpoint error:", (e as Error)?.message);
      res.status(500).json({ error: "server_error", error_description: "Unexpected error." });
    }
  }] as const;
  app.post("/oauth/token", ...tokenRoute((req) => oauth.exchange(oauth.authenticateClient(req.headers.authorization, req.body), req.body)));
  app.post("/oauth/revoke", ...tokenRoute((req) => { oauth.revoke(oauth.authenticateClient(req.headers.authorization, req.body), q(req.body.token) ?? ""); }));

  // ---------- MCP behind bearer tokens; the token's scopes decide which tools exist ----------
  const unauthorized = (res: express.Response, status: 401 | 403, error: string, description: string) => {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource", error="${error}"`);
    res.status(status).json({ error, error_description: description });
  };
  app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
    if (!mcpLimit(ip(req))) { res.status(429).json({ error: "rate_limited", error_description: "Too many requests." }); return; }
    const auth = req.headers.authorization ?? "";
    const grant = auth.startsWith("Bearer ") ? oauth.verifyAccess(auth.slice(7).trim()) : null;
    if (!grant) { unauthorized(res, 401, "invalid_token", "A valid access token for this resource is required."); return; }
    const tools = new Set<string>([...(grant.scope.includes(SCOPES.read) ? READ_TOOLS : []), ...(grant.scope.includes(SCOPES.plan) ? PLAN_TOOLS : [])]);
    if (!tools.size) { unauthorized(res, 403, "insufficient_scope", "The token has no HomeRelay scope."); return; }
    const profile: ToolProfile = { tools, actor: "agent", searchTypes: ["situation", "task"], descriptions: REMOTE_DESCRIPTIONS };
    const server = new McpServer({ name: "homerelay", version: "0.5.0" });
    registerTools(server, svc, { approvalSecret: randomBytes(32).toString("hex"), allowDemoReset: false }, docs, graph, profile);
    if (grant.scope.includes(SCOPES.read)) registerContext(server, svc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (e) {
      console.error("[remote] transport error:", (e as Error)?.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", notAllowed); app.delete("/mcp", notAllowed);

  const pruner = setInterval(() => { try { oauth.prune(); } catch { /* next run */ } }, 3600_000);
  pruner.unref();
  return { app, oauth, db, close: () => clearInterval(pruner) };
}
