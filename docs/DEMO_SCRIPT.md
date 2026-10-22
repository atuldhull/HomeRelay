# Three-minute demo script (v4)

The story: HomeRelay keeps how the household fits together. A delivery, its plan, the paperwork and the follow-up tasks are separate records that stay connected, and every workspace (and the assistant) reads the same links.

## Setup (before recording)
1. `npm run dev`, then `npm run demo:files` (sample documents in `.data/demo-files/`). Open http://localhost:5173 at about 1440×900.
2. On Home, click **Reset demo** (removes only simulated data). On **Documents**, delete earlier copies of the sample files if a rehearsal uploaded them (duplicates are refused).
3. Rehearse once end to end. Do not record until the run has succeeded from this exact state.

| Time | Do | Say |
|---|---|---|
| 0:00 | Home. Click **Start with a simulated delivery**. | "HomeRelay starts from a situation. This delivery is simulated and labelled, but it is a real record created through our own MCP server." |
| 0:12 | **Ask about this situation**: *I'm working until 6 PM and nobody else is home. Help me manage it.* | "It reads the stored state, records only what I said, finds the conflict and proposes a plan. Nothing exists yet: 0 open tasks." |
| 0:30 | Click **Approve plan**. | "Approval is a button. A typed 'yes' is not accepted, and the model is never given the approval tool." |
| 0:40 | **Tasks** → **New task**: *Buy a compatible water filter* (Shopping, high priority). Create. Then **New task**: *Replace the water filter*, **Must happen after** = the first one, a **Due** date, **Repeats** = every month (repeating needs a due time), attach *Washer warranty* via the document search. Create. | "Household tasks don't need a situation. This one waits for the other: a real dependency, so it can't be marked done yet." Point at the lock note. |
| 1:15 | **Documents**: drag `Courier receipt.txt` and `Dishwasher user guide.md`. Open the receipt, **Attach to a situation** → the delivery. | "Files stay on this machine; text is extracted locally." |
| 1:35 | **Map**. Click the delivery hub, then the water-filter task. | "Relay Map is drawn from the stored links: tasks in a situation, prerequisites, attached documents. Select a record and it shows what is connected and what is missing." |
| 1:55 | Press **Ctrl+K**, type *warranty*, Enter. | "One shortcut to any record or action." |
| 2:05 | **Assistant**: *What's on my plate today?*, then *Which tasks are blocked?* Click the task link in the answer. | "Answers come from tool calls against stored data, with links to the real records. Unfamiliar questions get a search of your records, not a list of example prompts." |
| 2:30 | On *Buy a compatible water filter*: **Mark done** → **Yes, it is done**. Open *Replace the water filter*. | "Done only after the server accepts it. The dependent task is unblocked." |
| 2:45 | **Home**: show **HomeRelay Pulse**. | "The briefing is computed from those same records: nothing invented, no score." |
| 2:55 | Close on the developer panel (MCP tool calls). | "34 real MCP tools over Streamable HTTP. Not connected to Alexa+ yet; that needs Amazon's preview access, a public HTTPS endpoint and OAuth." |

## Cut for time (show if there is room)
*Show me everything connected to this maintenance issue* on a maintenance situation; *What is my fuse down?* (honest answer, safe advice); the phone layout; deleting an attached document (its links disappear from the map, the situation stays); **Reload** to show persistence.

## What not to claim
No live Alexa+, Ring, courier, calendar or notification integration. A due time is stored, not delivered as a notification. No OCR. The LLM mode has not been run against a live key; the demo uses the rules agent. Describe the product as a self-hosted MCP implementation demonstrated through its own web interface.

## Backup
`npm run test:e2e` runs these flows headlessly against an isolated stack; screenshots land in `artifacts/homerelay-v4/` (and v3 in `artifacts/homerelay-v3/`).
