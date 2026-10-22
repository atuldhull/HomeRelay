# Release and operator checklist

HomeRelay is a **local, single-user** application. Everything below assumes it runs on one machine, bound to 127.0.0.1.

## Before a demo
- [ ] `npm install`, then copy `.env.example` to `.env` and set `APPROVAL_SECRET` (16+ random characters). Never commit `.env`.
- [ ] `npm run typecheck`, `npm test`, `npm run test:e2e` all pass.
- [ ] `npm run dev`, open http://localhost:5173, click **Reset demo** (removes only simulated data).
- [ ] `npm run demo:files` for sample documents; delete earlier copies on **Documents** if a rehearsal uploaded them.
- [ ] Rehearse [DEMO_SCRIPT.md](DEMO_SCRIPT.md) once end to end.
- [ ] `npm run stop` afterwards (stops only this repository's processes).

## Before sharing the repository
- [ ] `git status` shows no `.env`, `.data/`, `artifacts/` or `test-results/` files.
- [ ] `npm audit` reviewed.
- [ ] **Choose a license (owner decision).** Recommendation: **MIT** if you want others to reuse the code freely with attribution; **Apache-2.0** for the same plus an explicit patent grant; **AGPL-3.0** if anyone running a modified version as a service must publish their changes. Without a LICENSE file, others have no right to reuse the code. Check the hackathon rules first.
- [ ] Feature claims in the submission match [PRODUCT_SPEC.md](PRODUCT_SPEC.md) and [TEST_PLAN.md](TEST_PLAN.md).

## Never, without a separate security design
- Bind to 0.0.0.0, open a tunnel, or expose ports 3000/3001/5173: there is no end-user authentication.
- Treat `APPROVAL_SECRET` as a user login: it only separates the API's user-action endpoints from the model.
- Enable `LLM_DOCUMENT_ACCESS=true` without telling users that document text will be sent to the configured provider.

## Data
- Data lives in `.data/` (SQLite database and `documents/`). Back up by copying the folder while the servers are stopped.
- **Reset demo** deletes only `source='demo'` situations and demo preferences; your own records and documents are kept.
- Deleting a document removes its file permanently (no trash); its history stays in the activity log.

## Status labels used in the docs
| Label | Meaning |
|---|---|
| Implemented and tested locally | Code exists and automated tests exercise it here |
| Implemented, not tested here | Code exists; this environment could not exercise it (e.g. a live LLM key) |
| Mocked/simulated | Clearly labelled demo data or a scripted stand-in (e.g. the simulated delivery, the test LLM client) |
| Requires credentials/access | Needs something only the owner can obtain (Alexa+ preview, an Anthropic key) |
| Planned, not implemented | Documented direction only |
