import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * End-to-end check of a running remote profile, from outside, the way a real client sees it.
 *   npm run verify:remote -- <base-url> run <state-file>             full lifecycle; writes a state file for the next step
 *   npm run verify:remote -- <base-url> after-restart <state-file>    after restarting the server: refresh + read back
 *   npm run verify:remote -- <base-url> rate-limit                    floods /oauth/token until it answers 429
 * Credentials come from the environment, never from arguments: VERIFY_CLIENT_ID, VERIFY_CLIENT_SECRET,
 * VERIFY_REDIRECT_URI, VERIFY_OWNER_PASSWORD. The state file holds a live refresh token: keep it private and delete it after.
 * For a test CA (the tls-local rehearsal) set NODE_EXTRA_CA_CERTS; certificate verification is never disabled.
 */
const [baseArg, mode, stateFile] = process.argv.slice(2);
if (!baseArg || !mode) { console.error("Usage: verify-remote.ts <base-url> run|after-restart|rate-limit [state-file]"); process.exit(2); }
const base = baseArg.replace(/\/+$/, "");
const env = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const CLIENT_ID = env("VERIFY_CLIENT_ID"), SECRET = env("VERIFY_CLIENT_SECRET"), REDIRECT = env("VERIFY_REDIRECT_URI");
const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const token = async (body: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic }, body: form(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const mcpRaw = (bearer: string | null, body: string, extra: Record<string, string> = {}) => fetch(`${base}/mcp`, {
  method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra },
});
const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
async function client(bearer: string) {
  const c = new Client({ name: "homerelay-verify", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return c;
}
const text = (r: any) => JSON.parse((r.content as { text: string }[])[0].text);

async function link() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state: "verify-state", code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/mcp`, scope: "homerelay.read homerelay.plan" });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  const html = await page.text();
  const setCookie = page.headers.get("set-cookie") ?? "";
  if (base.startsWith("https://")) check("consent cookie is Secure, HttpOnly, SameSite=Strict", /;\s*Secure/i.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));
  check("consent page has a strict CSP", (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
  const csrf = /hr_csrf=([^;]+)/.exec(setCookie)?.[1] ?? ""; const rid = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const back = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `hr_csrf=${csrf}` }, body: form({ request_id: rid, csrf, password: env("VERIFY_OWNER_PASSWORD"), decision: "allow" }) });
  const loc = new URL(back.headers.get("location") ?? "about:blank");
  check("owner sign-in redirects with code, state and iss", back.status === 302 && !!loc.searchParams.get("code") && loc.searchParams.get("state") === "verify-state" && loc.searchParams.get("iss") === base);
  const t = await token({ grant_type: "authorization_code", code: loc.searchParams.get("code") ?? "", redirect_uri: REDIRECT, code_verifier: verifier, resource: `${base}/mcp` });
  check("code + PKCE exchange issues access and refresh tokens", t.status === 200 && !!t.json.access_token && !!t.json.refresh_token, `status ${t.status}`);
  if (t.status !== 200) { console.log("\nlinking failed: check VERIFY_* values and REMOTE_OWNER_PASSWORD_HASH (quoted?)"); process.exit(1); }
  return t.json as { access_token: string; refresh_token: string };
}

if (mode === "run") {
  if (!stateFile) { console.error("run needs a state-file path"); process.exit(2); }
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as any;
  check("protected-resource metadata advertises this server", meta.resource === `${base}/mcp` && meta.authorization_servers?.[0] === base);
  const health = await fetch(`${base}/health`); const healthBody = await health.text();
  check("health is public and discloses nothing private", health.status === 200 && !/secret|token|password|\.db/i.test(healthBody));
  for (const legal of ["/privacy", "/terms"]) check(`${legal} is public`, (await fetch(base + legal)).status === 200);

  const anon = await mcpRaw(null, listBody);
  check("1. unauthenticated MCP request is rejected (401 + WWW-Authenticate)", anon.status === 401 && (anon.headers.get("www-authenticate") ?? "").includes("resource_metadata="));
  check("1. forged bearer token is rejected", (await mcpRaw("forged-token", listBody)).status === 401);

  const t = await link();                                                           // 2
  const c = await client(t.access_token);
  const names = (await c.listTools()).tools.map((x) => x.name);
  check("5. permitted tools are listed (10)", names.length === 10, names.join(","));
  const sum = await c.callTool({ name: "get_workload_summary", arguments: {} });
  check("5. get_workload_summary works", !sum.isError);
  const made = text(await c.callTool({ name: "create_situation", arguments: { title: `Verify ${new Date().toISOString()}`, category: "delivery", expected_at: new Date(Date.now() + 86400_000).toISOString() } }));
  const sid = made.situation?.id as string;
  check("5. create_situation persists a record", !!sid);
  await c.callTool({ name: "set_constraints", arguments: { situation_id: sid, available_from: new Date(Date.now() + 90000_000).toISOString(), nobody_else_home: true } });
  const plan = text(await c.callTool({ name: "propose_plan", arguments: { situation_id: sid } }));
  check("5. propose_plan drafts without executing", plan.proposal?.status === "proposed");
  for (const banned of ["approve_plan", "delete_task", "get_document_text", "reset_demo_data"]) {
    const r = await c.callTool({ name: banned, arguments: {} }).catch((e) => ({ isError: true, err: String(e) }));
    check(`6. prohibited tool ${banned} cannot be called`, !!r.isError);
  }
  const docs = text(await c.callTool({ name: "search_household", arguments: { query: "receipt", types: ["document"] } }));
  check("6. search cannot return documents", Array.isArray(docs.results) && docs.results.length === 0);
  await c.close();

  const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  check("3. refresh issues a new token pair", r1.status === 200 && r1.json.refresh_token !== t.refresh_token);
  check("4. the rotated-out access token stops working", (await mcpRaw(t.access_token, listBody)).status === 401);
  check("4. reuse of a rotated refresh token is refused", (await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status === 400);
  check("4. ...and it revoked the session it belonged to", (await mcpRaw(r1.json.access_token, listBody)).status === 401);

  const t2 = await link();
  const rev = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic }, body: form({ token: t2.access_token }) });
  check("4. revocation endpoint accepts the token", rev.status === 200);
  check("4. a revoked token stops working", (await mcpRaw(t2.access_token, listBody)).status === 401);

  for (const p of ["/api/health", "/api/situations", "/internal/documents", "/", "/mcp/admin"]) {
    const r = await fetch(base + p);
    check(`8. local-only path ${p} is not exposed`, r.status === 404 || r.status === 403, `status ${r.status}`);
  }
  const t3 = await link();
  check("9. malformed JSON is a 400, not a crash", (await mcpRaw(t3.access_token, "{not json")).status === 400);
  check("9. an oversized body is refused", [413, 400].includes((await mcpRaw(t3.access_token, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(2_000_000) } }))).status));
  check("9. an unknown grant type is a clean OAuth error", (await token({ grant_type: "password" })).json.error === "unsupported_grant_type");

  fs.writeFileSync(stateFile, JSON.stringify({ situation_id: sid, refresh_token: t3.refresh_token, seen: [t.access_token, t.refresh_token, t2.access_token, t3.access_token, t3.refresh_token, r1.json.access_token, r1.json.refresh_token] }), { mode: 0o600 });
} else if (mode === "after-restart") {
  const s = JSON.parse(fs.readFileSync(stateFile!, "utf8"));
  const r = await token({ grant_type: "refresh_token", refresh_token: s.refresh_token });
  check("7. the refresh token issued before the restart still works", r.status === 200, `status ${r.status}`);
  if (r.status === 200) {
    const c = await client(r.json.access_token);
    const got = text(await c.callTool({ name: "get_situation", arguments: { situation_id: s.situation_id } }));
    check("7. household data written before the restart is still there", got.situation?.id === s.situation_id);
    await c.close();
    s.refresh_token = r.json.refresh_token; s.seen.push(r.json.access_token, r.json.refresh_token);
    fs.writeFileSync(stateFile!, JSON.stringify(s), { mode: 0o600 });
  }
} else if (mode === "rate-limit") {
  let limited = 0;
  for (let i = 0; i < 40 && !limited; i++) if ((await token({ grant_type: "refresh_token", refresh_token: "x" })).status === 429) limited = i + 1;
  check("9. the token endpoint rate-limits a flood (429)", limited > 0, `after ${limited} requests`);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
