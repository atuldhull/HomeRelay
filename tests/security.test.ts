import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/server";
import { createApp } from "../apps/api/src/app";
import { McpGateway } from "../apps/api/src/gateway";
import type { ApiConfig } from "../apps/api/src/config";
import { assertTimeZone } from "../scripts/env";

const SECRET = "security-test-secret-0123456789";
const ORIGIN = "http://localhost:5173";
let mcp: Awaited<ReturnType<typeof startMcpServer>>; let gw: McpGateway; let api: http.Server; let apiPort: number; let tmp: string;

const cfg: ApiConfig = {
  port: 0, mcpUrl: "", webOrigins: [ORIGIN], tz: "Asia/Kolkata", approvalSecret: SECRET, allowDemoReset: true,
  llm: { provider: "deterministic", apiKey: "", model: "" }, dbPath: "",
};

/** Raw HTTP so tests can set Host / Origin / Sec-Fetch-Site exactly as a hostile page or rebinding attack would. */
function raw(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
const GOOD = { host: "localhost:5173", "content-type": "application/json", "x-homerelay-client": "web" };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "homerelay-sec-"));
  mcp = await startMcpServer({ port: 0, dbPath: path.join(tmp, "t.db"), approvalSecret: SECRET, allowDemoReset: true, tz: "Asia/Kolkata" });
  gw = new McpGateway(mcp.url);
  api = http.createServer(createApp(gw, { ...cfg, mcpUrl: mcp.url }));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiPort = (api.address() as AddressInfo).port;
});
afterAll(async () => { await gw.close(); await new Promise((r) => api.close(r)); await mcp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("API browser-facing protections", () => {
  it("rejects mutations without the client header (a cross-site form cannot add it)", async () => {
    const r = await raw(apiPort, "POST", "/api/demo/delivery", { host: "localhost:5173", "content-type": "application/json" }, "{}");
    expect(r.status).toBe(403); expect(JSON.parse(r.body).error.code).toBe("MISSING_CLIENT_HEADER");
  });
  it("rejects non-JSON content types, including the text/plain 'simple request' CSRF trick", async () => {
    const r = await raw(apiPort, "POST", "/api/demo/delivery", { host: "localhost:5173", "content-type": "text/plain", "x-homerelay-client": "web" }, "{}");
    expect(r.status).toBe(415);
  });
  it("rejects foreign Origin and cross-site fetch metadata, accepts the configured web origin", async () => {
    const evil = await raw(apiPort, "POST", "/api/demo/delivery", { ...GOOD, origin: "https://evil.example.com" }, "{}");
    expect(evil.status).toBe(403); expect(JSON.parse(evil.body).error.code).toBe("FORBIDDEN_ORIGIN");
    const xs = await raw(apiPort, "POST", "/api/demo/delivery", { ...GOOD, "sec-fetch-site": "cross-site" }, "{}");
    expect(xs.status).toBe(403);
    const ok = await raw(apiPort, "POST", "/api/demo/delivery", { ...GOOD, origin: ORIGIN, "sec-fetch-site": "same-origin" }, "{}");
    expect([200, 201]).toContain(ok.status);
  });
  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    const r = await raw(apiPort, "GET", "/api/health", { host: "attacker.example.com" });
    expect(r.status).toBe(403); expect(JSON.parse(r.body).error.code).toBe("FORBIDDEN_HOST");
  });
  it("grants no CORS access to a foreign origin on preflight", async () => {
    const r = await raw(apiPort, "OPTIONS", "/api/proposals/x/approve", { host: "localhost:5173", origin: "https://evil.example.com", "access-control-request-method": "POST", "access-control-request-headers": "x-homerelay-client,content-type" });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.status).toBe(403);
  });
  it("sets baseline headers and never caches API responses", async () => {
    const r = await raw(apiPort, "GET", "/api/health", { host: "localhost:5173" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
  it("bounds request size", async () => {
    const big = JSON.stringify({ message: "x".repeat(200_000) });
    const r = await raw(apiPort, "POST", "/api/chat", GOOD, big);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error.code).toBe("PAYLOAD_TOO_LARGE");
  });
  it("rate-limits chat to bound LLM spend", async () => {
    const results: number[] = [];
    for (let i = 0; i < 62; i++) results.push((await raw(apiPort, "POST", "/api/chat", GOOD, JSON.stringify({ message: "What is still pending?" }))).status);
    expect(results.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(results).toContain(429);
  });
});

describe("MCP server protections", () => {
  const port = () => Number(new URL(mcp.url).port);
  it("rejects foreign Origin and Host headers", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await raw(port(), "POST", "/mcp", { ...h, host: `localhost:${port()}`, origin: "https://evil.example.com" }, body)).status).toBe(403);
    expect((await raw(port(), "POST", "/mcp", { ...h, host: "attacker.example.com" }, body)).status).toBe(403);
  });
  it("privileged tools refuse calls without the service secret, even from a valid client", async () => {
    for (const [tool, args] of [["approve_plan", { proposal_id: "p", approval_token: "wrong-wrong-wrong-wrong" }], ["reject_plan", { proposal_id: "p", approval_token: "wrong-wrong-wrong-wrong" }], ["reset_demo_data", { approval_token: "wrong-wrong-wrong-wrong" }]] as const) {
      await expect(gw.call(tool, args as any)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});

describe("secret and repository hygiene", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]) : [];

  it("API responses and traces never contain the approval secret", async () => {
    const outs = [await raw(apiPort, "GET", "/api/health", { host: "localhost:5173" }), await raw(apiPort, "GET", "/api/trace", { host: "localhost:5173" }), await raw(apiPort, "GET", "/api/nope", { host: "localhost:5173" }), await raw(apiPort, "POST", "/api/chat", GOOD, "{bad")];
    for (const o of outs) expect(o.body).not.toContain(SECRET);
  });
  it("the web source and any built bundle contain no secret material", () => {
    const files = [...walk(path.join(root, "apps/web/src")), ...walk(path.join(root, "apps/web/dist"))];
    expect(files.length).toBeGreaterThan(0);
    const envFile = path.join(root, ".env");
    const real = fs.existsSync(envFile) ? /^APPROVAL_SECRET=(.+)$/m.exec(fs.readFileSync(envFile, "utf8"))?.[1]?.trim() : undefined;
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/approval_token|APPROVAL_SECRET|ANTHROPIC_API_KEY|sk-ant-/);
      if (real && real.length >= 16) expect(s, f).not.toContain(real);
    }
  });
  it("git tracks no .env, database or log files", () => {
    const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    expect(tracked.filter((f) => /(^|\/)\.env($|\.)(?!example)/.test(f) || /\.(db|db-wal|db-shm|log)$/.test(f))).toEqual([]);
    expect(tracked).toContain(".env.example");
    expect(fs.readFileSync(path.join(root, ".env.example"), "utf8")).toMatch(/^APPROVAL_SECRET=\s*$/m);
    expect(fs.readFileSync(path.join(root, ".env.example"), "utf8")).toMatch(/^ANTHROPIC_API_KEY=\s*$/m);
  });
  it("rejects an invalid time zone at startup", () => {
    expect(() => assertTimeZone("Mars/Olympus")).toThrow(/not a valid IANA/);
    expect(assertTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });
});
