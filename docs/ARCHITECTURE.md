# Architecture

## Components

| Component | Path | Responsibility |
|---|---|---|
| Web UI | `apps/web` | App shell with Home, Situations, Documents, Tasks, Activity and Assistant workspaces; intake dialog, situation detail, document vault, approvals, MCP trace. Talks only to the API. |
| API + agents | `apps/api` | Validates requests, browser-origin protection, runs the agent, holds the **only** MCP client (`gateway.ts`), exports. |
| MCP server | `apps/mcp-server` | Tools, resources, prompt; business rules, scenarios, planner, state transitions; document storage, extraction and search (`documents.ts`); owns SQLite and the document folder. |
| Shared | `packages/shared` | Types, status vocabularies, task transition table, timezone helpers (cached formatters). |

```
Web UI ──HTTP──▶ API (+ rules/LLM agent, MCP client) ──MCP Streamable HTTP──▶ MCP server ──▶ SQLite
```

## MCP server (`apps/mcp-server`)

Stateless Streamable HTTP, `POST /mcp`, `@modelcontextprotocol/sdk` 1.32.1 (latest protocol 2025-11-25). A fresh `McpServer` + transport per request; all state is in SQLite. `GET/DELETE /mcp` → 405. Binds `127.0.0.1`; loopback-only `Host` and `Origin` checks.

- **17 tools:** `create_situation`, `update_situation`, `get_situation`, `list_open_situations`, `get_tasks`, `set_constraints`, `propose_plan`, `approve_plan`*, `reject_plan`*, `add_task`, `reschedule_task`, `update_task_status`, `resolve_situation`, `get_activity_log`, `get_workload_summary`, `simulate_delivery_event`, `reset_demo_data`*. (*require the service secret)
- **Resources:** `homerelay://workflows` (scenario catalog) and `homerelay://situation/{id}`.
- **Prompt:** `plan_situation`.
- Files: `domain.ts` (service, transactions, events), `scenarios.ts` (definitions), `planner.ts` (generic planner), `tools.ts`, `server.ts`, `db.ts` (migrations).

## Scenario engine

A `Scenario` (in `scenarios.ts`) declares: required information (with the question to ask), conflict detection, **task templates** (key, title, kind, anchor `expected|available|window_end` + offset, optional dependency, optional condition), a human resolution rule, and an executable `canResolve`. `planner.ts` is scenario-agnostic:

1. Missing required information → return a question, no actions.
2. For each template: no task yet and condition holds → propose **add** (never in the past: scheduled for the next minutes and noted in assumptions).
3. Open task whose due time no longer fits → propose **reschedule of that task**. Completed or cancelled tasks are left alone. Conditions gate only *adding*.
4. Nothing to do → no proposal (duplicate prevention).

Each plan records `scenario`, `constraints_used` and `outstanding_tasks`, generated from real inputs (never by a language model). Tasks remember `template_key`, so replanning matches tasks by identity, not by title. Adding a scenario means adding one object and tests.

Scenarios: delivery, maintenance, family_visit, general.

## Request flow (chat)

1. UI `POST /api/chat` → `handleChat` picks the LLM agent (if configured) or the rules agent.
2. The agent calls tools through `McpGateway.call`, which records a `TraceEntry` (tool, redacted args, result summary, duration, which agent).
3. The MCP server validates, runs the transaction, returns structured data.
4. The reply is composed from tool results. The response carries the trace, any saved proposal, and `stateChanged`.
5. The UI refetches persisted state.

## Trust and security model

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md). In short: single-user local app; browser-origin guards protect the API; a service-to-service secret keeps approve/reject/reset away from the model; confirmation flags for the LLM agent are derived from the user's own message.

| Class | Examples | Rule |
|---|---|---|
| Read | `get_situation`, `get_workload_summary` | Free. |
| Reversible app change | `propose_plan`, `add_task`, `reschedule_task`, `set_constraints`, `update_situation` | Allowed for the agent; multi-step plans stay proposals until approved. |
| User decisions | `approve_plan`, `reject_plan`, `reset_demo_data` | Secret required; model never offered them. |
| Confirmation-gated | completing a task, resolving a situation | `confirmed_by_user` required. |
| External/consequential | messaging, courier, door locks | Not implemented. The app never claims them. |

## Document vault (v3)

```
browser ──XHR octet-stream──▶ API POST /api/documents ──secret header──▶ MCP server /internal/documents ──▶ .data/documents/<uuid>
                                                                                   └─▶ SQLite documents, document_pages, documents_fts
```
Metadata, search, links and deletion go through MCP tools; only bytes use the internal endpoints, so no MCP client can name a file. Extraction is local (`unpdf` for PDF pages, UTF-8 for text); images are not OCR'd. Search is FTS5 (porter, unicode61) with one metadata row and one row per page. Details: [DOCUMENT_VAULT.md](DOCUMENT_VAULT.md).

## Connected records (v4)

```
situations ◄── tasks.situation_id (NULL = household task)
tasks ◄── tasks.depends_on_task_id (one prerequisite; no cycles)
documents ◄── document_links ──► situations
documents ◄── task_documents ──► tasks
activity_events.task_id / .situation_id ──► what each change touched
```
`GraphService` (`apps/mcp-server/src/graph.ts`) reads only these keys: the knowledge map (`get_household_map`), everything around one record with gaps derived from the same data (`get_connections`), one search across situations, tasks and document text (`search_household`), and an integrity self-check. Nothing is cached, so every view is current after a change.

## Data model (SQLite, `PRAGMA user_version`, now v4)

`situations` (+ `constraints_json`), `tasks` (+ `kind`, `depends_on_task_id`, `template_key`), `plan_proposals`, `activity_events` (written in the same transaction as the change), `preferences` (scope `household`|`demo`), since v3 `documents`, `document_pages`, `document_links` and the `documents_fts` virtual table, and since v4 a rebuilt `tasks` (nullable `situation_id`, `priority`, `category`, `tags_json`, `recurrence`, `recurrence_of` UNIQUE, self-dependency CHECK) plus `task_documents`. The v4 migration rebuilds `tasks` with foreign keys off and runs `foreign_key_check` before committing (tested on a v3 database with dependencies). Foreign keys on, WAL, UTC ISO timestamps, bound parameters. Migrations are repeatable and keep data (`scenarios.test.ts` upgrades a real v1 database).

## Time

All instants are stored as UTC ISO strings. Presentation uses `APP_TIMEZONE` (validated at startup, default Asia/Kolkata); calendar-day logic uses the local day, not the UTC day. `Intl.DateTimeFormat` instances are cached per zone (a measured hot spot).

## Event sources and future adapters

A situation's `source` is `user` or `demo`. Only those are implemented. Ring events, delivery-company APIs, calendars and notifications are **future adapters** that would call `create_situation` / `update_situation` through the same tools; none exists today.

## Failure behaviour

MCP down → API `503 MCP_UNAVAILABLE`, nothing changes. LLM provider failure → rules agent answers and says so. Tool errors → structured `{error:{code,message}}`; replies never report unsaved work as saved. Argument-validation failures map to `INVALID_INPUT` (400).

## Exports

`GET /api/export/tasks.csv`, `/api/situations/:id/export.json`, `/api/situations/:id/report.md`. Built from stored records, bounded, formula- and Markdown-injection safe.

## Web UI (apps/web)

- **Shell:** `AppShell` left rail (collapses to icons under 1100px, becomes a bottom bar under 760px) with Home, Situations, Documents, Tasks, Map, Activity, Assistant, plus New situation, Search (Ctrl/Cmd+K command palette), Ask HomeRelay and tool-server status.
- **v5 shell and system:** sticky top bar (breadcrumb, Search, Ask) on every route, grouped rail, phone bottom bar with a More sheet (`Overlay` variant `bottom`); design tokens in `tokens.css`, applied by `system.css` (loaded last). See [UI_UX_AUDIT.md](UI_UX_AUDIT.md).
- **v4 views:** `TasksView` (views with server-computed counts, filters), `TaskView` (detail: connections, documents, history), `TaskSheet`, `RelayMap` (deterministic SVG layout, no physics), `CommandPalette`, `Pulse` (Home briefing), `EntityResults` (records an assistant reply refers to). Motion: View Transitions on route change, `motion.ts` scroll reveal (IntersectionObserver, cleaned up per route), all disabled under reduced motion. Hash routes: `#/`, `#/situations`, `#/situation/:id`, `#/documents`, `#/document/:id`, `#/tasks`, `#/activity`, `#/assistant[/:id]`.
- **Assistant:** one `AssistantPanel` used both in the drawer and in the Assistant workspace page. It shows the operations actually run (from the trace), document results, saved changes and proposal cards.
- **Overlays:** one `Overlay` component on the native `<dialog>` serves the assistant drawer and the new-situation sheet: focus trap, inert page, Escape, focus return, scroll lock, short transform/opacity transitions, instant under reduced motion. Closing order is play exit → `close()` → unmount.
- **Conversation state (`logic.ts`, pure and unit tested):** threads keyed by situation id, `doc:<id>` for a document, or `home`; the agent is sent the open situation id only; a chat from home that creates a situation is re-homed into that situation's thread; a sequencer ensures only the latest request per key may apply its result; the legacy global conversation key is removed on load.
- **Server truth:** every mutation goes through `act()`, which refreshes from persisted state and announces success only after the server replies. The task-completion acknowledgement is driven by a status change observed in refreshed data, never by the click.
- **Toasts:** a manual popover (top layer) so confirmations stay visible above an open modal dialog.
- **Styles:** `styles/tokens.css` (colour, type, space, shape, motion tokens), `base.css`, `layout.css`, `components.css`, `motion.css`, `workspace.css` (v3 shell and workspaces). Components never hard-code colours or durations. Fonts are local system stacks; there is no network font dependency.
- **Remote profile (opt-in, `apps/mcp-server/src/remote.ts`):** a separate Express process on 127.0.0.1:3002 sharing the SQLite database. It is HomeRelay's own OAuth 2.1 authorization server (`oauth.ts`, migration v5 tables `oauth_codes` / `oauth_tokens`) plus a bearer-protected `/mcp`. Each request builds an `McpServer` through the same `registerTools()` with a `ToolProfile` (tool allow-list per scope, forced actor, search types, description overrides), so local and remote tools share one implementation. Deployment files are in `deploy/`; see [ALEXA_PLUS_INTEGRATION.md](ALEXA_PLUS_INTEGRATION.md).
- **Assistant results:** the "What was saved" list is derived from the real MCP trace of that response (successful state-changing calls only, in the tool's own result wording). Proposals render as structured cards; the MCP trace is a collapsed developer panel.
