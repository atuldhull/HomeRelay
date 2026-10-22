import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, independent of the process cwd (workspace scripts run from apps/*). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader (no dependency). Existing process env wins. */
export function loadEnv(file = path.join(REPO_ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** Resolve a possibly-relative path against the repo root. */
export const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));

/** Throws a clear error for an invalid IANA timezone (e.g. a typo in APP_TIMEZONE). */
export function assertTimeZone(tz: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; }
  catch { throw new Error(`APP_TIMEZONE "${tz}" is not a valid IANA time zone (example: Asia/Kolkata).`); }
}
