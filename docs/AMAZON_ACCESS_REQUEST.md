# Amazon Alexa+ developer access: application package

Everything needed to request Alexa+ add-on developer access, and what happens after it is granted. Facts about Amazon's process come from the official pages listed at the end (read 2026-10-22). Where those pages are silent, this says so rather than guessing.

## 1. What Amazon's documentation says about access

| Question | Answer from the official docs | Source |
|---|---|---|
| Which program | Alexa+ add-ons (MCP Toolkit), described as a preview with access requested through Alexa+ for Builders | Toolkit overview, Alexa+ for Builders |
| Which identity is approved | **An AWS account** that you give to an **Alexa Solutions Architect**. You also need a free Alexa developer account (an Amazon account with the Alexa app profile completed, including phone, address, and an Alexa+-supported marketplace and language). | Set Up Your Development Environment |
| How to request | Through the Alexa+ for Builders page. The setup page says only to log in to "the AWS account that you provided to the Alexa Solutions Architect". **The docs do not say what information to send or which form to use.** | Set Up Your Development Environment |
| What the approval unlocks | An IAM user in that AWS account can call `sts:AssumeRole` on `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, which gives read access to the private CodeArtifact npm registry hosting `@alexa-ai/cli` | same |
| Supported OS | macOS Sierra or later, or Ubuntu. Windows is not listed. | same |
| Node.js | 24 or later | same |
| Credentials | AWS CLI profiles `alexa-ai-user` (the IAM user) and `alexa-ai` (the assumed role). Alexa CLI credentials are stored in `~/.alexa-ai/credentials` after `alexa-ai configure` (Login with Amazon). No environment variables are documented. | same, QuickStart |
| What the CLI generates | `alexa-ai new mcp …` creates the project and `addon-package/addon.json`. `alexa-ai deploy` validates, zips, uploads, builds and deploys to the development stage, and returns an add-on id. | QuickStart, CLI reference |
| Validation and testing | Validation runs inside `deploy` (`--skip-validation` exists). Tests use `alexa-ai test`, the web simulator (console login) and linked devices. | CLI reference, Test pages |
| Account linking | `alexa-ai configure-account-linking --addon-id <id> --config-file <path>` reads a JSON file of OAuth settings. **Its field names are not documented on the CLI reference page.** | CLI reference |

## 2. Can this machine run the CLI?

- Windows 11 host with Node 22.19: **not supported** (wrong OS and Node version).
- WSL distro `Ubuntu-24.04` (Ubuntu 24.04.3 LTS, x86_64) is installed. It has no Node.js and no AWS CLI. Ubuntu is a supported OS, so this is the cheapest supported environment. Nothing was installed, so the Windows setup and the running soaks are unchanged.

Minimal setup, once access is granted. Run inside `wsl -d Ubuntu-24.04`; it changes only that Linux user's home directory:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash   # inspect the script first
. ~/.nvm/nvm.sh && nvm install 24 && node -v                                       # expect v24.x
sudo apt-get update && sudo apt-get install -y unzip && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && unzip -q awscliv2.zip && sudo ./aws/install
aws configure --profile alexa-ai-user            # the IAM user's access key (type it into the prompt, never into chat)
# add an `alexa-ai` profile with role_arn = arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead and source_profile = alexa-ai-user
aws codeartifact login --tool npm --domain alexa-ai --repository npm-packages --domain-owner 372468808636 --region us-west-2 --namespace @alexa-ai --profile alexa-ai
npm install -g @alexa-ai/cli && alexa-ai --version
alexa-ai configure --no-browser                  # Login with Amazon
```

## 3. Ready-to-send request

Send it through the channel that Alexa+ for Builders gives you. Replace only the bracketed values.

> **Subject:** Alexa+ add-on developer access request: HomeRelay (MCP, household coordination)
>
> Hello,
>
> I'd like developer access to build an Alexa+ add-on with the MCP Toolkit.
>
> **Developer:** [your name], [organization or "individual"], [country]. Alexa developer account email: [email]. AWS account ID to allowlist: [12-digit AWS account id].
>
> **Add-on:** HomeRelay keeps track of household situations (a delivery, a repair visit, a family visit) and their tasks, and drafts plans that adapt when the customer's availability changes. Example requests: "What's open at home today?", "Note that a parcel is coming tomorrow", "I'm free after six on Friday", "Make a plan for the plumber visit."
>
> **Endpoint:** a self-hosted MCP server (Streamable HTTP, spec 2025-11-25) at [https://your-domain]/mcp. It's protected by OAuth 2.1 authorization code + PKCE (S256), with static client registration, a refresh token returned with every access token, and protected-resource metadata at /.well-known/oauth-protected-resource. Tools: 10 (7 read, 3 that record what the customer said or draft a plan). Plans are only drafts. Approval, deletion and document access are not available through the add-on.
>
> **Status:** the endpoint and OAuth are implemented and tested end to end with the official MCP SDK client, including over HTTPS behind a reverse proxy. Local tool latency is about 10–25 ms. A privacy policy and terms of use are served at /privacy and /terms.
>
> **Questions:**
> 1. Which redirect URIs should the OAuth client allow for development and live?
> 2. What is the JSON format of the `configure-account-linking` config file?
> 3. Is the Add-on Agent Skill path preferred over manual `addon.json` editing?
> 4. Which distribution countries and locales are open in the preview? I'm in [country].
>
> Thank you,
> [name]

## 4. Architecture summary for reviewers

```
Alexa+ (MCP client) ──HTTPS──▶ TLS proxy (Caddy) ──▶ HomeRelay remote profile :3002 (container, non-root, read-only rootfs)
                                 routes only /mcp /oauth/* /.well-known/* /health /ready /privacy /terms /assets/addon/*
                                                         │ OAuth 2.1 AS for the household owner + bearer-protected /mcp
                                                         ▼
                                                 SQLite (WAL) on a durable volume ◀── `backup.js` (schedule it on the host), `restore.js`
The household's own web app, API and full MCP server stay on loopback and are never routed by the proxy.
```

- **AuthN/AuthZ:** a single subject, the household owner. Owner password stored as a scrypt hash; 5 failures in 15 min lock sign-in. Codes are single-use, last 60 s, and a replay revokes everything issued from that code. Access tokens last 1 h and are bound to `<base>/mcp`. Refresh tokens last 30 days, rotate on every use, and reuse revokes the whole family. Only SHA-256 hashes are stored. Scopes: `homerelay.read`, `homerelay.plan`.
- **Data handling:** see [the privacy policy](../apps/mcp-server/src/legal.ts) served at /privacy. No Alexa device or usage data is collected. No document content reaches the add-on. The remote process never calls an LLM.
- **Evidence:** [ALEXA_PLUS_COMPLETION_LEDGER.md](ALEXA_PLUS_COMPLETION_LEDGER.md).

## 5. After access is granted: exact sequence

1. Deploy the container stack on the chosen host with a real domain ([DEPLOYMENT.md](DEPLOYMENT.md)) and check it: `npm run verify:remote -- https://<domain> run /tmp/state.json`, then `rm /tmp/state.json`.
2. Set up the CLI (section 2).
3. Scaffold: `alexa-ai new mcp --name "HomeRelay" --locale en-US --mcp-server-url "https://<domain>/mcp" --requires-auth --auth-scopes "homerelay.read homerelay.plan"`. Add `--auth-client-id` once the client exists (step 4). Check the flags against `alexa-ai new --help` first.
4. Get the redirect URIs from the Developer Hub, then run `npm run remote:client -- <uri> [<uri>…]`. Put the client entry in `deploy/remote.env` and restart the container.
5. Fill `addon-package/addon.json` from [ALEXA_ADDON_WORKSHEET.md](ALEXA_ADDON_WORKSHEET.md) (image URLs are under `https://<domain>/assets/addon/`), then run `alexa-ai deploy`.
6. Write the account-linking config in the format Amazon documents (not documented on the pages read so far), then run `alexa-ai configure-account-linking --addon-id <id> --config-file <file>` and check it with `alexa-ai get-account-linking --addon-id <id>`.
7. Link the account in the web simulator or on a device, invoke the example phrases, and record the results in the ledger (Alexa+ section). Then revoke the sessions (`npm run remote:revoke-all`), confirm Alexa has to re-link, and test after a container restart.

## Sources (read 2026-10-22)

- https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html
- https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html
- https://developer.amazon.com/docs/alexaplus/add-ons/alexa-ai-cli-reference.html
- https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html
- https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html
- https://developer.amazon.com/alexaplus/
