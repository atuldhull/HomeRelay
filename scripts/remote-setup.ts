import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../apps/mcp-server/src/oauth";
import { openDb } from "../apps/mcp-server/src/db";
import { REPO_ROOT, fromRoot, loadEnv } from "./env";

/**
 * Creates remote-profile credentials without printing any secret to the terminal.
 *   npm run remote:owner                         reads the owner password from the HOMERELAY_OWNER_PASSWORD env var
 *   npm run remote:client -- <redirect-uri> ...  generates a client id + secret
 *   npm run remote:revoke-all                    revokes every linked session (incident response, secret rotation)
 * Values are written to .data/remote-secrets/ (git-ignored). Copy them into .env or your secret store, then delete the file.
 */
const dir = path.join(REPO_ROOT, ".data", "remote-secrets");
const write = (name: string, body: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, body, { mode: 0o600 });
  return path.relative(REPO_ROOT, f);
};
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "owner") {
  const pw = process.env.HOMERELAY_OWNER_PASSWORD ?? "";
  if (pw.length < 12) { console.error("Set HOMERELAY_OWNER_PASSWORD (12+ characters) in this shell only, then run again."); process.exit(1); }
  // single quotes: Docker Compose expands the hash's $ separators in an unquoted env_file value
  const f = write("owner.env", `REMOTE_OWNER_PASSWORD_HASH='${hashPassword(pw)}'\n`);
  console.log(`Owner password hash written to ${f}. Add the line (with its quotes) to .env or deploy/remote.env, then clear HOMERELAY_OWNER_PASSWORD from your shell.`);
} else if (cmd === "client") {
  if (!args.length || !args.every((u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } })) {
    console.error("Pass one or more https:// redirect URIs, exactly as the Alexa+ Developer Hub lists them."); process.exit(1);
  }
  const id = `hr-${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const client = { client_id: id, name: "Alexa+", redirect_uris: args, client_secret_sha256: createHash("sha256").update(secret).digest("hex") };
  const f = write(`client-${id}.txt`, [
    `# Give these two values to the Alexa+ add-on account-linking configuration:`,
    `client_id=${id}`, `client_secret=${secret}`, ``,
    `# Add this entry to the REMOTE_OAUTH_CLIENTS JSON array, inside single quotes: REMOTE_OAUTH_CLIENTS='[ ... ]' (only the secret's hash is stored):`,
    JSON.stringify(client), ``].join("\n"));
  console.log(`Client ${id} created. The secret and the REMOTE_OAUTH_CLIENTS entry are in ${f}.`);
} else if (cmd === "revoke-all") {
  loadEnv();
  const db = openDb(fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db"));
  const now = new Date().toISOString();
  db.prepare("UPDATE oauth_codes SET used_at=? WHERE used_at IS NULL").run(now);
  const n = db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE revoked_at IS NULL").run(now).changes;
  db.close();
  console.log(`Revoked ${n} token(s). Every linked client must sign in again.`);
} else {
  console.error("Usage: remote-setup.ts owner | client <redirect-uri>... | revoke-all"); process.exit(1);
}
