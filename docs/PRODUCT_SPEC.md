# Product spec

**Promise:** "Tell HomeRelay what's happening. It helps you figure out what happens next, takes approved actions, adapts when circumstances change, and keeps track of what remains unfinished."

Not a general chatbot and not a smart-home controller. It coordinates household workflows end to end and is honest about what it did and did not do.

## Primary user
A busy person whose schedule conflicts with household events and who forgets follow-ups. Segments are plausible, not validated demand; no user research was done.

## Core concept
A **situation** (an event needing attention) has **constraints** (what the user told us), a **plan proposal** (not executed until approved), **tasks** (explicit statuses, dependencies), and an **activity log** of real recorded events.

Lifecycle: event → retrieve context → detect conflict / ask for missing information → propose → user approves → tools execute → state saved → circumstances change → replan (reschedule, don't duplicate) → user confirms outcome → resolved.

## Scenarios (one engine)

| Scenario | Needs | Tasks (template → dependency) | Resolved when |
|---|---|---|---|
| **Delivery** (flagship) | When you're free | collect the package; ask a household member (if conflict); redelivery/pickup (after collect) | you confirm collection |
| **Maintenance appointment** | window start/end, when you'll be home | be home or arrange access; access instructions (if overlap); ask for a later slot (if full miss); confirm repair done (after be home) | you confirm the work |
| **Family visit** | arrival time | groceries; prepare room; tidy common areas (after room); confirm arrival; arrange welcome (if you're late) | all tasks done or cancelled and you confirm |
| **General** | nothing | a follow-up task | all tasks closed and you confirm |

Detail: `docs/ARCHITECTURE.md`; catalog served at MCP resource `homerelay://workflows`.

## Requirements
1. Persistent situations, tasks, proposals and activity in SQLite.
2. Real MCP server (Streamable HTTP, 2025-11-25) and a real MCP client in the backend; all domain reads and writes go through it.
3. Proposals are never auto-executed; approval is enforced server-side.
4. Statuses and transitions are validated; dependencies enforced; completion needs user confirmation.
5. Replanning reuses existing tasks; repeats create no duplicates; plans explain which constraints they used.
6. Works with no API key (rules agent); optional LLM agent with fallback.
7. Dashboard derived from stored state: open, due today, overdue, awaiting approval, ready to resolve, recent activity.
8. One-click, repeatable, resettable demo that only ever deletes demo data.
9. The UI distinguishes proposed vs approved vs saved vs user-confirmed, and simulated vs real.
10. Exports (CSV, JSON, Markdown) from real records.
11. **(v3)** A household document vault: upload PDF, image, text and Markdown files with validation, duplicate detection and real progress; local text extraction with honest status; search with highlighted snippets; preview; metadata; link documents to situations; confirmed deletion. Document contents stay local by default.
12. **(v3)** A workspace app: Home, Situations, Documents, Tasks, Activity and Assistant pages, usable on a phone.
13. **(v3)** The assistant finds, attaches and lists documents, reads stored text of the open document, and asks which one when several match. It shows the operations it actually ran.
14. **(v4)** Household tasks without a situation; priority, category, tags, one prerequisite (no cycles), completion-based weekly/monthly repeats, documents attached to tasks, edit/move/reopen/delete with history.
15. **(v4)** Relay Map: a knowledge map derived only from stored relationships, with selection, connections, gaps, list view and an empty state.
16. **(v4)** One search and command palette (Ctrl/Cmd+K) over situations, tasks and documents.
17. **(v4)** HomeRelay Pulse: a briefing computed from stored records (overdue, today, blocked, this week, proposals, new documents, next actions). No scores.
18. **(v4)** The rules agent answers common phrasings by retrieving records first; unknown requests search records; a typed "yes" is never an approval.

## Out of scope
Live Alexa+ (see [ALEXA_PLUS_INTEGRATION.md](ALEXA_PLUS_INTEGRATION.md)), Ring, courier, calendar, messaging or notification integrations; OCR and document summarisation; door control; multi-user accounts and authentication; push notifications (a stored due time is not a delivered notification).
