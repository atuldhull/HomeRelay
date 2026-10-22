import type { NextFunction, Request, Response } from "express";
import type { ApiConfig } from "./config";

/** Mutating requests must carry this header. A cross-origin page cannot add it without a CORS preflight we refuse. */
export const CLIENT_HEADER = "X-HomeRelay-Client";
export const CLIENT_HEADER_VALUE = "web";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function deny(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Browser-facing protections for a local, single-user API:
 *  - Host allow-list (defeats DNS rebinding).
 *  - Cross-site requests rejected (Origin / Sec-Fetch-Site), so another website cannot drive approvals.
 *  - Mutations require JSON content-type plus a custom client header (forces a CORS preflight for foreign origins).
 *  - Baseline response headers, no caching of API responses.
 * Non-browser clients (curl, tests) send no Origin and are allowed, but must still send the header.
 */
export function securityGuards(cfg: ApiConfig) {
  const origins = new Set(cfg.webOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(host)) return deny(res, 403, "FORBIDDEN_HOST", "Requests must target localhost.");

    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return deny(res, 403, "FORBIDDEN_ORIGIN", "This origin is not allowed.");
    if (req.headers["sec-fetch-site"] === "cross-site") return deny(res, 403, "FORBIDDEN_ORIGIN", "Cross-site requests are not allowed.");

    if (MUTATING.has(req.method) && req.method !== "OPTIONS") {
      if (req.headers[CLIENT_HEADER.toLowerCase()] !== CLIENT_HEADER_VALUE) return deny(res, 403, "MISSING_CLIENT_HEADER", `Mutating requests require the ${CLIENT_HEADER} header.`);
      const ct = String(req.headers["content-type"] ?? "");
      // JSON everywhere, except the one upload route, which takes raw bytes. Both still need the custom header above.
      const upload = req.method === "POST" && req.path === "/api/documents" && ct.toLowerCase().startsWith("application/octet-stream");
      if (!upload && !ct.toLowerCase().startsWith("application/json")) return deny(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }
    next();
  };
}

/** Tiny fixed-window limiter (per process) to bound chat/LLM spend. Not a substitute for real auth if ever exposed. */
export function rateLimit(max: number, windowMs: number) {
  let start = Date.now(); let count = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - start > windowMs) { start = now; count = 0; }
    if (++count > max) { res.setHeader("Retry-After", String(Math.ceil((start + windowMs - now) / 1000))); return deny(res, 429, "RATE_LIMITED", "Too many requests. Please slow down."); }
    next();
  };
}
