# Security review

Reviewed against the code on branch `upgrade/homerelay-v2`, extended for the v3 document vault on `upgrade/homerelay-v3-product`. Each protection names the test that verifies it.

## Operating assumptions (read first)

HomeRelay is a **local, single-user prototype**. All services bind to `127.0.0.1`. There is **no end-user authentication**: the person at the browser *is* the user. Do not expose any of these ports to a network or deploy publicly without adding real authentication, TLS and a reviewed session model. This review does not claim the app is safe for that.

## What the "approval token" actually is

`APPROVAL_SECRET` is a **service-to-service shared secret** between the API process and the MCP server. It is never sent to the browser (`tests/security.test.ts` scans `apps/web/src` and any built bundle for it, and checks API responses and the trace). Its job is narrow: it stops a **language model** (or any MCP client that lacks the secret) from calling `approve_plan`, `reject_plan` or `reset_demo_data`.

It is **not** proof that a human clicked. What stops other websites and scripts from driving the API's approve endpoint is the browser-origin protection below. A local process that can reach `127.0.0.1:3000` can still call the API, which is within the single-user trust assumption.

## Threats and protections

| Threat | Protection | Verified by | Residual risk |
|---|---|---|---|
| A malicious web page makes the user's browser POST to the local API (CSRF) | Mutations need a custom `X-HomeRelay-Client` header (forces a CORS preflight a foreign origin cannot pass), `Content-Type: application/json` (blocks the `text/plain` simple-request trick), and `Origin` / `Sec-Fetch-Site` checks | `security.test.ts`: missing header 403, `text/plain` 415, foreign Origin 403, cross-site 403, no CORS grant on preflight | Local non-browser processes are trusted |
| DNS rebinding to reach the local API or MCP server | Host allow-list (`localhost`, `127.0.0.1`, `[::1]`) on both services; MCP also checks `Origin` | `security.test.ts` (API and MCP) | None known |
| LLM approves, rejects or resets by itself | Those tools are never offered to the model; the server requires the secret; the model's `confirmed_by_user`, `actor`, `source` are overwritten by policy; unknown tools get an error | `llm-agent.test.ts`, `agent-eval.test.ts` #16 | The model can still *propose* plans and create tasks (reversible, audited) |
| Model claims the user confirmed completion | `confirmed_by_user` is derived from the user's own message by a conservative keyword check, ignoring the model | `llm-agent.test.ts` | A user message containing "done" counts as confirmation |
| Malformed or hostile model tool output | Non-object tool input rejected before reaching the server; schema validation on the MCP side; max 6 iterations and 12 tool calls; results capped at 12,000 characters | `llm-agent.test.ts` | Prompt injection via stored situation text could mislead the model; consequences are limited to proposals and reversible tasks |
| SQL injection | Bound parameters everywhere; only `IN (?,?,…)` placeholder lists are built dynamically | Code review (no string-built user input) | None known |
| CSV formula injection in exports | Cells starting with `= + - @` tab or CR are prefixed with `'` | `api-v2.test.ts` | None known |
| Markdown injection in the report | Markdown control characters escaped in user text | `api-v2.test.ts` | None known |
| XSS | React escaping; no `dangerouslySetInnerHTML` / `innerHTML` anywhere in `apps/web/src` (grep: 0) | Grep at review time | **No Content-Security-Policy is set** on the Vite-served pages |
| Oversized or abusive requests | 64 KB JSON body (413), zod validation on every route, chat limited to 60 requests/minute, exports capped (1000 tasks / 500 events), tool argument bounds | `security.test.ts`, `api-v2.test.ts` | Limiter is in-memory and per process |
| Secret leakage | `.env` and databases git-ignored; `.env.example` has empty placeholders; request log omits bodies; LLM failure log records only the error class; trace redacts `token`/`secret`/`key` arguments | `security.test.ts` (git tracking, `.env.example`), `api.test.ts` | Secrets live in a plain `.env` file |
| Demo reset deletes real data | Deletes only `source='demo'` rows and `scope='demo'` preferences; needs the secret, a confirmation header, and is audited (`demo_reset`) | `domain.test.ts`, `api.test.ts`, `agent-eval.test.ts` #18 | None known |
| Invalid configuration | `APPROVAL_SECRET` must be ≥ 16 characters; `APP_TIMEZONE` validated at startup | `security.test.ts` | None |
| Uploaded file is not what it claims (e.g. HTML renamed `.pdf`) | Type from content signatures; only PDF/PNG/JPEG/UTF-8 text accepted; declared MIME must be compatible | `documents.test.ts`, `api-documents.test.ts` | Polyglot files that are valid PDFs are still served as PDFs |
| Stored file served back executes script | `nosniff`; non-PDF content gets `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`; text served as `text/plain`; `Cross-Origin-Resource-Policy: same-origin` | `api-documents.test.ts` | PDFs render in the browser's own viewer |
| Path traversal or reading arbitrary files | No MCP tool takes a path; storage names are random UUIDs; a non-UUID storage key is refused; the original name is metadata only | `documents.test.ts` (tampered key) | None known |
| Oversized or flooding uploads | `DOCUMENT_MAX_MB` enforced by the API body parser (413) and again by the server; upload route only accepts `application/octet-stream` with the client header | `api-documents.test.ts`, `documents.test.ts` | No per-user quota or total-disk limit |
| Prompt injection inside a document | Extracted text is data: the LLM system prompt says so; content tools are withheld from the LLM unless `LLM_DOCUMENT_ACCESS=true`; the rules agent never executes text | `api-documents.test.ts` (injection document) | A live model was not tested |
| Document contents leaving the machine | No external calls by default; the LLM gets metadata tools only unless explicitly allowed | `api-documents.test.ts` (privacy gate) | With the flag on, contents go to the configured provider |
| Accidental deletion | Two-step UI confirmation, a confirmation header, the service secret, and `document_deleted` events in each linked situation | `api-documents.test.ts`, e2e | Deletion removes the file permanently (no trash) |
| Task deletion by a model or a forged request (v4) | `delete_task` needs the service secret (never given to the LLM) and the API route needs a confirmation header; history stays in the activity log | `api-household.test.ts` (no header 400, wrong token UNAUTHORIZED) | Deletion is permanent |
| Typed approval in chat (v4) | The rules agent no longer approves on "yes"; approval is only the plan card's user action | `agent-eval.test.ts` #31 | None known |
| Unbounded or cyclic task graphs (v4) | One prerequisite per task, self-dependency CHECK, cycle walk on every change, integrity self-check used by tests and the soak run | `v4-connected.test.ts` | None known |
| Search terms reaching SQL (v4) | Household search and task filters use bound LIKE parameters built from letter/number tokens only | `v4-connected.test.ts` (`%` search) | None known |
| Document snippets reaching an external model (v4) | `search_household` (returns snippets) is withheld from the LLM with the other content tools unless `LLM_DOCUMENT_ACCESS=true` | `llm.ts` `DOCUMENT_CONTENT_TOOLS` | With the flag on, snippets go to the provider |
| Search query syntax injection (FTS5) | Queries are reduced to letter/number tokens, each quoted | `documents.test.ts` | None known |
| Vulnerable dependencies | `npm audit`: 0 vulnerabilities at review time | `npm audit` | Re-run before release |

## Defects this review found and fixed

1. An oversized request body returned a generic 500 instead of 413 (found by a new test).
2. The MCP SDK's argument-validation errors were reported by the API as a vague `BAD_RESPONSE` 500 instead of `INVALID_INPUT` 400.
3. Before this review the API had no browser-origin protection (see CSRF row above); an attacker who knew a proposal id could have approved it from a web page.

## Release hardening review (2026-10-22)

Scope: every API route, MCP tool, internal file endpoint, upload path, the built web app's headers, and race conditions on approvals, uploads, recurrence and reset. Trust model unchanged: one local user, services bound to 127.0.0.1, `APPROVAL_SECRET` is service-to-service only.

| Finding | Severity | Status | Test |
|---|---|---|---|
| Concurrent identical uploads produced an internal error instead of `DUPLICATE` | Low (no data loss; file cleaned up) | Fixed: checks repeated inside the write transaction | `documents.test.ts` |
| A pending plan could be approved after its situation was resolved, creating tasks in a closed situation | Medium (integrity) | Fixed: resolution supersedes pending plans; approval refuses resolved situations | `domain.test.ts` |
| Unbounded total document storage (disk exhaustion) | Medium (availability) | Fixed: `DOCUMENT_STORAGE_MAX_MB` quota, `STORAGE_FULL` 507 | `documents.test.ts` |
| No Content-Security-Policy on the app pages | Medium (defence in depth against XSS) | Fixed for the production build (`vite preview` headers: strict CSP, nosniff, no-referrer, permissions policy). The dev server stays without CSP because Vite's hot-reload preamble is inline. | verified in Chrome (no violations) |
| Recurrence duplicates on retry/restart | — | Already prevented (`recurrence_of` UNIQUE); re-verified | `v4-connected.test.ts` |
| Double approval | — | Already idempotent (`already_applied`); re-verified | `domain.test.ts`, 5-v4 C |
| `npm audit` | — | 0 vulnerabilities on 2026-10-22 | — |

Residual: no end-user authentication or multi-user isolation (by design for a local app); unencrypted data at rest; no malware scanning of uploads; the dev server has no CSP; a live LLM was not tested.

## Known limitations

- No authentication, authorization levels or multi-user separation.
- Data at rest is an unencrypted SQLite file and unencrypted document files in `.data/documents`.
- No malware scanning of uploads.
- The local servers (3000, 3001, 5173) remain loopback-only and unauthenticated. Remote access exists only through the separate remote profile below.

## Remote profile (OAuth, added after the soak started; not soak-tested)

- **Off by default.** It refuses to start without `REMOTE_PROFILE_ENABLED=true`, a scrypt owner-password hash and at least one static client. It binds to 127.0.0.1 and has its own Host allowlist (the public host and loopback only).
- **Authorization server for one owner.** It supports authorization code + PKCE S256 only, with an exact redirect-URI match. Codes are single-use, live 60 s, and a replay revokes every token issued from that code. Refresh tokens rotate, and reuse revokes the whole family. Access tokens are bound to `<base>/mcp` and live 1 h. Only SHA-256 hashes of codes, tokens and client secrets are stored.
- **Sign-in page.** CSRF double-submit (an HttpOnly SameSite=Strict cookie plus a hidden field), with requests held server-side for 10 min. CSP `default-src 'none'` with `form-action` limited to self and the registered redirect origin, and `frame-ancestors 'none'`. 5 wrong passwords lock sign-in for 15 min. Per-IP rate limits apply (`X-Forwarded-For` only with `REMOTE_TRUST_PROXY`).
- **Least privilege.** 10 tools (read, plus create/constraints/propose). No approval, rejection, deletion, demo reset or document access. The actor is forced to `agent`. A remote client can only draft plans, and approval stays in the app. `APPROVAL_SECRET` is not used for identity, and the remote process generates a random one per request that never leaves it.
- **Bugs found by the new tests and fixed:** (1) code-replay and refresh-reuse revocations were rolled back together with the error they raised; (2) a remote search asking only for documents fell back to searching every type, documents included.
- **Container** (`deploy/`, verified 2026-10-22). It runs as non-root uid 1000 with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges` and an init process. It publishes only on 127.0.0.1. Configuration comes at run time from `deploy/remote.env` (git-ignored), and no secret is in the image (`docker image inspect` shows only paths and ports). The container never receives `APPROVAL_SECRET` or the LLM key. SIGTERM triggers a graceful close that checkpoints the WAL.
- **Proxy** (Caddy). TLS with HSTS, a 1 MB request-body cap, and a path allowlist: only remote-profile paths are forwarded, everything else gets a 404. Verified over HTTPS with certificate verification on: an untrusted CA was refused, and the consent cookie was `Secure; HttpOnly; SameSite=Strict`.
- **Public pages and assets.** `/privacy` and `/terms` have no scripts and `default-src 'none'`. `/assets/addon/` serves only `[a-z0-9-]+.png` from one folder (traversal attempts return 404).
- **Logs.** One line per request with method, path without query, status and duration. Tests and a full container run confirmed that no token, code, state, password or client secret appears in the logs.
- **Owner kill switch.** `remote:revoke-all` (or `remote-setup.js revoke-all` in the container) invalidates every code and token at once.
- **Found while containerising:** Docker Compose expands `$` in unquoted `env_file` values, which silently corrupted the scrypt hash (`scrypt$N$salt$hash`) and made every sign-in fail. `remote:owner` now writes the value single-quoted, and the template and troubleshooting explain why.
- **Limits:** single household only, with no multi-user identity or tenant isolation. In-memory lockout and rate-limit state resets on restart. Not yet tested against Amazon's real OAuth client.
- No HTTPS (local only). CSP applies to the production build served by `vite preview`, not to the dev server.
- Single process rate limiting.
- Live LLM behaviour is unverified (no key was available), so prompt-injection resistance of a real model is untested.
