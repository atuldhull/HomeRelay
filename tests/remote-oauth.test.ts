import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteApp, PLAN_TOOLS, READ_TOOLS } from "../apps/mcp-server/src/remote";
import { hashPassword, pkceChallenge } from "../apps/mcp-server/src/oauth";

const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "alexa-test";
const CLIENT_SECRET = randomBytes(24).toString("base64url");
const REDIRECT = "https://alexa.example.test/callback"; // never contacted: the test reads the Location header
let clock = Date.parse("2026-10-22T10:00:00.000Z");
let base: string; let server: Server; let remote: ReturnType<typeof createRemoteApp>; let tmp: string;

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const basic = (id = CLIENT_ID, secret = CLIENT_SECRET) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Drives the real sign-in + consent page: GET authorize, then POST the form with the CSRF cookie. */
async function authorize(opts: { scope?: string; verifier?: string; password?: string; decision?: string; redirect?: string; csrf?: string } = {}) {
  const verifier = opts.verifier ?? randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: opts.redirect ?? REDIRECT, state: "st-123", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", resource: `${base}/mcp`, scope: opts.scope ?? "homerelay.read homerelay.plan" });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  const html = await page.text();
  if (page.status !== 200) return { status: page.status, html, verifier };
  const cookie = /hr_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")![1];
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1];
  const res = await fetch(`${base}/oauth/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `hr_csrf=${cookie}` },
    body: form({ request_id: requestId, csrf: opts.csrf ?? cookie, password: opts.password ?? PASSWORD, decision: opts.decision ?? "allow" }),
  });
  const loc = res.headers.get("location");
  return { status: res.status, html: loc ? "" : await res.text(), verifier, location: loc ? new URL(loc) : null, csp: page.headers.get("content-security-policy") };
}
async function token(body: Record<string, string>, auth = basic()) {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: auth }, body: form(body) });
  return { status: r.status, json: (await r.json()) as any, headers: r.headers };
}
async function login(scope?: string) {
  const a = await authorize({ scope });
  const code = a.location!.searchParams.get("code")!;
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: `${base}/mcp` });
  expect(t.status).toBe(200);
  return { ...t.json, code, verifier: a.verifier };
}
const mcpPost = (bearer: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
async function mcpClient(bearer: string) {
  const c = new Client({ name: "alexa-plus-stand-in", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return c;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-remote-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  remote = createRemoteApp({
    baseUrl: base, dbPath: path.join(tmp, "remote.db"), documentsDir: path.join(tmp, "documents"), tz: "Asia/Kolkata", assetsDir: path.resolve("assets/brand/addon"),
    ownerPasswordHash: hashPassword(PASSWORD, 1024), now: () => new Date(clock), accessTtlSec: 600,
    clients: [{ client_id: CLIENT_ID, name: "Alexa+ (test)", redirect_uris: [REDIRECT], client_secret_sha256: createHash("sha256").update(CLIENT_SECRET).digest("hex") }],
    rateLimits: { auth: 10_000, mcp: 10_000 },
  });
  await new Promise<void>((r) => { server = remote.app.listen(port, "127.0.0.1", () => r()); });
});
afterAll(async () => {
  remote?.close(); await new Promise((r) => server?.close(r)); remote?.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("remote profile discovery (Alexa+ account-linking metadata)", () => {
  it("serves protected-resource metadata whose resource matches the MCP URL", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const m = await (await fetch(base + p)).json() as any;
      expect(m.resource).toBe(`${base}/mcp`);
      expect(m.authorization_servers[0]).toBe(base);
      expect(m.scopes_supported).toEqual(["homerelay.read", "homerelay.plan"]);
    }
  });
  it("serves authorization-server metadata with code + S256 only", async () => {
    const m = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any;
    expect(m.issuer).toBe(base);
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.registration_endpoint).toBeUndefined(); // static client registration only
  });
  it("health and readiness respond", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ ready: true });
  });
  it("rejects requests for a host that is not the configured public host or loopback", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: new URL(base).port, path: "/health", headers: { host: "evil.example" } }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject);
    });
    expect(status).toBe(403);
  });
});

describe("authorization code + PKCE, then a real MCP tool invocation", () => {
  it("links, lists only the remote tools, and proposes a plan without executing it", async () => {
    const a = await authorize();
    expect(a.status).toBe(302);
    expect(a.location!.origin + a.location!.pathname).toBe(REDIRECT);
    expect(a.location!.searchParams.get("state")).toBe("st-123");
    expect(a.location!.searchParams.get("iss")).toBe(base);
    const t = await token({ grant_type: "authorization_code", code: a.location!.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: `${base}/mcp` });
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: "homerelay.read homerelay.plan" });
    expect(t.json.refresh_token).toBeTruthy();
    expect(t.headers.get("cache-control")).toBe("no-store");

    const c = await mcpClient(t.json.access_token);
    const names = (await c.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...PLAN_TOOLS].sort());
    for (const banned of ["approve_plan", "reject_plan", "delete_task", "reset_demo_data", "get_document", "read_document", "resolve_situation"]) expect(names).not.toContain(banned);

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      return { isError: !!r.isError, data: JSON.parse((r.content as { text: string }[])[0].text) };
    };
    const expected = new Date(clock + 86400_000).toISOString();
    // the client claims to be the user; the remote profile records it as the agent anyway
    const sit = await call("create_situation", { title: "Parcel from Alexa test", category: "delivery", expected_at: expected, actor: "user" });
    expect(sit.isError).toBe(false);
    const sid = sit.data.situation.id;
    expect((await call("set_constraints", { situation_id: sid, available_from: new Date(clock + 90000_000).toISOString(), nobody_else_home: true })).isError).toBe(false);
    const plan = await call("propose_plan", { situation_id: sid });
    expect(plan.isError).toBe(false);
    expect(plan.data.proposal?.status).toBe("proposed");
    const db = remote.db;
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE situation_id=?").get(sid)).toEqual({ c: 0 }); // proposal != execution
    expect(db.prepare("SELECT DISTINCT actor FROM activity_events WHERE situation_id=?").all(sid)).toEqual([{ actor: "agent" }]);
    expect((await call("get_situation", { situation_id: sid })).data.situation.title).toBe("Parcel from Alexa test");
    await c.close();
  });

  it("search never returns documents through the remote profile", async () => {
    const t = await login("homerelay.read");
    const c = await mcpClient(t.access_token);
    const r = await c.callTool({ name: "search_household", arguments: { query: "parcel", types: ["document"] } });
    const data = JSON.parse((r.content as { text: string }[])[0].text);
    expect(data.results).toEqual([]);
    await c.close();
  });

  it("scopes decide the tool set: read-only tokens cannot draft plans", async () => {
    const t = await login("homerelay.read");
    const c = await mcpClient(t.access_token);
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names.sort()).toEqual([...READ_TOOLS].sort());
    const r = await c.callTool({ name: "propose_plan", arguments: { situation_id: "x" } });
    expect(r.isError).toBe(true);
    await c.close();
  });
});

describe("bearer enforcement on /mcp", () => {
  it("401 with resource metadata when the token is missing or invalid", async () => {
    for (const b of [null, "not-a-real-token"]) {
      const r = await mcpPost(b);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    }
  });
  it("expired access tokens are rejected", async () => {
    const t = await login();
    expect((await mcpPost(t.access_token)).status).toBe(200);
    clock += 601_000;
    try { expect((await mcpPost(t.access_token)).status).toBe(401); } finally { clock -= 601_000; }
  });
  it("revoked tokens are rejected (revocation covers the whole grant)", async () => {
    const t = await login();
    const r = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic() }, body: form({ token: t.refresh_token }) });
    expect(r.status).toBe(200);
    expect((await mcpPost(t.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
  });
  it("tokens bound to another resource are rejected", async () => {
    const t = await login();
    remote.db.prepare("UPDATE oauth_tokens SET resource='https://other.example/mcp' WHERE token_hash=?").run(createHash("sha256").update(t.access_token).digest("hex"));
    expect((await mcpPost(t.access_token)).status).toBe(401);
  });
  it("GET /mcp is not a session stream", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});

describe("token endpoint hardening", () => {
  it("a replayed code fails and revokes the tokens it produced", async () => {
    const t = await login();
    const again = await token({ grant_type: "authorization_code", code: t.code, redirect_uri: REDIRECT, code_verifier: t.verifier });
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("invalid_grant");
    expect((await mcpPost(t.access_token)).status).toBe(401);
  });
  it("a wrong PKCE verifier, a mismatched redirect or an expired code are refused", async () => {
    const a = await authorize();
    const code = a.location!.searchParams.get("code")!;
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") })).json.error).toBe("invalid_grant");
    const b = await authorize();
    expect((await token({ grant_type: "authorization_code", code: b.location!.searchParams.get("code")!, redirect_uri: "https://alexa.example.test/other", code_verifier: b.verifier })).json.error).toBe("invalid_grant");
    const c = await authorize();
    clock += 61_000;
    try { expect((await token({ grant_type: "authorization_code", code: c.location!.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: c.verifier })).json.error).toBe("invalid_grant"); }
    finally { clock -= 61_000; }
  });
  it("wrong client credentials get 401 invalid_client", async () => {
    const a = await authorize();
    const r = await token({ grant_type: "authorization_code", code: a.location!.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: a.verifier }, basic(CLIENT_ID, "wrong-secret"));
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("invalid_client");
  });
  it("refresh rotates; reusing an old refresh token revokes the session", async () => {
    const t = await login();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.refresh_token);
    expect((await mcpPost(t.access_token)).status).toBe(401); // the rotated-out access token stops working
    expect((await mcpPost(r1.json.access_token)).status).toBe(200);
    const reuse = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(reuse.status).toBe(400);
    expect((await mcpPost(r1.json.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token })).status).toBe(400);
  });
  it("a refresh cannot widen the granted scopes", async () => {
    const t = await login("homerelay.read");
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: "homerelay.read homerelay.plan" })).json.error).toBe("invalid_scope");
  });
});

describe("sign-in and consent page", () => {
  it("unregistered redirect URIs and missing PKCE are shown as errors, never redirected", async () => {
    expect((await authorize({ redirect: "https://attacker.example/cb" })).status).toBe(400);
    const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT })}`, { redirect: "manual" });
    expect(r.status).toBe(400);
  });
  it("the consent page has a strict CSP that only allows posting back and to the registered redirect", async () => {
    const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: pkceChallenge(randomBytes(32).toString("base64url")), code_challenge_method: "S256" });
    const r = await fetch(`${base}/oauth/authorize?${q}`);
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self' https://alexa.example.test");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  it("a forged CSRF value is refused", async () => {
    const a = await authorize({ csrf: "forged" });
    expect(a.status).toBe(400);
    expect(a.location).toBeNull();
  });
  it("deny returns access_denied with the state", async () => {
    const a = await authorize({ decision: "deny" });
    expect(a.location!.searchParams.get("error")).toBe("access_denied");
    expect(a.location!.searchParams.get("state")).toBe("st-123");
    expect(a.location!.searchParams.get("code")).toBeNull();
  });
  it("five wrong passwords lock sign-in, even for the right password, until the window passes", async () => {
    for (let i = 0; i < 5; i++) expect((await authorize({ password: "wrong password" })).status).toBe(401);
    const locked = await authorize();
    expect(locked.status).toBe(429);
    expect(locked.location).toBeNull();
    clock += 16 * 60_000;
    expect((await authorize()).status).toBe(302);
  });
});

describe("public legal pages and owner controls", () => {
  it("serves /privacy and /terms without authentication, with placeholders for unset operator details", async () => {
    for (const p of ["/privacy", "/terms"]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      const html = await r.text();
      expect(html).toContain("to be completed by the operator");
      expect(html).not.toMatch(/<script/i);
    }
    expect(await (await fetch(`${base}/privacy`)).text()).toContain("homerelay.read");
  });
  it("serves the add-on images and nothing else from the assets route", async () => {
    const r = await fetch(`${base}/assets/addon/icon-light-241x241.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    for (const p of ["..%2F..%2Fpackage.json", "%2E%2E%2Fsrc%2Ficon-light.svg", "icon-light.svg", "missing.png"]) expect((await fetch(`${base}/assets/addon/${p}`)).status).toBe(404);
  });
  it("revokeAll ends every linked session", async () => {
    const t = await login();
    expect((await mcpPost(t.access_token)).status).toBe(200);
    expect(remote.oauth.revokeAll()).toBeGreaterThan(0);
    expect((await mcpPost(t.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
  });
  it("the request log never contains codes, tokens or query strings", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    const logged = createRemoteApp({
      baseUrl: base, db: remote.db, documentsDir: path.join(tmp, "documents"), ownerPasswordHash: hashPassword(PASSWORD, 1024),
      clients: [{ client_id: CLIENT_ID, redirect_uris: [REDIRECT] }], logRequests: true, rateLimits: { auth: 10_000, mcp: 10_000 },
    });
    const s2 = await new Promise<Server>((r) => { const s = logged.app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const port2 = (s2.address() as net.AddressInfo).port;
      const t = await login();
      const secretish = [t.access_token, t.refresh_token, t.code, t.verifier];
      await fetch(`http://127.0.0.1:${port2}/oauth/authorize?state=SECRET_STATE&code_challenge=x`);
      await fetch(`http://127.0.0.1:${port2}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      await new Promise((r) => setTimeout(r, 50));
      const all = lines.join("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const v of [...secretish, "SECRET_STATE"]) expect(all).not.toContain(v);
    } finally { console.log = orig; logged.close(); await new Promise((r) => s2.close(r)); }
  });
});
