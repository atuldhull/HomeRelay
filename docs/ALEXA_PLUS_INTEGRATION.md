# Alexa+ integration: where HomeRelay stands

**Short version:** HomeRelay is a working, self-hosted MCP server that already speaks the transport and protocol version Alexa+ uses. It is **not** connected to Alexa+. Connecting it requires Private Preview access from Amazon, a public HTTPS endpoint, and OAuth, none of which exist in this project today. Nothing in the product or these docs claims that Alexa+ controls HomeRelay.

Sources, read on 2026-10-22 (re-check them before acting; the pages were last updated a few months earlier):
- [Alexa+ MCP Toolkit Overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html)
- [Alexa+ MCP QuickStart Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)
- [Alexa+ MCP Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)
- [Build Alexa+ Add-ons: Development Stages](https://developer.amazon.com/docs/alexaplus/add-ons/alexa-plus-add-on-development-stages.html)
- [Choose the Proper Alexa+ Integration Approach](https://developer.amazon.com/docs/alexaplus/add-ons/choose-the-proper-alexaplus-integration-approach.html)
- [Alexa+ for Builders](https://developer.amazon.com/alexaplus/)

## Three states, kept apart

| State | Meaning | HomeRelay |
|---|---|---|
| **A: Local MCP server** | A real MCP server with real tools and persisted state, used by a real MCP client (HomeRelay's own API) and shown through HomeRelay's own web UI | **Current state.** Implemented and tested. |
| **B: Alexa+-ready** | The server meets the documented add-on requirements (public HTTPS, OAuth, latency, tool design) and an add-on package is prepared, but it has not been deployed or tested with Alexa+ | **Target.** The gaps are listed below. Not reached. |
| **C: Live on Alexa+** | Deployed with the Alexa AI CLI, invoked from a linked device or the web simulator, with the results recorded | **Not claimed.** Requires Amazon's Private Preview approval, which this project does not have. |

## What the official docs say (and how HomeRelay compares)

| Requirement (official docs) | HomeRelay today |
|---|---|
| "Alexa+ acts as the MCP client"; requests reach your server "using streamable HTTP" | ✅ Streamable HTTP on `/mcp` (stateless, JSON responses), tested with the official MCP SDK client |
| "Alexa+ for Builders supports the 2025-11-25 version of the MCP specification" | ✅ HomeRelay targets 2025-11-25 |
| Server "reachable at a remote URL"; a tunnel such as cloudflared is acceptable during development | ❌ Binds to `127.0.0.1` only, deliberately. HomeRelay never exposes itself to the internet automatically. |
| Auth: `client_credentials` for service-level (M2M) access, `authorization_code` + PKCE (S256) for user-level access. DCR, OIDC, step-up auth and `WWW-Authenticate` on 401 are **not supported**. Bearer tokens only in the `Authorization` header | ❌ No OAuth. Today the MCP endpoint has no client authentication; only user-action tools are guarded by a shared service secret (`APPROVAL_SECRET`). |
| Responses in under 500 ms | ✅ Locally: ~9 ms median, 14 ms worst of 10 calls each for `list_open_situations`, `get_workload_summary` and `search_documents` (measured 2026-10-22 on the dev machine). A tunnel or hosting adds network time, so this must be measured again end to end. |
| Tools, resources and prompts are discovered at deploy time: "Alexa+ refreshes tool information only on deployment" | ✅ 34 tools with descriptions and Zod input schemas (3 with output schemas), one resource, one resource template, one prompt. Any tool change would need `alexa-ai deploy` again. |
| Add-on package `addon-package/addon.json`: store listing (name ≤30 chars, short description ≤123, full ≤4000, 3–4 example phrases), HTTPS privacy-policy and terms URLs, icons in six sizes, at least one 600×900 carousel image, endpoint `integrations[].config.endpoints.default.uri` with `"type": "HTTPS"` | ❌ Not created. It needs a hosted privacy policy, terms of use and real image assets, and is only useful with preview access. |
| Access: "request access to the Private Preview"; "After approval, you receive credentials and install the tooling" (Alexa AI CLI, Add-on Agent Skill) | ❌ No access. No Amazon accounts were created for this project. |
| Optional MCP Apps extension for on-screen UI | ➖ Not implemented. |

## What carries over unchanged

These HomeRelay properties are why it is a reasonable add-on candidate, and none of them depend on Alexa+:

- **The server owns the logic.** Every read and write is an MCP tool with a validated schema. The web app is just one client, and it has no side door to the database.
- **Approval stays with the person.** `approve_plan`, `reject_plan`, `reset_demo_data` and `delete_document` refuse to run without the service secret, and the secret is never given to a model. An Alexa+ client would be able to read state, record events and **propose** plans, but could not approve them unless an explicit, authenticated user-level approval path were designed (see below).
- **Honest results.** Tools report what was stored. Nothing claims a courier, device or person was contacted.
- **Binary files never pass through MCP.** Uploads go through a separate internal endpoint. No MCP tool accepts a file path, so a remote client cannot make the server read local files.

## Tool design checked against Amazon's guidance (v4)

Source: [MCP add-on tools, schema and data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design), read on 2026-10-22.

| Guidance (paraphrased, quotes marked) | HomeRelay v4 |
|---|---|
| "Design each tool to represent one meaningful customer intent"; avoid overlapping tools | Removed `get_tasks` (overlapped `list_tasks`) and `get_situation_documents` (overlapped `list_documents`); 34 tools. The two search tools state when to use which. |
| "Treat your schema as a promise": declare only parameters you implement | Every declared parameter is implemented; the v4 contract test calls the new tools with a real MCP client and reuses returned ids in later calls. |
| Keep output consistent with the declared schema; don't leave fields undeclared | `outputSchema` declared for `search_household`, `get_connections`, `get_household_map` (validated by the SDK). **Not yet** for the other 31 tools. |
| Always return a response, even with no data | Empty list results include a short `message`. |
| Payload hygiene | Results contain only HomeRelay's own records and in-app routes; no tracking parameters or third-party links. |

## Path from State A to State B

Each step is a decision for the owner. None of them is done automatically.

1. **Request Private Preview access** from Amazon (via [Alexa+ for Builders](https://developer.amazon.com/alexaplus/)). Without it there are no credentials or CLI.
2. **Choose an exposure profile.** Decide which tools a third-party client may see. Recommended: keep `get_document_text` and `search_documents` out of the remote profile by default, matching the existing rule that document contents are not sent to an external model unless `LLM_DOCUMENT_ACCESS=true`. Implementing this needs a second, separately registered tool set on its own endpoint, because HomeRelay's own agent still needs those tools locally.
3. **Add OAuth** in the documented shape: an authorization server with a token endpoint for `client_credentials` (HTTP Basic client authentication, `resource` parameter validated against the registered MCP URI, short-lived tokens of 3600 s or less, no refresh token, scope `mcp:service`) and `authorization_code` with PKCE S256 for user-level actions. The server must reject any request without a valid bearer token.
4. **Design voice approval explicitly.** If spoken approval is wanted, it should be a user-level scope granted through `authorization_code`, and the tool should repeat back exactly what will be saved. Until that exists, approval stays in the HomeRelay app.
5. **Host behind HTTPS.** For development, the docs allow a tunnel (for example cloudflared). Only start one deliberately and stop it when finished, because it makes the server reachable from the internet.
6. **Re-measure latency** through the tunnel or host against the 500 ms budget.
7. **Prepare `addon.json` and assets** (privacy policy, terms, icons, carousel), then `alexa-ai configure`, `alexa-ai new mcp --mcp-server-url …`, `alexa-ai deploy`.

## Path from State B to State C

From the development-stages page: deploy to the development stage, "Link your devices to your development environment," invoke the add-on on a linked device or in the web simulator, and complete on-device testing for each applicable device modality. Certification starts with `alexa-ai submit`. Only after that testing is recorded may anyone say HomeRelay works with Alexa+.

## How to describe HomeRelay in the submission

> A self-hosted MCP server (Streamable HTTP, spec 2025-11-25) for household coordination, demonstrated through its own web interface. It follows the Alexa+ MCP Toolkit's transport and protocol requirements; it has not been deployed to or tested with Alexa+.

Do not use Alexa logos or imply endorsement.
