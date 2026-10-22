import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";

/**
 * OAuth 2.1 authorization server for HomeRelay's opt-in remote profile. HomeRelay is single-household: the one
 * subject is the household owner, who signs in with the owner password configured on this server. It implements what
 * Amazon's Alexa+ MCP account-linking page requires: authorization code grant with PKCE S256, static client
 * registration, a refresh token with every access token, and the `resource` parameter. Codes and tokens are random
 * opaque values; only their SHA-256 hashes are stored, so a database copy cannot be replayed as credentials.
 */

export const SCOPES = { read: "homerelay.read", plan: "homerelay.plan" } as const;
export const ALL_SCOPES = [SCOPES.read, SCOPES.plan];
export const OWNER_SUBJECT = "household-owner";

export interface OAuthClient { client_id: string; name?: string; redirect_uris: string[]; /** sha256 hex of the secret; absent = public client (PKCE only) */ client_secret_sha256?: string }
export interface OAuthConfig {
  /** Public base URL, e.g. https://homerelay.example.com (no trailing slash). The issuer and the resource derive from it. */
  baseUrl: string;
  clients: OAuthClient[];
  /** scrypt$<N>$<salt b64>$<hash b64>, created by `npm run remote:owner` */
  ownerPasswordHash: string;
  accessTtlSec?: number;
  refreshTtlSec?: number;
  now?: () => Date;
}

export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) { super(description); }
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Owner password hash format: scrypt$N$salt$hash (base64). */
export function hashPassword(password: string, N = 16384): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export interface AuthRequest { client: OAuthClient; redirect_uri: string; state: string | null; scope: string[]; code_challenge: string; resource: string }
export interface AccessGrant { subject: string; client_id: string; scope: string[]; resource: string; expires_at: string }

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private accessTtl: number; private refreshTtl: number; private now: () => Date;
  private failures: number[] = []; // timestamps of failed owner sign-ins (lockout)

  constructor(private db: Db, private cfg: OAuthConfig) {
    if (!/^https:\/\//.test(cfg.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.baseUrl)) throw new Error("REMOTE_BASE_URL must be https:// (http is accepted only for loopback testing)");
    if (!cfg.ownerPasswordHash.startsWith("scrypt$")) throw new Error("REMOTE_OWNER_PASSWORD_HASH is missing or not a scrypt hash; run npm run remote:owner");
    if (!cfg.clients.length) throw new Error("REMOTE_OAUTH_CLIENTS must list at least one client");
    this.issuer = cfg.baseUrl.replace(/\/$/, "");
    this.resource = `${this.issuer}/mcp`;
    this.accessTtl = cfg.accessTtlSec ?? 3600; this.refreshTtl = cfg.refreshTtlSec ?? 30 * 86400;
    this.now = cfg.now ?? (() => new Date());
  }
  private ts(offsetSec = 0) { return new Date(this.now().getTime() + offsetSec * 1000).toISOString(); }

  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: ALL_SCOPES, bearer_methods_supported: ["header"], resource_name: "HomeRelay" };
  }
  authorizationServerMetadata() {
    return {
      issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"], scopes_supported: ALL_SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** Validates an authorization request. Errors before the redirect URI is trusted are shown to the user, never redirected. */
  validateAuthorize(q: Record<string, string | undefined>): AuthRequest {
    const client = this.cfg.clients.find((c) => c.client_id === q.client_id);
    if (!client) throw new OAuthError("invalid_client", "Unknown client.");
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) throw new OAuthError("invalid_request", "The redirect URI is not registered for this client.");
    if (q.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
    if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (q.resource && q.resource.replace(/\/$/, "") !== this.resource) throw new OAuthError("invalid_target", "Unknown resource.");
    const requested = (q.scope ?? "").split(/\s+/).filter(Boolean);
    // openid and other scopes HomeRelay does not issue are ignored; at least one HomeRelay scope is required
    const scope = requested.length ? requested.filter((s) => (ALL_SCOPES as string[]).includes(s)) : [SCOPES.read];
    if (!scope.length) throw new OAuthError("invalid_scope", `Request at least one of: ${ALL_SCOPES.join(", ")}.`);
    return { client, redirect_uri: q.redirect_uri, state: q.state ?? null, scope, code_challenge: q.code_challenge, resource: this.resource };
  }

  /** Owner sign-in with a lockout: 5 failures in 15 minutes lock sign-in for the rest of that window. */
  signIn(password: string): boolean {
    const t = this.now().getTime();
    this.failures = this.failures.filter((x) => t - x < 15 * 60_000);
    if (this.failures.length >= 5) throw new OAuthError("temporarily_unavailable", "Too many failed sign-ins. Try again in 15 minutes.", 429);
    const ok = verifyPassword(password, this.cfg.ownerPasswordHash);
    if (!ok) this.failures.push(t);
    return ok;
  }

  issueCode(r: AuthRequest): string {
    const code = token();
    this.db.prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, subject, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(sha256(code), r.client.client_id, r.redirect_uri, r.code_challenge, r.scope.join(" "), r.resource, OWNER_SUBJECT, this.ts(60), this.ts());
    return code;
  }

  /** Client authentication: HTTP Basic or form credentials; public clients (no secret configured) send only client_id. */
  authenticateClient(authHeader: string | undefined, form: Record<string, string | undefined>): OAuthClient {
    let id = form.client_id; let secret = form.client_secret;
    if (authHeader?.startsWith("Basic ")) {
      const raw = Buffer.from(authHeader.slice(6), "base64").toString("utf8"); const i = raw.indexOf(":");
      if (i < 0) throw new OAuthError("invalid_client", "Malformed client credentials.", 401);
      id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1));
    }
    const client = this.cfg.clients.find((c) => c.client_id === id);
    if (!client) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    if (client.client_secret_sha256 && !(secret && safeEqual(sha256(secret), client.client_secret_sha256))) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    return client;
  }

  private issuePair(client_id: string, scope: string, resource: string, subject: string, family: string, codeHash: string | null) {
    const access = token(); const refresh = token();
    const ins = this.db.prepare("INSERT INTO oauth_tokens (token_hash, kind, family_id, code_hash, client_id, scope, resource, subject, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    ins.run(sha256(access), "access", family, codeHash, client_id, scope, resource, subject, this.ts(this.accessTtl), this.ts());
    ins.run(sha256(refresh), "refresh", family, codeHash, client_id, scope, resource, subject, this.ts(this.refreshTtl), this.ts());
    return { access_token: access, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refresh, scope };
  }
  private revokeFamily(family: string) { this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL").run(this.ts(), family); }

  exchange(client: OAuthClient, form: Record<string, string | undefined>) {
    // A detected replay must revoke and still fail. Throwing inside the transaction would roll the revocation back,
    // so the revocation commits first and the error is raised afterwards.
    const out = this.db.transaction((): ReturnType<OAuthServer["issuePair"]> | OAuthError => {
      if (form.grant_type === "authorization_code") {
        const h = sha256(form.code ?? "");
        const c = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash=?").get(h) as any;
        if (!c || c.client_id !== client.client_id) throw new OAuthError("invalid_grant", "The authorization code is invalid.");
        if (c.used_at) { // replay: revoke everything issued from this code
          for (const f of this.db.prepare("SELECT DISTINCT family_id FROM oauth_tokens WHERE code_hash=?").all(h) as { family_id: string }[]) this.revokeFamily(f.family_id);
          return new OAuthError("invalid_grant", "The authorization code was already used.");
        }
        if (c.expires_at <= this.ts()) throw new OAuthError("invalid_grant", "The authorization code has expired.");
        if (form.redirect_uri !== c.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
        if (!form.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier) || !safeEqual(pkceChallenge(form.code_verifier), c.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
        if (form.resource && form.resource.replace(/\/$/, "") !== c.resource) throw new OAuthError("invalid_target", "Unknown resource.");
        this.db.prepare("UPDATE oauth_codes SET used_at=? WHERE code_hash=?").run(this.ts(), h);
        return this.issuePair(client.client_id, c.scope, c.resource, c.subject, token(), h);
      }
      if (form.grant_type === "refresh_token") {
        const h = sha256(form.refresh_token ?? "");
        const r = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'").get(h) as any;
        if (!r || r.client_id !== client.client_id) throw new OAuthError("invalid_grant", "The refresh token is invalid.");
        if (r.replaced_at) { this.revokeFamily(r.family_id); return new OAuthError("invalid_grant", "The refresh token was already used; the session has been revoked."); }
        if (r.revoked_at || r.expires_at <= this.ts()) throw new OAuthError("invalid_grant", "The refresh token is revoked or expired.");
        const granted: string[] = r.scope.split(" ");
        const requested = (form.scope ?? "").split(/\s+/).filter(Boolean);
        if (requested.some((s) => !granted.includes(s))) throw new OAuthError("invalid_scope", "A refresh cannot add scopes.");
        this.db.prepare("UPDATE oauth_tokens SET replaced_at=? WHERE token_hash=?").run(this.ts(), h);
        // the old access token of this family stops working once it is rotated
        this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE family_id=? AND kind='access' AND revoked_at IS NULL").run(this.ts(), r.family_id);
        return this.issuePair(client.client_id, (requested.length ? requested : granted).join(" "), r.resource, r.subject, r.family_id, r.code_hash);
      }
      throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    })();
    if (out instanceof OAuthError) throw out;
    return out;
  }

  revoke(client: OAuthClient, value: string) {
    const r = this.db.prepare("SELECT family_id, client_id FROM oauth_tokens WHERE token_hash=?").get(sha256(value)) as { family_id: string; client_id: string } | undefined;
    if (r && r.client_id === client.client_id) this.revokeFamily(r.family_id); // RFC 7009: unknown tokens are not an error
  }

  /** Owner action (incident response, secret rotation): revoke every outstanding code and token. Returns how many tokens. */
  revokeAll(): number {
    this.db.prepare("UPDATE oauth_codes SET used_at=? WHERE used_at IS NULL").run(this.ts());
    return this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE revoked_at IS NULL").run(this.ts()).changes;
  }

  /** Validates a bearer access token for this resource; returns the grant or null. */
  verifyAccess(bearer: string): AccessGrant | null {
    if (!bearer) return null;
    const r = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='access'").get(sha256(bearer)) as any;
    if (!r || r.revoked_at || r.expires_at <= this.ts() || r.resource !== this.resource || r.subject !== OWNER_SUBJECT) return null;
    return { subject: r.subject, client_id: r.client_id, scope: r.scope.split(" "), resource: r.resource, expires_at: r.expires_at };
  }

  /** Removes expired codes and long-expired tokens (keeps rows needed for replay detection for a day). */
  prune() {
    const day = new Date(this.now().getTime() - 86400_000).toISOString();
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(day);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(day);
  }
}
