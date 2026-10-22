import type { DocumentCategory, DocumentHit, DocumentSummary, DocumentText } from "@homerelay/shared";
import { DOCUMENT_CATEGORY_LABEL } from "@homerelay/shared";

/**
 * Rules-agent handling of document requests. Everything comes from real MCP tool results: search hits, linked documents,
 * stored extracted text. Document text is quoted as reference material and never treated as instructions.
 */

type Call = <T = any>(tool: string, args?: Record<string, unknown>) => Promise<T>;
export interface DocAnswer { reply: string; documents?: DocumentHit[]; clarification?: string }

const DOC_WORD = /\b(documents?|files?|warrant(?:y|ies)|receipts?|manuals?|invoices?|photos?|pictures?|pdfs?|attachments?|attached|uploaded|paperwork|model number)\b/i;
const DOC_VERB = /\b(find|search|show|where|which|look|list|get|open|any|have|do i have)\b/i;
const ATTACH = /\b(attach|link)\b/i;
const LINKED_Q = /\b(linked|attached|related)\b/i;
const READ = /\b(summari[sz]e|what does (?:this|the|it) (?:document|file|pdf|manual|receipt|warranty)? ?say|read (?:this|the|it)|extracted text|show (?:me )?the text)\b/i;
const CATEGORY_WORDS: [RegExp, DocumentCategory][] = [
  [/\bwarrant/i, "warranty"], [/\b(receipt|invoice|bill)s?\b/i, "receipt"], [/\bmanuals?\b/i, "manual"], [/\b(photo|picture|image)s?\b/i, "photo"],
];

const label = (d: DocumentSummary) => `"${d.title}" (${DOCUMENT_CATEGORY_LABEL[d.category]})`;
const hitLine = (h: DocumentHit, i: number) =>
  `${i + 1}. ${label(h.document)}${h.page ? `, page ${h.page}` : ""}${h.snippet ? `: ${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
const asHit = (d: DocumentSummary): DocumentHit => ({ document: d, snippet: null, page: null, matched: [] });

/** Text after "for"/"about"/"containing" when the user says what to look for; otherwise the whole message. */
function searchTerms(msg: string): string {
  const m = /\b(?:for|about|containing|mentioning|with)\s+(.+)$/i.exec(msg);
  return (m ? m[1] : msg).replace(/[?.!]+$/, "");
}

export async function documentIntent(msg: string, ctx: { situationId: string | null; documentId: string | null }, call: Call): Promise<DocAnswer | null> {
  const mentionsDocs = DOC_WORD.test(msg);

  // 1. "What does this document say?" on a document page: show stored extracted text, with its status.
  if (ctx.documentId && (READ.test(msg) || (mentionsDocs && /\b(this|it)\b/i.test(msg) && !ATTACH.test(msg)))) {
    const { document: d } = await call<{ document: DocumentSummary }>("get_document", { document_id: ctx.documentId });
    const text = await call<DocumentText>("get_document_text", { document_id: d.id, max_chars: 1500 });
    const pages = text.pages.filter((p) => p.text.trim());
    if (text.status !== "completed" || !pages.length) {
      return { reply: `${label(d)} has no extracted text to read. ${text.note ?? `Extraction status: ${text.status}.`} I can only use its title, tags and description.`, documents: [asHit(d)] };
    }
    const excerpt = pages.slice(0, 3).map((p) => `${d.kind === "pdf" ? `Page ${p.page}: ` : ""}${p.text.replace(/\s+/g, " ").trim().slice(0, 400)}`).join("\n");
    return {
      reply: `Extracted text from ${label(d)}${text.truncated ? " (first part)" : ""}:\n${excerpt}\n\nThis is the stored text, quoted as-is. The rules agent does not write summaries; the optional language-model agent can, if document access is enabled for it.`,
      documents: [asHit(d)],
    };
  }

  if (!mentionsDocs) return null;
  const category = CATEGORY_WORDS.find(([re]) => re.test(msg))?.[1];

  // 2. Attach a document to the open situation.
  if (ATTACH.test(msg)) {
    if (!ctx.situationId) return { reply: "Open the situation you want to attach a document to, then ask again (or use Attach on the situation page).", clarification: "Which situation?" };
    const query = searchTerms(msg.replace(/\b(attach|link)\b|\bto (this|the) \w+\b/gi, " "));
    // the category word narrows the search first; a file stored under another category but named for it still counts
    let found = await call<{ results: DocumentHit[] }>("search_documents", { query, category, limit: 5 });
    if (!found.results.length && category) found = await call<{ results: DocumentHit[] }>("search_documents", { query, limit: 5 });
    if (!found.results.length) return { reply: `I could not find a stored ${category ? DOCUMENT_CATEGORY_LABEL[category].toLowerCase() : "document"} matching that. Nothing was attached. Upload it on the Documents page first.` };
    if (found.results.length > 1) {
      return { reply: `More than one document matches, so I did not attach anything:\n${found.results.map(hitLine).join("\n")}\nTell me which one (use a word from its title).`, documents: found.results, clarification: "Which document?" };
    }
    const doc = found.results[0].document;
    const r = await call<{ already_linked: boolean; document: DocumentSummary }>("link_document_to_situation", { document_id: doc.id, situation_id: ctx.situationId, actor: "user" });
    return { reply: r.already_linked ? `${label(doc)} was already attached to this situation. Nothing changed.` : `Attached ${label(doc)} to this situation.`, documents: [asHit(r.document)] };
  }

  // 3. Documents attached to the open situation.
  if (ctx.situationId && LINKED_Q.test(msg)) {
    const { documents } = await call<{ documents: DocumentSummary[] }>("list_documents", { situation_id: ctx.situationId });
    const list = category ? documents.filter((d) => d.category === category) : documents;
    if (list.length) return { reply: `${list.length} ${list.length === 1 ? "document is" : "documents are"} attached to this situation:\n${list.map((d, i) => `${i + 1}. ${label(d)}`).join("\n")}`, documents: list.map(asHit) };
    if (/\brelated\b/i.test(msg)) {
      const sit = await call<{ situation: { title: string } }>("get_situation", { situation_id: ctx.situationId });
      const guess = await call<{ results: DocumentHit[] }>("search_documents", { query: sit.situation.title, category, limit: 5 });
      if (guess.results.length) return { reply: `Nothing is attached yet. These stored documents match the situation's title, so they may be related:\n${guess.results.map(hitLine).join("\n")}\nSay "attach the …" to attach one.`, documents: guess.results };
    }
    return { reply: `No ${category ? DOCUMENT_CATEGORY_LABEL[category].toLowerCase() + "s are" : "documents are"} attached to this situation.` };
  }

  // 4. Search.
  if (DOC_VERB.test(msg) || /\?$/.test(msg.trim())) {
    const terms = searchTerms(msg);
    const found = await call<{ results: DocumentHit[] }>("search_documents", { query: terms, limit: 5 });
    if (!found.results.length) return { reply: `I could not find a stored document matching "${terms.trim().slice(0, 80)}". I only search documents you have uploaded, and I don't guess.` };
    const note = found.results.some((h) => h.document.extraction_status === "unsupported") ? "\nSome results are images; HomeRelay has no OCR, so they matched on their title, tags or description only." : "";
    return { reply: `I found ${found.results.length} stored document${found.results.length === 1 ? "" : "s"}:\n${found.results.map(hitLine).join("\n")}${note}`, documents: found.results };
  }
  return null;
}
