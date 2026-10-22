/**
 * Privacy policy and terms of use, served publicly by the remote profile at /privacy and /terms (Alexa+ requires
 * reachable HTTPS URLs for both). Every statement describes what this code actually does. Operator details come from
 * LEGAL_* environment variables; anything unset is shown as a highlighted placeholder, never as an invented value.
 * DRAFT: these texts have not been reviewed by a lawyer.
 */
export interface LegalInfo { operator?: string; contact?: string; jurisdiction?: string; effectiveDate?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const slot = (v: string | undefined, label: string) => (v ? esc(v) : `<mark>[${label}: to be completed by the operator]</mark>`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · HomeRelay</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;background:#f5f1e6;color:#13221d;margin:0}main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;line-height:1.2}h2{font-size:19px;margin-top:28px}mark{background:#ffe9a8;color:#13221d;padding:0 3px}.note{border-left:3px solid #c58a1a;padding:4px 12px;background:#fff8e6}a{color:#0c5a48}@media (prefers-color-scheme:dark){body{background:#101814;color:#e8efe9}.note{background:#2a2414}a{color:#7fd0b5}}</style>
</head><body><main>${body}</main></body></html>`;
}

export function privacyHtml(i: LegalInfo) {
  return page("Privacy policy", `<h1>HomeRelay privacy policy</h1>
<p>Effective ${slot(i.effectiveDate, "effective date")}. Operated by ${slot(i.operator, "operator name")}. Contact: ${slot(i.contact, "contact email")}.</p>
<p class="note">HomeRelay is self-hosted software. Whoever runs this installation (the "operator", usually the household owner) controls the data described here. This page describes how the software handles data; it is a draft that has not been reviewed by a lawyer.</p>

<h2>What HomeRelay stores</h2>
<ul>
<li><strong>Household records you create:</strong> situations (for example a delivery or a repair visit), their constraints such as when you said you are available, tasks, plans proposed for your approval, and an activity log of changes.</li>
<li><strong>Documents you upload in the HomeRelay app</strong> (receipts, manuals, photos) and text extracted from them. Documents are never available through the voice/remote connection described below.</li>
<li><strong>Connection records:</strong> when you link a voice assistant, HomeRelay stores one-way SHA-256 hashes of the authorization codes and tokens it issues, which client they belong to, their scopes and expiry. It never stores the tokens themselves. Your owner password is stored only as a scrypt hash.</li>
</ul>
<p>HomeRelay does not collect data about your Alexa devices or your Alexa usage, does not ask for your voice recordings, and does not create advertising profiles.</p>

<h2>What a linked voice assistant can access</h2>
<p>When you link HomeRelay to Alexa+, you choose on the HomeRelay sign-in page which of these the connection may do:</p>
<ul>
<li><strong>Read</strong> (<code>homerelay.read</code>): your situations, tasks and how they connect. Not document contents.</li>
<li><strong>Plan</strong> (<code>homerelay.plan</code>): record situations and availability you state, and draft plans. Drafts change nothing until you approve them in the HomeRelay app. The connection can never approve plans, delete anything or read documents.</li>
</ul>
<p>Information returned to a request is sent to Amazon so Alexa can answer you. Amazon's handling of it is governed by Amazon's own privacy notice.</p>

<h2>Other services</h2>
<p>The HomeRelay app's own assistant can optionally use Anthropic's API if the operator configures an API key. When enabled, the text of your assistant conversations and relevant household records are sent to Anthropic to generate replies. Document text is included only if the operator separately enables document access. With no key configured, nothing is sent to any AI provider. The voice connection never uses this feature. HomeRelay sends no data to any other third party.</p>

<h2>How long data is kept</h2>
<ul>
<li>Household records and documents: until you delete them. Tasks and documents can be deleted in the app. Situations can be resolved but are kept, with their activity log, as your household history.</li>
<li>Authorization codes: valid 60 seconds; the records are removed about a day after expiry.</li>
<li>Access tokens: valid 1 hour. Refresh tokens: valid 30 days, replaced on every use. Records are removed about a day after expiry.</li>
<li>Backups: kept for as long as the operator keeps them. Retention: ${slot(undefined, "backup retention period")}.</li>
<li>Server logs record errors and request metadata (time, path, status, duration), not tokens, passwords or document contents. Log retention: ${slot(undefined, "log retention period")}.</li>
</ul>

<h2>Your choices</h2>
<ul>
<li>Unlink the add-on in the Alexa app at any time. The operator can also revoke every linked session immediately (<code>npm run remote:revoke-all</code>).</li>
<li>Delete tasks and documents in the app. To delete everything, the operator deletes the HomeRelay data directory or volume and any backups.</li>
<li>To ask what is stored or to request deletion, contact ${slot(i.contact, "contact email")}.</li>
</ul>

<h2>Security</h2>
<p>The connection uses HTTPS, OAuth 2.1 authorization codes with PKCE, short-lived tokens bound to this server, and rate limits. The database and documents are stored unencrypted on the operator's disk unless the operator uses disk encryption. Backups are not encrypted by HomeRelay. Store them encrypted. No system is perfectly secure. If a breach affecting your data is discovered, the operator will revoke all sessions and notify affected people at ${slot(i.contact, "contact email")} or as the law requires.</p>

<h2>Children</h2>
<p>HomeRelay is not directed at children and is meant to be used by adult household members.</p>

<h2>Changes</h2>
<p>Changes to this policy will be published on this page with a new effective date. Jurisdiction-specific rights: ${slot(i.jurisdiction, "jurisdiction and applicable data-protection rights")}.</p>
<p><a href="/terms">Terms of use</a></p>`);
}

export function termsHtml(i: LegalInfo) {
  return page("Terms of use", `<h1>HomeRelay terms of use</h1>
<p>Effective ${slot(i.effectiveDate, "effective date")}. These terms are between you and ${slot(i.operator, "operator name")} ("we"). Contact: ${slot(i.contact, "contact email")}.</p>
<p class="note">Draft, not reviewed by a lawyer. Sections marked with placeholders need a decision by the operator and legal review for their jurisdiction.</p>

<h2>1. What HomeRelay does</h2>
<p>HomeRelay keeps track of household situations and tasks and drafts plans for your approval. It does not contact couriers, tradespeople or anyone else, does not control devices, and does not verify real-world events. Anything it reports is what is stored in your records.</p>

<h2>2. Who may use it</h2>
<p>You must be an adult household member authorized by the household owner. You link a voice assistant by signing in with the household owner password. Keep that password secret. Anyone who has it can link a connection.</p>

<h2>3. Suggestions need your judgment</h2>
<p>Plans and suggestions are generated automatically and can be wrong or incomplete. Nothing is applied until you approve it in the HomeRelay app. You are responsible for decisions you make based on them. HomeRelay is not suitable for emergencies, safety-critical, medical, legal or financial decisions.</p>

<h2>4. Your data</h2>
<p>Your household data belongs to you. We use it only to provide HomeRelay to you, as described in the <a href="/privacy">privacy policy</a>.</p>

<h2>5. Acceptable use</h2>
<p>Do not try to access another household's data, bypass authentication, overload the service, or use it for anything unlawful.</p>

<h2>6. Availability and third parties</h2>
<p>HomeRelay is provided as is, without any promise of availability. It may be interrupted for maintenance or failures. Voice access depends on Amazon Alexa, and the optional in-app assistant may depend on Anthropic. Those services have their own terms, and we are not responsible for them. HomeRelay is not affiliated with or endorsed by Amazon.</p>

<h2>7. Suspension and ending</h2>
<p>You can stop at any time by unlinking the add-on. We may revoke connections that break these terms or put data at risk. When the service ends, data is handled as described in the privacy policy. Notice period and data-export arrangements: ${slot(undefined, "operator decision")}.</p>

<h2>8. Liability</h2>
<p>${slot(undefined, "limitation of liability, warranty disclaimer and governing law, which need legal review")}. Governing law: ${slot(i.jurisdiction, "jurisdiction")}.</p>

<h2>9. Changes</h2>
<p>We will publish changes on this page with a new effective date.</p>`);
}
