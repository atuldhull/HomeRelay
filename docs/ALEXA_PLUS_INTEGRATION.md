# Alexa+ integration: where HomeRelay stands

**Short version:** HomeRelay now has an opt-in **remote profile**, an OAuth-protected MCP endpoint built to the shape Amazon documents for Alexa+ account linking. It is implemented and tested locally, including a real MCP client calling tools with a bearer token obtained through the full authorization-code + PKCE flow. It is **not** connected to Alexa+. That needs Amazon developer onboarding (which this project does not have), a public HTTPS host and domain, and published privacy and terms pages. Nothing in the product or these docs claims that Alexa+ controls HomeRelay. Progress item by item: [ALEXA_PLUS_COMPLETION_LEDGER.md](ALEXA_PLUS_COMPLETION_LEDGER.md).

Sources, read on 2026-10-22 (re-check them before acting):
- [Alexa+ MCP Toolkit Overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html)
- [Alexa+ MCP QuickStart Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html) and the Alexa AI CLI setup it links to
- [Alexa+ MCP Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)
- [Build Alexa+ Add-ons: Development Stages](https://developer.amazon.com/docs/alexaplus/add-ons/alexa-plus-add-on-development-stages.html)
- [MCP add-on tools, schema and data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design)
- [Alexa+ for Builders](https://developer.amazon.com/alexaplus/)

## Three states, kept apart

| State | Meaning | HomeRelay |
|---|---|---|
| **A: Local MCP server** | Real tools and persisted state, used by HomeRelay's own API and web UI | Done, tested. |
| **B: Alexa+-ready** | Meets the documented add-on requirements and has an add-on package, but not deployed to Alexa+ | **Partly reached.** The endpoint, OAuth and tool profile are built and tested locally. Hosting, the add-on package assets and Amazon access are still missing (see the ledger). |
| **C: Live on Alexa+** | Deployed with the Alexa AI CLI and invoked from a linked device or the simulator, with the results recorded | **Not claimed.** Blocked on Amazon onboarding. |

## The remote profile (what was built)

`npm run start:remote` (or `deploy/docker-compose.yml`) starts a **separate process** next to the local servers. It shares the SQLite database (WAL mode), binds to `127.0.0.1:3002`, and refuses to start unless `REMOTE_PROFILE_ENABLED=true` and an owner password hash and at least one OAuth client are configured.

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `/…/mcp`) | Protected-resource metadata: `resource` = `<REMOTE_BASE_URL>/mcp`, `authorization_servers` = [`<REMOTE_BASE_URL>`], `scopes_supported` |
| `GET /.well-known/oauth-authorization-server` | AS metadata: `code` only, `S256` only, `authorization_code` + `refresh_token`, no registration endpoint |
| `GET/POST /oauth/authorize` | The household owner signs in and consents (CSRF-protected form, strict CSP, lockout after 5 wrong passwords in 15 minutes). Redirects with `code`, `state`, `iss`. |
| `POST /oauth/token`, `POST /oauth/revoke` | Code exchange (client secret + PKCE verifier), refresh rotation, revocation |
| `POST /mcp` | Streamable HTTP MCP, bearer token required: 401 without a valid token, 403 without a HomeRelay scope |
| `GET /health`, `GET /ready` | Liveness and database readiness |

**Tools reachable remotely** depend on the token's scopes:

| Scope | Tools |
|---|---|
| `homerelay.read` | `get_workload_summary`, `list_open_situations`, `get_situation`, `list_tasks`, `get_task`, `get_connections`, `search_household` (situations and tasks only) |
| `homerelay.plan` | `create_situation`, `set_constraints`, `propose_plan` |

Never remote: `approve_plan`, `reject_plan`, every delete, `reset_demo_data`, task edits, and all document tools (no document contents). Every remote write is recorded with actor `agent` whatever the client claims. `propose_plan` only saves a proposal, and approval stays in the HomeRelay app. A spoken "yes" or anything a model generates cannot approve a plan, because no remote tool can approve.

### How it maps to Amazon's account-linking requirements

| Requirement (official docs, paraphrased) | HomeRelay remote profile | Evidence |
|---|---|---|
| Streamable HTTP, MCP spec 2025-11-25 | Same transport and SDK as the local server | `tests/remote-oauth.test.ts` (official SDK client) |
| Protected-resource metadata with `resource` matching the MCP URL, `authorization_servers` (first is used), `scopes_supported` | Served at both well-known paths | test "serves protected-resource metadata…" |
| Authorization code grant with PKCE S256 required | Only `code` + `S256` accepted; challenge format checked; verifier checked at the token endpoint | tests "wrong PKCE verifier…", "missing PKCE…" |
| Static client registration, no DCR | Clients come from `REMOTE_OAUTH_CLIENTS`; no registration endpoint | metadata test |
| `resource` sent on authorize and token requests (not on refresh) | Validated when present on authorize and token; refresh keeps the original binding | full-flow test |
| A refresh token returned with every access token | Every token response has a new refresh token (rotation) | rotation test |
| 401/403 for tool calls without a valid token | 401 (missing/invalid/expired/revoked/wrong resource), 403 (no HomeRelay scope) | bearer tests |
| Redirect URIs come from the Alexa+ Developer Hub | Exact-match allowlist per client; unregistered URIs get an error page, never a redirect | redirect tests |
| Alexa caches auth metadata at deploy time | Changing `REMOTE_BASE_URL` or scopes means redeploying the add-on | documented here |
| Responses under 500 ms | Locally ~9–25 ms; must be re-measured through the real host | not yet measured remotely |

### Identity model, and its limit

HomeRelay is a **single-household** app. The remote profile has exactly one subject, the household owner, who proves it with the owner password (stored only as a scrypt hash). This is a real authorization server for that one owner, not a multi-user identity provider. HomeRelay does **not** claim multi-user or multi-tenant readiness: there is one database and no per-user isolation. `APPROVAL_SECRET` plays no part in remote identity.

## Setup (no secrets ever printed)

1. `HOMERELAY_OWNER_PASSWORD=… npm run remote:owner`, with the variable set in that shell only. This writes the hash to `.data/remote-secrets/owner.env` (git-ignored).
2. `npm run remote:client -- <redirect URI from the Alexa+ Developer Hub>`. This writes the client id, client secret and the `REMOTE_OAUTH_CLIENTS` entry (which holds only the secret's SHA-256) to `.data/remote-secrets/`.
3. Copy the values into `.env`, set `REMOTE_BASE_URL=https://<your domain>` and `REMOTE_PROFILE_ENABLED=true`, then delete the files in `.data/remote-secrets/`.
4. Put a TLS reverse proxy in front (`deploy/Caddyfile.example`) that forwards only `/mcp`, `/oauth/*`, `/.well-known/*`, `/health` and `/ready`.
5. Back up with `npm run backup` (online SQLite snapshot with an integrity check, plus the document files).

## What still blocks State B and C (outside this repository)

| Blocker | Why it cannot be done from here |
|---|---|
| Amazon onboarding | The Alexa AI CLI (`@alexa-ai/cli`) is distributed from a private registry. Access needs an AWS account that an Alexa Solutions Architect has allowlisted to assume Amazon's developer-tools role. `npm view @alexa-ai/cli` returns E404 on the public registry (checked 2026-10-22). |
| CLI platform | The setup page lists macOS and Ubuntu with Node 24+. This machine is Windows with Node 22, but its WSL `Ubuntu-24.04` distro is a supported OS; the setup steps are in [AMAZON_ACCESS_REQUEST.md](AMAZON_ACCESS_REQUEST.md). |
| Public HTTPS host and domain | Needs the owner's authorization, a domain and possibly paid hosting. The container and TLS proxy are built and verified locally ([DEPLOYMENT.md](DEPLOYMENT.md)). Nothing was deployed publicly and no tunnel was opened. |
| Add-on package | The store listing, privacy and terms pages (served at `/privacy` and `/terms`), icons in all six sizes, carousel and banner are built ([ALEXA_ADDON_WORKSHEET.md](ALEXA_ADDON_WORKSHEET.md)). Still missing: the operator details on the legal pages, legal review, and the domain for their URLs. `addon.json` itself is generated by the official CLI, so it is not hand-written. |
| Redirect URIs | Issued by the Alexa+ Developer Hub; they are needed for `npm run remote:client`. |
| Real invocation | Needs deployment, then a linked device or the web simulator (console login required). |

## Tool design checked against Amazon's guidance (v4)

| Guidance (paraphrased) | HomeRelay |
|---|---|
| "Design each tool to represent one meaningful customer intent"; avoid overlap | 34 tools locally, 10 in the remote profile, with descriptions rewritten so they promise only what the remote profile does |
| "Treat your schema as a promise" | Every declared parameter is implemented; contract-tested with a real MCP client |
| Consistent output schemas | `outputSchema` declared for `search_household`, `get_connections`, `get_household_map`; not yet for the others |
| Always return a response | Empty results include a short `message` |
| Payload hygiene | Only HomeRelay's own records; no tracking parameters or third-party links |

## How to describe HomeRelay in a submission

> A self-hosted MCP server (Streamable HTTP, spec 2025-11-25) for household coordination, with an OAuth-protected remote profile built to the Alexa+ account-linking requirements. It has not yet been deployed to or tested with Alexa+.

Do not use Alexa logos or imply endorsement.
