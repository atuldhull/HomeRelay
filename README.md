# HomeRelay

An AI household-coordination agent. You tell it what is happening ("a package arrives at 5 but I'm in a meeting until 6", "the plumber is coming between 2 and 4"); it saves a persistent **situation**, proposes a plan, waits for your approval, creates and tracks tasks, **replans when your day changes**, keeps the household's **documents** (receipts, warranties, manuals) next to the situations and tasks they belong to, manages standalone **household tasks** with dependencies and repeats, shows how everything is connected on **Relay Map**, and keeps an accurate activity log.

Built for the **Alexa+ track** of the Build, Ship, Shape: Amazon Developer Hackathon. The core is a real, self-hosted **MCP server over Streamable HTTP** (spec `2025-11-25`), demonstrated through its own web UI.

> **Honest scope.** There is no live Alexa+ device, Ring, courier, calendar or notification integration ([where Alexa+ stands](docs/ALEXA_PLUS_INTEGRATION.md)). The delivery event is *simulated* and labelled. Reminders are in-app tasks with a due time. HomeRelay never claims it contacted anyone or verified a real-world event. It is a single-user local prototype: the app itself has no authentication, so do not expose it to a network. The only part built for remote access is the opt-in, OAuth-protected **remote profile** for Alexa+ (off by default; tested locally, not deployed; [ledger](docs/ALEXA_PLUS_COMPLETION_LEDGER.md)).

## Quick start

Requires Node 22+. No API key needed.

```bash
npm install
cp .env.example .env            # then set APPROVAL_SECRET (a 16+ character random string)
npm run dev                     # MCP server :3001, API :3000, web :5173
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

Open http://localhost:5173 and click **Simulate delivery event**. The left rail (a bottom bar on phones) has Home (with **HomeRelay Pulse**), Situations, Documents, Tasks, Map, Activity and Assistant. **Ctrl+K** (Cmd+K on a Mac) opens search and commands from anywhere. The assistant opens as a drawer with **Ask about this situation**, **Ask HomeRelay** (rail, or Ctrl+K) or the ask bar on Home, and as a full page under **Assistant**. Each situation and each document has its own conversation. Then:

1. `I'm working until 6 PM and nobody else is home. Help me manage it.` → a plan is *proposed*; nothing is saved yet. Open **Why this plan**.
2. Approve it. Tasks appear.
3. `My meeting has been extended until 7 PM` → a *reschedule* of the same tasks is proposed. Approve.
4. Reload: everything persists.
5. `I collected the package` → recorded from your word, not verified with the courier.

Documents: run `npm run demo:files` to write sample files to `.data/demo-files/`, upload them on **Documents**, search for `serial`, open the warranty, then attach it from the situation page (**Attach existing**) or ask `Attach the washer warranty`. Ask `Which documents are attached to this situation?` or, from Home, `Find my receipts`. See [docs/DOCUMENT_VAULT.md](docs/DOCUMENT_VAULT.md).

Tasks and connections: on **Tasks**, create a household task, make another one **Must happen after** it, attach a document, and open **Map** to see the links. Ask `What's on my plate today?`, `Which tasks are blocked?`, `Show me everything connected to this` (on a situation or task), `Remind me to buy a water filter tomorrow at 6 pm`, or `Mark buy a water filter as done`.

Other things to try: `The plumber is coming tomorrow between 2 PM and 4 PM, but I might not get home until 3 PM.`, `My parents arrive tomorrow evening. Help me prepare.`, `What needs attention today?`, or **New situation** on the dashboard.

## Scenarios

One planner, data-driven definitions (`apps/mcp-server/src/scenarios.ts`): **delivery**, **maintenance appointment**, **family visit**, **general**. See [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start MCP server, API and web together |
| `npm run dev:mcp` / `dev:api` / `dev:web` | Start one service |
| `npm run stop` | Stop **only** this repo's Node processes (never other Node processes) |
| `npm test` | 245 unit + integration tests in 15 files, including the 36-scenario agent evaluation and 26 remote-profile/OAuth tests |
| `npm run test:mcp:smoke` | Real MCP client ↔ real MCP server over HTTP |
| `npm run eval` | 36-scenario agent evaluation (each checks the database, not just the reply); report in `test-results/agent-eval-report.md` |
| `npm run test:e2e` | 28 browser tests in your installed Chrome, isolated stack on ports 5273/3100/3101 with its own database and document folder (wiped at the start of each run); screenshots go to `artifacts/homerelay-v3/`, `artifacts/homerelay-v4/` and `artifacts/homerelay-v5-ui-review/` |
| `npm run test:soak -- --hours 24` | Endurance test on its own servers (ports 3200/3201), database and folder under `.data/soak/<run>/`; never touches your data. `--minutes N` for a short run, `npm run test:soak:stop` to stop early. Results: `summary.json`, `metrics.jsonl` |
| `npm run typecheck` / `npm run lint` | TypeScript checks for all apps |
| `npm run build` | Typecheck + production web build |
| `npm run test:soak:status` | Reports the newest soak run; a run whose process was killed (reboot, sleep) is shown as interrupted, not running |
| `npm run bench` | Local latency measurements on a throwaway database (fails if any timed request errors) |
| `npm run build` then `npm run preview:web` | Serve the production build (with a strict Content-Security-Policy) instead of the dev server; the API and MCP server must be running |
| `npm run demo:reset` | Remove only simulated (demo) data (MCP server must be running) |
| `npm run start:remote` | The opt-in remote profile (OAuth-protected MCP for Alexa+) on 127.0.0.1:3002; see [Remote access](#remote-access-alexa) |
| `npm run remote:owner` / `remote:client -- <uri>` / `remote:revoke-all` | Create the owner password hash or an OAuth client (written to a git-ignored file, never printed), or revoke every linked session |
| `npm run verify:remote -- <base> run <state>` | End-to-end check of a running remote profile from outside (sign-in, tokens, tools, refusals) |
| `npm run test:soak:remote -- <base> --minutes N` | Endurance test of a running remote profile over its real OAuth lifecycle |
| `npm run backup` / `npm run restore -- <dir>` | Online SQLite snapshot with an integrity check, plus documents; restore moves the current files aside, never deletes them |
| `npm run brand:render` | Render the add-on icons, carousel and banner from `assets/brand/src` and check their dimensions |
| `npm run demo:files` | Write sample documents (PDF, text, Markdown, image) to `.data/demo-files/` for uploading |

## Architecture

```
Web UI (React) ──HTTP──▶ API + agent (MCP client) ──MCP Streamable HTTP──▶ MCP server ──▶ SQLite
```

- **The MCP server owns all domain logic and data:** 34 tools (situations and plans, household tasks, documents, and connected-record tools: `search_household`, `get_connections`, `get_household_map`), a workflow-catalog resource, a situation resource template and a planning prompt. File bytes travel through a separate secret-guarded endpoint; no MCP tool accepts a file path.
- **The API never touches the database.** Every read and write goes through its MCP client; the "MCP tool activity" panel shows those real calls.
- **Approval is enforced, not requested.** `approve_plan`, `reject_plan`, `reset_demo_data`, `delete_document` and `delete_task` need a service secret and are never offered to the language model. See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for what that does and does not protect.
- **Two agents, same tools.** The default *rules agent* needs no key. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` for the LLM agent (default model `claude-opus-5-5`, override with `ANTHROPIC_MODEL`); if the provider fails it falls back to the rules agent. The LLM mode has not been run against a live key. Document contents are **not** offered to the LLM unless `LLM_DOCUMENT_ACCESS=true`.
- **One conversation per situation.** The assistant drawer is bound to the open situation by its ID and states "Working on: …"; a conversation is never shown against a different situation.
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), decisions: [docs/DECISIONS.md](docs/DECISIONS.md).

Screenshots: v2.5 in [docs/screenshots/](docs/screenshots/); v3 and v4 are regenerated by `npm run test:e2e` into `artifacts/homerelay-v3/` and `artifacts/homerelay-v4/` (git-ignored).

## Remote access (Alexa+)

The household app is local-only. The **remote profile** is a separate, opt-in process that exposes 10 least-privilege tools over OAuth 2.1 (authorization code + PKCE) for an Alexa+ add-on. Remote clients can read situations and tasks, record what you said and draft plans. They can never approve, delete or read documents. The process also serves `/privacy`, `/terms` and the add-on images. It runs in a hardened container behind a TLS proxy:

```bash
cp deploy/remote.env.example deploy/remote.env       # then fill it in (see docs/DEPLOYMENT.md)
docker compose -f deploy/docker-compose.yml up -d --build
```

- Deployment, TLS, backups, rollback, secret rotation, incident response: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- How it maps to Amazon's requirements: [docs/ALEXA_PLUS_INTEGRATION.md](docs/ALEXA_PLUS_INTEGRATION.md)
- Requesting Amazon developer access, and the exact steps after approval: [docs/AMAZON_ACCESS_REQUEST.md](docs/AMAZON_ACCESS_REQUEST.md)
- What is verified and what is still blocked: [docs/ALEXA_PLUS_COMPLETION_LEDGER.md](docs/ALEXA_PLUS_COMPLETION_LEDGER.md)

**Not connected to Alexa+ yet.** That needs Amazon's approval and a public domain. Everything up to that point has been tested locally, including over HTTPS.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `APPROVAL_SECRET must be set` at startup | Copy `.env.example` to `.env` and set a 16+ character secret. |
| `port 3000/3001/5173 is in use` | Set `API_PORT`, `MCP_PORT` or `WEB_PORT` in `.env`; or `npm run stop` if it is a leftover HomeRelay process. |
| The page loads but shows "Cannot reach the HomeRelay server" | The API is not running. Run `npm run dev`; check the terminal for errors. |
| Banner says the tool server is unavailable (503) | The MCP server is down; nothing was changed. Restart `npm run dev:mcp`. |
| `APP_TIMEZONE ... is not a valid IANA time zone` | Use a name like `Asia/Kolkata`. Times display in this zone; stored instants are UTC. |
| `npm run test:e2e` cannot start Chrome | Install Google Chrome (the config uses `channel: "chrome"`) or install Playwright's browser and change the channel. |
| LLM mode seems inactive | It needs `LLM_PROVIDER=anthropic` **and** `ANTHROPIC_API_KEY`. The sidebar shows the active agent. If the provider errors, replies say the rules agent answered instead. |
| Stale or strange data in development | Delete `.data/homerelay.db*` and `.data/documents/` while the servers are stopped (this removes **all** your local data), or use **Reset demo** for demo data only. |
| An upload is refused | The message says why: over `DOCUMENT_MAX_MB`, the vault is full (`DOCUMENT_STORAGE_MAX_MB`, default 2048), not a PDF/PNG/JPEG/TXT/Markdown file by content, or an exact duplicate of a stored document. Nothing was saved. |
| A PDF shows "No text" or "Unreadable" | It is a scan (no OCR) or damaged. It is still stored; add a title, tags or description to make it searchable. |
| Remote profile: sign-in always says the password is wrong (in Docker) | The `REMOTE_OWNER_PASSWORD_HASH` line in `deploy/remote.env` must keep its single quotes; Compose expands `$` in unquoted values. |
| Remote profile exits at start | It prints the reason: the profile is disabled, the hash or clients are missing, or `REMOTE_BASE_URL` is not https (http is allowed only for loopback). |
| `docker build` fails with `lookup production.cloudfront.docker.com: no such host` | Docker Desktop's DNS right after start: `docker pull node:22.19.0-bookworm-slim`, then build again. |
| Need to stop everything on Windows | `npm run stop`. Do not use `taskkill /IM node.exe`: it kills every Node process on the machine. |

## Layout

```
apps/mcp-server   MCP server, domain rules, scenarios, planner, SQLite
apps/api          HTTP API, MCP client gateway, security guards, exports, rules + LLM agents
apps/web          React + Vite UI
packages/shared   Types, constants, timezone helpers
tests/            vitest suites, tests/eval (agent evaluation), tests/e2e (Playwright)
scripts/          env loader, demo reset, benchmark, safe stop
docs/             spec, architecture, security review, test plan, decisions, demo script, submission drafts
```

## Status and limitations

Single-user and local-only: no end-user authentication on the app, so never expose its ports. The remote profile (`npm run start:remote`, port 3002) is the one exception, and only behind TLS as described in [ALEXA_PLUS_INTEGRATION.md](docs/ALEXA_PLUS_INTEGRATION.md). The production build is served with a strict CSP; the dev server has none. No OCR; no LICENSE chosen yet; live LLM behaviour unverified; the remote profile is tested in Docker and over local HTTPS but not on a public host, and HomeRelay has not been tested with Alexa+ (it needs Amazon developer access).
