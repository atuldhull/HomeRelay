# Implementation report (2026-10-22)

## Capability status

| Capability | Status | Evidence |
|---|---|---|
| Situations → plan → approval → tasks → replan without duplicates → user-confirmed resolution | Implemented and tested locally | `domain.test.ts`, `scenarios.test.ts`, `agent-eval` #1–#11, `1-hero.spec.ts` |
| Approval enforced server-side; never by the model or a typed "yes" | Implemented and tested locally | `llm-agent.test.ts`, `agent-eval` #16, #31 |
| Stale plans retired on resolution | Implemented and tested locally | `domain.test.ts` (stale proposals) |
| Household tasks: dependencies (no cycles), completion-based recurrence (exactly once), reopen, delete | Implemented and tested locally | `v4-connected.test.ts`, `api-household.test.ts`, `5-v4.spec.ts` |
| Document vault: signature validation, duplicates (incl. concurrent), quota, local extraction, search, safe serving, privacy gate | Implemented and tested locally | `documents.test.ts`, `api-documents.test.ts`, `security.test.ts` |
| Relay Map, connections, search, Pulse, activity, exports | Implemented and tested locally | `v4-connected.test.ts`, `5-v4.spec.ts`, `6-v5-review.spec.ts`, `api-v2.test.ts` |
| Real MCP server (Streamable HTTP, 2025-11-25) with real client; API never touches SQLite | Implemented and tested locally | `mcp-smoke.test.ts`, `mcp-context.test.ts`, `api-household.test.ts` (contract) |
| Optional Anthropic LLM agent with fallback | Implemented, **not tested against a live key** (scripted client only) | `llm-agent.test.ts`, `agent-eval` #15 |
| UI: every route at five viewports, keyboard flows, reduced motion, error/empty states | Implemented and tested locally | `6-v5-review.spec.ts`, `3-consistency.spec.ts`, `5-v4.spec.ts` |
| Production-build CSP and security headers | Implemented and verified in Chrome | `vite.config.ts`; manual run recorded in TEST_PLAN |
| Simulated delivery event | Mocked/simulated (labelled in the UI) | `simulate_delivery_event` |
| Alexa+ add-on | **Requires credentials/access** (Private Preview, HTTPS host, OAuth); not connected | [ALEXA_PLUS_INTEGRATION.md](ALEXA_PLUS_INTEGRATION.md) |
| Reminders/notifications, Ring, courier, calendar | Planned, not implemented | PRODUCT_SPEC "Out of scope" |

## Checks run on 2026-10-22

| Command | Result |
|---|---|
| `npm run typecheck` (also `npm run lint`, which is the same check; no separate linter is configured) | exit 0 |
| `npm test` | 219 passed, 14 files (includes 36 agent-evaluation scenarios and 7 MCP smoke tests) |
| `npm run test:e2e` | 28 passed (real Chrome) |
| `npm run build` | success |
| `npm audit` | 0 vulnerabilities |
| `npm run test:soak -- --minutes 3` | passed: 102/102 cycles, 2,264 requests, 0 errors |
| 24-hour soak started 2026-10-22 01:19 IST | **interrupted at 13.48 h** by a machine restart (no result written); up to then 81,030 requests, 0 errors, 0 verification failures, 0 unexpected exits. Not a 24-hour pass. |

## Benchmark (`npm run bench`, local, 2026-10-22)

AMD Ryzen 7 8845HS, Node 22.19; throwaway database with 30+ situations and 83 open tasks; warm-up 5 calls, then n sequential calls; times include HTTP on loopback.

| Operation | p50 | p95 | n |
|---|---|---|---|
| MCP `get_workload_summary` | 10.5 ms | 15.2 ms | 200 |
| MCP `get_situation` | 5.6 ms | 10.4 ms | 200 |
| MCP `create_situation` (write) | 5.2 ms | 10.1 ms | 100 |
| `GET /api/dashboard` (3 MCP calls) | 24.9 ms | 38.2 ms | 100 |
| `POST /api/chat` "what is pending" (rules agent) | 11.5 ms | 21.2 ms | 50 |
| `POST /api/chat` plan with 3 tool calls (rules agent) | 24.5 ms | 29.9 ms | 30 |

These are local microbenchmarks, not end-to-end guarantees for any remote deployment.
