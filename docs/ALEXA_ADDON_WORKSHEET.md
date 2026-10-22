# Alexa+ add-on worksheet

The values an `addon-package/addon.json` needs, ready to paste once the Alexa AI CLI has scaffolded the real file (`alexa-ai new mcp …`). This is a worksheet, not the manifest. The JSON comes from the official CLI, and field names here are the ones the QuickStart's schema section quotes (read 2026-10-22). Status: **READY-BLOCKED**. The only missing pieces are the domain, the operator details on the legal pages, and the Developer Hub redirect URIs.

| Field (QuickStart schema) | Documented constraint | HomeRelay value | Status |
|---|---|---|---|
| endpoint `integrations[].config.endpoints.default.uri`, `"type": "HTTPS"` | HTTPS, remote, < 500 ms | `https://<domain>/mcp` | Needs domain |
| `name.value` | ≤ 30 chars | `HomeRelay` (9) | Ready |
| `shortDescription` | ≤ 123 chars | "Keep track of household situations and tasks, and draft plans you approve in the HomeRelay app." (96) | Ready |
| `fullDescription` | ≤ 4000 chars | See below (≈ 900) | Ready |
| `examplePhrases` | 3–4, each ≤ 200 chars | "What's open at home today?" · "Note that a parcel is coming tomorrow." · "I'm free after six on Friday." · "Make a plan for the plumber visit." | Ready |
| `distributionCountries` | ISO codes | `["<country>"]`, depending on where the preview is open (question for Amazon) | Decision |
| `spokenForm` | optional IPA | omit | — |
| `privacyPolicyUrl` | HTTPS, must resolve | `https://<domain>/privacy` (served by the remote profile; operator details via `LEGAL_*`) | Built; needs domain + operator details |
| `termsOfUseUrl` | HTTPS, must resolve | `https://<domain>/terms` | Built; needs domain + operator details |
| `mediaAssets.icons` light (required, 6 sizes) | 72, 64, 88, 126, 180, 241; PNG/JPG/WEBP; HTTPS | `https://<domain>/assets/addon/icon-light-<n>x<n>.png` | Built, dimensions verified |
| `mediaAssets.icons` dark (optional) | same sizes | `…/icon-dark-<n>x<n>.png` | Built |
| carousel (≥ 1) | 600×900, `altText` ≤ 250 | `…/carousel-1-600x900.png`; alt text in `assets/brand/README.md` (115 chars) | Built |
| banner (optional) | 1200×600, `altText` ≤ 250 | `…/banner-1200x600.png`, alt "HomeRelay: household situations, tasks and plans, approved by you." | Built |
| Account linking (`alexa-ai configure-account-linking --config-file`) | format not documented on the pages read | authorization URL `https://<domain>/oauth/authorize`, token URL `https://<domain>/oauth/token`, client id/secret from `npm run remote:client`, scopes `homerelay.read homerelay.plan`, PKCE S256 | Values ready; format pending Amazon |

**Full description (draft):**

> HomeRelay is a self-hosted household coordinator. Keep track of what's going on at home, such as a parcel on its way, a plumber's visit or family coming to stay, with the tasks that go with it.
>
> Ask what's open today, tell HomeRelay about something coming up, or say when you're free, and it records exactly what you said. Ask it to make a plan and it drafts the steps around your availability: what to check, what to reschedule, who needs to be home.
>
> You stay in charge. HomeRelay only drafts plans through this add-on. Nothing is created or changed until you approve the plan in the HomeRelay app, and the add-on can never approve plans, delete anything or read your stored documents.
>
> HomeRelay does not contact couriers, tradespeople or anyone else, and it does not control devices. It keeps your household's plans in one place and in step with your day.
>
> To use it, you need your own HomeRelay installation. Link it by signing in with your HomeRelay owner password.

Policy checks against Amazon's policy page: the icon contains only the HomeRelay mark; no Alexa/Amazon names, logos or devices appear in assets, keywords or phrases; the add-on does not target children; and the sign-in page shows a data disclosure before linking.
