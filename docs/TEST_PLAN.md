# Test plan

Run everything: `npm test` (vitest, 216 tests in 14 files, including the agent evaluation), `npm run test:e2e` (Playwright, 24 tests), `npm run test:soak -- --minutes 3` (isolated soak; see below), `npm run eval` (agent evaluation, 20 scenarios, report in `test-results/agent-eval-report.md`).

| Layer | File | Tests | Covers |
|---|---|---|---|
| Domain | `tests/domain.test.ts` | 18 | Create/get/list; task validation, transitions, dependencies, confirmation; reschedule history; propose → approve exactly once; subset approval; reject; supersede; replan without duplicates; resolution rules; **transaction rollback**; demo reset isolation; repeatable migrations |
| Scenarios | `tests/scenarios.test.ts` | 20 | Catalog; maintenance (missing info, partial/full overlap, dependencies, window moves, resolution); family visit (relative scheduling, moved arrival, welcome task, past-due handling); manual intake validation; `update_situation`; workload summary against a controllable clock; **time handling** (ranges, local-vs-UTC day, boundary roll-over, DST zones); **migration v1→v2 on a real old database** |
| MCP protocol | `tests/mcp-smoke.test.ts` | 7 | Real client over HTTP: version, `tools/list`, health/405, persistence verified with an independent SQLite connection, invalid input, full lifecycle, auth refusal, reset isolation |
| MCP context | `tests/mcp-context.test.ts` | 9 | 27 tools incl. annotations, intake constraints + initial task, inverted windows, `update_situation`, workload summary vs DB, resources, resource template, planning prompt |
| Documents | `tests/documents.test.ts` | 19 | Content-signature type detection and refusals, file-name sanitising, size limit, duplicate by SHA-256, PDF text per page, damaged PDF stored as `failed`, image `unsupported` (no OCR), FTS search incl. page-2 hits and query-syntax injection, tampered storage key refused, link/unlink idempotence and events, delete removes file + links, MCP document tools over HTTP, internal endpoints need the secret, `list_tasks` filters, automatic category from the file name |
| API documents | `tests/api-documents.test.ts` | 13 | Upload proxy (octet-stream only, headers, 413/415/409), search incl. the UI's 200-row limit, content headers (nosniff, sandbox CSP, disposition), metadata, link/delete with confirmation, agent document intents (find, attach, ambiguous, linked, read), a stored prompt-injection document, LLM privacy gate (content tools withheld by default) |
| API | `tests/api.test.ts` | 17 | Hero scenario over HTTP; validation and error shape; idempotent demo; approval/reject; confirmation; clarification; reset guard; token redaction; **MCP down → 503** |
| API v2 | `tests/api-v2.test.ts` | 15 | Maintenance and family visit via chat; moved window; completion; "what needs attention"; dashboard summary; manual intake incl. UTC conversion and calendar validation; exports incl. CSV/Markdown injection and bounds |
| Security | `tests/security.test.ts` | 14 | CSRF header, content-type, Origin, Sec-Fetch-Site, DNS rebinding (API + MCP), CORS preflight, headers, 413, rate limit, privileged tool refusal, secret/bundle scan, git hygiene, timezone validation |
| LLM agent | `tests/llm-agent.test.ts` | 11 | Scripted stand-in client against the real MCP server: tool mapping, withheld tools, policy overrides, one user message of results, thinking echoed unchanged, approval bypass refused, tool errors, malformed input, iteration cap, refusal/max_tokens, provider failure fallback, MCP outage |
| Agent evaluation | `tests/eval/agent-eval.test.ts` | 20 | Table of scenarios, each on its own real MCP + SQLite: tool order, DB state, proposal status, activity events, task states, honest wording (see below) |
| v4 domain | `tests/v4-connected.test.ts` | 16 | Standalone tasks and filters; dependency validation (missing, self, cross-situation, cycles incl. longer cycles); blocked reason; a situation's tasks know about a prerequisite outside it; edit/move with history; explicit reopen; delete releases dependents; monthly recurrence with month-end clamp and attachments; late recurrence moved forward and no duplicate after a restart; task documents both ways and document deletion; map nodes/edges from stored links only and after changes; connections and gaps; global search; integrity check; v3 → v4 migration keeps dependencies and foreign keys |
| Household API + MCP contract | `tests/api-household.test.ts` | 6 | Task routes (local times, validation, 404/409 mapping, cycle 409, NOT_LINKED 409, delete needs confirmation), map/connections/search, recurrence through the API; real MCP client: every new tool listed with schema, ids reused across calls, structured errors, empty-result message, output schema present |
| UI state logic | `tests/web-logic.test.ts` | 15 | Route parsing round-trips and safe fallbacks, document/assistant thread keys, operation steps from the real trace; per-situation threads (the reported leak), re-homing a chat that creates a situation, pruning, proposal sync, storage failure and legacy-key removal, request sequencing, featured-situation choice, state-aware suggestions |
| Browser E2E | `tests/e2e/1-hero.spec.ts` … `6-v5-review.spec.ts` | 28 | Real Chrome: hero flow with reload; duplicate-click and mobile; intake dialog validation; plan explanation; **keyboard-only approval**; dependency UI; tiles and filters; CSV export; natural-language scenarios via the ask bar; API failure + Retry; mobile sheet and overflow. **Consistency suite:** resolve one delivery then create another (no thread leakage, new ID, clean assistant, reload), repeat Simulate opens the same situation, same-title situations stay separate, a slow response cannot overwrite the current view, a task is acknowledged only after server success (and a rejected completion is shown honestly), drawer focus return + Escape + reduced motion, one scroll region and reachable footer on a 1280×640 screen, toast visible above the full-screen drawer on a phone. **v3 suite:** every workspace route with active navigation and reload; three-file upload with the in-flight state captured; duplicate and unsupported uploads refused with nothing stored; search reaching page-2 PDF text with highlights; PDF preview and extracted text; asking about the open document; attach from the situation page (timeline event); attach and list via the assistant; plan approval; tasks workspace; assistant workspace document search; confirmed deletion; phone layouts with no horizontal scroll |

## Agent evaluation scenarios

1 create delivery · 2 retrieve existing state first · 3 conflict identified · 4 proposal not executed · 5 approve · 6 reject · 7 replan after meeting extended · 8 no duplicates · 9 outstanding tasks · 10 overdue is not "failed" · 11 collection confirmed and resolved · 12 missing information · 13 invalid timestamp from the model · 14 MCP server failure · 15 provider error fallback · 16 model cannot bypass approval/reset · 17 invalid status transition · 18 reset spares non-demo data · 19 maintenance overlap, no claim of contacting the technician · 20 family visit assumed time disclosed.

**Does the harness actually fail?** Yes. With duplicate prevention deliberately broken in the planner, scenarios #7 and #8 failed; restored, all 20 pass. Repeated runs (6×) are stable.

## v5 review tests (`6-v5-review.spec.ts`)

Seeds records through the API, then: desktop review of every workspace and overlay with screenshots, phone review, **every route at 1440×900, 1280×720, 768×1024, 390×844 and 360×800 with no horizontal overflow**, and the v5 interactions (map connection, documents list layout persisted across reload, activity filters and record links, recurrence panel and next-occurrence link after completion, breadcrumbs, clarification marker, status chip name, no lingering progress indicator, phone More sheet and search). `V5_SHOTS=baseline` writes to a separate folder.

## v4 browser tests (`5-v4.spec.ts`)

Scenario A (upload → attach to a maintenance situation → create a task with the document → dependency on a household task → situation shows both → assistant finds the receipt and the connections → map shows and selects the same records), B (overdue task in Pulse → assistant → open from the answer → complete → Pulse and Activity update), C (proposal creates nothing, approval creates three tasks, repeating the approval creates nothing), D (deleting an attached document removes only its links, no dangling map edge), E (a slow reply for task A cannot land in task B's conversation), command palette, route/link audit (every route by fresh deep link, every record route from the map, invalid ids, unknown route, back/forward, reload, no unnamed buttons, no uncaught page errors), phone/tablet/reduced motion (no horizontal scroll, content visible without motion), honest empty and error states.

## Defects the v4 tests found

1. The situation page showed a task as **Ready** with an enabled Mark done while its prerequisite (a household task outside the situation) was open; the server would refuse. Situation detail now carries the server's `waiting_on`.
2. Interrupting a route transition left an unhandled promise rejection (`Transition was skipped`).
3. Home overflowed horizontally on phones when content was long; task-page selects grew past the screen.
4. Pulse listed a task twice (This week and Blocked).
5. The CSV export asked `list_tasks` for more rows than the tool allows (same class of bug as v3's search limit).
6. Expected behaviour changes were caught by the old suites: completed tasks reopening through a status change (kept terminal; reopen is explicit), and the eval's "pending" scenario (now also reads household tasks).

## Soak test (`npm run test:soak`)

Starts its own MCP server and API (ports 3201/3200) with a database and document folder under `.data/soak/<run>/`, then repeats a bounded cycle through the public API: dashboard, create a maintenance situation, create a dependent task pair and a household task, list tasks, upload and search a document, attach it to the situation and a task, read connections, the map (checks every edge has both ends) and global search, read activity, edit a task, confirm a blocked completion is refused, complete tasks, resolve, verify the persisted state, then delete that cycle's document and household task. Records request counts, error categories, latency percentiles per operation, process memory (Windows `tasklist` for the two pids it owns), restarts and exits, database and folder size. Declared success criteria: full duration, no unexpected exits, error rate < 0.1%, zero verification failures, memory growth < 2× (last sixth vs first sixth). It stops on its deadline, on `npm run test:soak:stop` (stop file) or on a signal, and writes `interrupted` in that case.

## Defects the v3 tests found

1. Library search always failed validation (the UI asked for 200 rows, the tool allows 100) and left the previous results on screen labelled as matches. Fixed; regression test in `api-documents.test.ts`; the UI now clears results on error.
2. The assistant could not attach "the courier receipt" when it was stored under another category. The category word is now a preference, not a filter.
3. The assistant workspace overflowed horizontally on phones (grid child without `min-width: 0`).
4. The rail's status indicator picked up the upload-row styles (class collision).
5. "Working on : X" had a stray space; the attach reply leaked raw «» match markers.
6. The e2e suite depended on whatever the previous run left in its database; it now starts clean and waits for the tool server.

## Stability

`npm run eval` 6 consecutive passes; Playwright suite 5 consecutive passes after fixing two test defects (a locator that closed an open panel; a startup race). A flaky assertion that matched bare digits in IDs/durations was replaced.

## Not covered / known gaps

- LLM agent against a **live** model (no API key).
- Automated accessibility audit (axe); only role/label/keyboard/focus interactions are exercised. Screen-reader output was not listened to.
- React component unit tests (covered through E2E).
- The soak covers the API/MCP stack, not the browser; browser memory over long sessions was not measured.
- The PDF preview in headless Chrome renders as the empty viewer background; the iframe and headers are tested, the visual PDF render is not.
- Real XHR upload progress is visible only for large files; the test slows the server to capture the in-flight state.
- Multi-instance concurrency; load testing beyond `npm run bench`.
