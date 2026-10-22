# Decisions

## v1

| # | Decision | Why |
|---|---|---|
| 1 | Project lives at `D:\homerelay`. | Projects live on D:. |
| 2 | npm workspaces monorepo: `mcp-server`, `api`, `web`, `shared`. | Required separation without extra tooling; shared TS source consumed directly. |
| 3 | `better-sqlite3` rather than `node:sqlite`. | `node:sqlite` is experimental in Node 22. |
| 4 | Stateless Streamable HTTP with `enableJsonResponse`. | No session bookkeeping; survives restarts; still the specified transport. |
| 5 | `APPROVAL_SECRET` gates approve/reject/reset. | Approval must be enforced, not requested in a prompt. Clarified in v2: it is a service secret, not user authentication. |
| 6 | The LLM is never offered user-action tools; `confirmed_by_user`, `actor`, `source` are overwritten from policy. | Model output is untrusted. |
| 7 | Rules agent is default; LLM optional with automatic fallback. | Demo reliability; no key needed to run or test. |
| 8 | Extra tools (`set_constraints`, `get_tasks`, `approve/reject_plan`, `resolve_situation`). | Each state change gets its own audited tool. |
| 9 | `propose_plan` with nothing to do returns no proposal. | Prevents duplicate or empty proposals. |
| 10 | Completing a task needs `confirmed_by_user`; moot tasks are cancelled, not completed. | Do not claim work that was not done. |
| 11 | Demo times are "next 17:00" in `APP_TIMEZONE` (default Asia/Kolkata). | The scenario reads naturally whenever it is run. |
| 12 | Default LLM model `claude-opus-5-5`, no forced `tool_choice`, thinking left default, thinking blocks echoed unchanged. | Current API guidance. Model stays configurable; **not verified live**. |
| 13 | Playwright drives the installed Chrome on its own ports and DB. | No browser download; never touches dev data. |
| 14 | No `LICENSE` added. | The license and copyright holder are the owner's call. See "Licensing" below. |
| 15 | Large source files are written with the editor tool, not shell heredocs. | Apostrophes and backslashes were corrupted by the shell tool (twice, including a regex). |

## v2

| # | Decision | Why |
|---|---|---|
| 16 | Browser-origin guards on the API (client header, JSON-only, Origin/Sec-Fetch-Site, Host). | The review found the API open to cross-site POSTs. A local single-user app does not need sessions, but it does need CSRF protection. |
| 17 | Scenarios are data (`scenarios.ts`) executed by one planner. | Three scenarios without three planners; adding one is an object plus tests. |
| 18 | Tasks store `template_key`; legacy tasks match by title. | Replanning needs identity that survives title edits. Migration v2 is additive. |
| 19 | Conditions gate only *adding* tasks; open tasks always follow time changes. | A cleared conflict should not strand a stale due time. |
| 20 | New tasks are never scheduled in the past; the plan says so. Reschedules never target the past. | Avoid perpetual reschedule proposals and misleading due times. |
| 21 | "Overdue" is derived from stored due times and the clock only; never "failed". | A due time is not a real-world outcome. |
| 22 | Day-part phrases ("evening") become a fixed time only with a disclosed assumption recorded on the situation. | Useful without silently guessing. |
| 23 | `update_situation` added so a moved appointment is an audited change. | Replanning needs a first-class way to change the start time. |
| 24 | MCP resources and a prompt added (catalog, situation, planning guidance). | Real, testable value to any MCP client; not decorative. |
| 25 | Exports are GETs built from stored data, bounded, injection-safe. | Inspectability without new write paths. |
| 26 | `listSituations` batches queries; `Intl.DateTimeFormat` cached. | Measured hot spots (`npm run bench`). |
| 27 | `npm run stop` stops only processes tied to this repo. | A broad `taskkill` once stopped unrelated Node processes. |
| 28 | Mutation check run against the evaluation harness. | A passing suite is only informative if it can fail. |
| 29 | Conversations are per-situation threads; the agent receives only the open situation's id. | The single persisted global conversation caused a resolved delivery's history to appear beside a new open one (reproduced). |
| 30 | A chat started from Home that creates a situation moves into that situation's thread and navigates there. | The exchange is evidence about that situation, not about "home". |
| 31 | Request sequencing per key; stale responses are dropped. | A slow response for a situation the user left must not overwrite the current view. |
| 32 | The assistant is a drawer, not a permanent column. One interaction model: ask bar on Home, "Ask about this situation" on a situation, top-bar button anywhere. | Full-width content; one coherent pattern; full-screen on phones. |
| 33 | Native `<dialog>` for overlays; toasts as a manual popover. | Focus trap, inertness, Escape and focus return for free; toasts must sit in the top layer above a modal dialog. |
| 34 | "What was saved" derives from the real trace, not from reply text. | The UI must not claim work the tools did not report. |
| 35 | Completion animation is driven by observed status change in refreshed data. | Never acknowledge before the server accepted. |
| 36 | No animation or illustration library; CSS only, local fonts. | Lightweight, no network dependency, reduced-motion friendly. |
| 37 | Ring, Fire TV, Bee deferred. | No authorised access or hardware here; simulated events must not be passed off as integrations. |

## v3

- **Bytes outside MCP.** File upload and download use secret-guarded internal HTTP endpoints; MCP tools handle metadata, search and links. MCP is JSON-RPC and has no streaming upload, and keeping paths out of every tool means no MCP client can make the server read a file.
- **Local extraction only (`unpdf`).** No OCR and no cloud parsing. Scans are stored and labelled "No text" rather than guessed at.
- **SQLite FTS5 instead of embeddings.** Exact, explainable matches with page numbers, no model download, no external service. Ranked by query-word coverage first so a document matching all words beats one matching a single word many times.
- **Automatic category from the file name only.** Predictable and explainable; the contents are never used to classify.
- **LLM gets no document contents by default** (`LLM_DOCUMENT_ACCESS`). Privacy over convenience for a household app.
- **The assistant reads, it does not summarise.** The rules agent quotes stored text; it never produces a summary it cannot ground.
- **Workspace navigation over a single dashboard.** Documents and tasks need their own pages; the rail keeps every area one click away and becomes a bottom bar on phones.
- **Alexa+:** stay in State A (local) and document the path to State B. Exposing the server needs OAuth and a public endpoint, which are owner decisions, not defaults.

## v4

- **Standalone tasks by a nullable `situation_id`,** not a hidden "general household" situation: no invisible records, and foreign keys still apply when a situation is set. Required a table rebuild (SQLite cannot relax NOT NULL), done with foreign keys off and a `foreign_key_check` before commit.
- **One prerequisite per task.** Covers the household cases (buy the part, then fit it) with a simple, explainable rule and cheap cycle checks. Multiple prerequisites are future work.
- **Completion-based recurrence** instead of a scheduler: completing a repeating task saves the next one, once (`recurrence_of` UNIQUE), so restarts cannot duplicate it and nothing pretends to notify.
- **Reopen is its own operation.** `update_task_status` keeps completed/cancelled terminal, so neither the agent nor a client undoes a completion by accident.
- **The map is derived, never stored.** Nodes and edges are read from foreign keys on each request; a duplicate graph could drift. Deterministic clustered layout in SVG: no physics simulation, no CPU use at rest, same picture every time.
- **Intent registry, not an LLM by default.** Normalise phrasing, retrieve records, then answer. Unknown requests search the records. The LLM remains optional; `search_household` is withheld from it by default because it returns document snippets.
- **A typed "yes" no longer approves a plan** (it did in v1). Approval is the plan card's button, the protected user action.
- **Removed overlapping MCP tools** (`get_tasks`, `get_situation_documents`) after reading Amazon's tool design guidance: one intent per tool.
- **Soak harness runs its own servers** on separate ports, database and folder, so a 24-hour run can never touch real data, and it stops only the processes it started.

## Licensing (open, owner decision)

No license is present. Options: **MIT** or **Apache-2.0** (permissive; Apache adds a patent grant). If the Devpost rules require a public repository, they appear to require an open-source license file; the alternative is a private repository shared with the designated judges. **Verify on the live Rules tab.** Correction to earlier advice: the separate Open Source *mini-challenge* appears to be a contribution to an open-source project during the hackathon, not merely licensing this repository. Confirm before investing effort.
