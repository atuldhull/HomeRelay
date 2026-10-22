# UI/UX audit (v4 → v5)

Audited on 2026-10-22 against branch `upgrade/homerelay-v4-connected-platform` at `b6b94ff`, in real Chrome at 1440×900 and 390×844, with real records seeded through the API (`tests/e2e/6-v5-review.spec.ts`, baseline screenshots in `artifacts/homerelay-v5-ui-review/baseline/`). Baseline checks: typecheck exit 0, 216/216 unit, 24/24 browser.

Routes found in `logic.ts`: `#/`, `#/situations`, `#/situation/:id`, `#/tasks`, `#/task/:id`, `#/documents`, `#/document/:id`, `#/map`, `#/activity`, `#/assistant[/:id]`. Overlays: assistant drawer, new-situation sheet, new-task sheet, command palette. Confirmation is inline (no separate dialog component).

## Cross-cutting findings

| Area | Observed | Change |
|---|---|---|
| Visual system | Two generations of CSS (`components/layout` v2.5, `workspace/connected` v3–v4). Most surfaces are the same white card with border + shadow; titles, eyebrows and section titles vary in size and case between pages. Pills everywhere (buttons, chips, selects, search). | One token layer with semantic colours, a type scale, spacing, three elevation tiers, radius tiers, motion tokens. Panels lose the shadow by default; elevation is reserved for overlays and the one primary card per page. Buttons get a squarer radius; pills stay only for status and filter chips. |
| Entity identity | Situations, tasks and documents use unrelated colours on the map, in search and in assistant answers. | One entity palette (situation forest, task amber, document indigo) used by map nodes, palette icons, entity chips, timeline. |
| Page headers | Each page has its own header block; no shared place for search or the assistant on phones. | A slim sticky top bar on every route: breadcrumb, Search (Ctrl/Cmd+K) and Ask; it gains a shadow once the page scrolls. Page heading pattern unified (eyebrow, title, one line, actions). |
| Navigation | Rail has a loud copper "New situation" button competing with the page's primary action; 7 items crammed into the phone bottom bar (10px labels). | Grouped rail (Household / Explore / Assistant), quieter create button, status chip with a real tooltip. Phones: 4 destinations + **More** sheet (Situations, Map, Activity, Search, New situation, New task). |
| Toasts | Centred at the bottom, cover content and the composer. | Bottom-right on desktop, above the bottom bar on phones; consistent success/error styling; still in the top layer above dialogs. |
| Motion | Route transitions and reveal exist; durations differ between files (120–420 ms). | Shared motion tokens; list items enter with one short rise; compact header on scroll; all disabled under reduced motion. |
| Overflow | Document page overflows horizontally at 1280×720 (found by the baseline five-viewport check). | Fixed by the grid min-width rules and preview sizing; the five-viewport check now runs on every route. |

## Screens

| Screen | Current experience / problem | Improvement | Key interactions | Responsive / a11y | Tests |
|---|---|---|---|---|---|
| **Home** | Tall dark hero (≈380 px) with ask bar; five big numeral tiles; Pulse starts below the fold; activity repeats the Activity page. | Shorter hero with an inline status strip (same `.stat` data); Pulse is the dominant column; a signature **Next up** card (next action from stored data) beside active situations, documents and a short activity list. | Open situation/task/document by id; ask bar; Simulate; Reset demo (confirm). | Single column on phones; strip wraps. | 1-hero, 2-v2, 5-v4 B |
| **Situations** | Card grid fine but sparse; filters as pills. | Same cards with refined hierarchy; attention/ready variants; filter bar styled like the rest. | Search, status/type filters, CSV, simulate, new. | Cards stack. | 2-v2 filters |
| **Situation detail** | Description floats between header and next action; every group is an identical white card. | Record header carries type, status, window and description; next action uses the signature card; facts/documents/activity in a quieter side column. | Ask, approve/reject, mark done (blocked rule from server), add task, attach/upload document, resolve. | Side column below main on tablet/phone. | 1-hero, 3-consistency, 5-v4 A |
| **Tasks** | Dense rows, every chip same weight; filters unstyled until v4 fix. | Rows: title first, one meta line, due time aligned right, dependency line in amber; tabs with real counts. | Tabs, search, filters, mark done (server-confirmed), open task, new task. | Meta wraps; tabs scroll horizontally. | 5-v4 B/C |
| **Task detail** | Recurrence is only a chip ("Repeats monthly"); no link between occurrences. | Recurrence panel: what completing does and links to the previous/next occurrence (needs `next_occurrence`/`previous_occurrence` from the server). | Mark done / start / cancel / reopen / delete (confirm), edit, move, prerequisite, documents. | Side panels below on phones. | 5-v4 A/E, v4-connected |
| **Task form** | All optional fields shown at once. | Title first; due/priority/category; connections; tags and repeats under **More options**. | Inline validation, server error kept in the sheet. | Full-screen sheet on phones, one scroll region. | 5-v4 A |
| **Documents** | Grid only; upload list and library visually similar. | Grid/list toggle (remembered per browser), clearer upload rows, type-coloured file icons. | Upload (real progress), duplicate/unsupported errors, search, category filter, sort. | Single column. | 4-v3, 5-v4 |
| **Document detail** | For text files the content appears under "Preview" and again as an empty "Extracted text" note. | Text files: one "Content" panel; PDFs keep viewer + per-page extracted text; images keep "no OCR" note. Linked situations/tasks grouped. | Ask, download, edit details, attach to situation/task, delete (confirm). | Preview fits width; no overflow at 1280. | 4-v3, 5-v4 D |
| **Relay Map** | Works; edges show a native tooltip only. | Clicking an edge selects the relationship and explains it in the side panel; entity palette shared with the rest of the app. | Select node, open, zoom/pan/fit, filters, find, list view. | Detail panel below on tablet/phone. | 5-v4 A/audit |
| **Activity** | Every event same weight; only situation links; no filters; no day grouping. | Grouped by day; filter chips (All, Your actions, Plans & approvals, Tasks, Documents); links to the affected task, document or situation by id. | Filters, open record. | Single column. | 5-v4 B |
| **Assistant page / drawer** | "Working with the tools…" stays visible after the answer while the page refreshes; replies are plain text with a left rule; clarifications look like normal text. | Agent replies as response cards (who, mode, steps, records, documents, proposal, changes); clarifications highlighted as a question; the working indicator ends when the answer arrives. | Send, suggestions, approve/reject, open records, tool details. | Drawer full screen on phones; composer above safe area. | 1-hero, 3-consistency, 5-v4 |
| **Command palette** | Good; not reachable on phones (no Ctrl+K, rail hidden). | Search button in the top bar on every size. | Arrow keys, Enter, Esc, ask fallback. | Full screen on phones. | 5-v4 palette |
| **Loading / empty / error** | Present and honest; inconsistent visuals. | Same empty-state and banner components everywhere. | Retry. | — | 5-v4 states |

## Decisions
- No route was added or removed. "Document upload" and "document search" are part of the Documents workspace, not separate routes.
- No backend behaviour changed except one additive field on `get_task` (previous/next recurrence occurrence), needed to explain recurrence correctly.
- No new runtime dependency: motion uses CSS and the View Transitions API already in use.

## Results (v5, branch `upgrade/homerelay-v5-ui`)

Every finding above was implemented; screenshots of the result are in `artifacts/homerelay-v5-ui-review/final/` (baseline in `.../baseline/`) and were inspected. The five-viewport check (1440×900, 1280×720, 768×1024, 390×844, 360×800 over all ten routes) passes; at baseline it failed on the document page.

## Control audit

Each control below was exercised in real Chrome by the browser suite (file in brackets), against the real API, with the result checked in the UI or the API.

| Control | What it does | Verified by |
|---|---|---|
| Rail and bottom-bar navigation, **More** sheet, breadcrumbs | route changes, history | route audit [5-v4], More + breadcrumb [6-v5] |
| Top bar **Search** / Ctrl+K, palette results and actions | opens records by id, runs actions | palette [5-v4], phone search [6-v5] |
| Top bar **Ask**, page **Ask about this…**, ask bar | open the assistant with the right context | 1-hero, 3-consistency, 5-v4 E |
| Assistant send, suggestions, record links, Approve/Reject on plan cards | real chat, entity routes, protected approval | 1-hero, 2-v2 (keyboard approval), 5-v4 A/B |
| Simulate delivery, Reset demo (confirm) | demo records only | 1-hero, 3-consistency |
| New situation sheet, New task sheet (incl. More options, document picker) | create through the API | 2-v2 (validation), 5-v4 A |
| Task tabs, search, filters; Mark done (confirm), Start, Cancel, Reopen, Delete (confirm), edit, situation and prerequisite selects, attach/detach document | server-confirmed task changes | 5-v4 A–E, 6-v5 (recurrence) |
| Situation: Add task, Mark done, Attach existing, Upload & attach, detach, resolve | | 1-hero, 4-v3, 5-v4 A/D |
| Documents: upload (file input, drag area), search, category chips, sort, grid/list toggle, open; detail: Ask, Download link, edit details, attach to situation/task, detach, delete (confirm) | | 4-v3, 5-v4 A/D, 6-v5 (layout) |
| Map: node select, open, zoom +/−, fit, type filters, find, list view, **connection select** | | 5-v4 A, 6-v5 (connection) |
| Activity filter chips and **Open task / document / situation** links | | 6-v5 |
| Toast dismiss, banner Retry | | 2-v2 (Retry), 5-v4 (states) |

Intentionally disabled controls say why: **Mark done** and **Start** on a task waiting for a prerequisite (title and the lock note name it), **Save changes** until something changed, sort while searching (results are by relevance), Send with an empty message.

Not covered by automation: the PDF viewer's own controls (browser built-in), drag-and-drop with a real mouse (the file input path is tested), and screen-reader speech output.
