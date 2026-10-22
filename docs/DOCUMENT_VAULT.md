# Household document vault

Receipts, warranties, manuals, delivery slips, service records, photos and notes, kept next to the situations they belong to. Everything stays on this computer.

## What it does

| Capability | How |
|---|---|
| Upload | **Documents** page: drag and drop or **Upload files** (several at once), with per-file progress from the browser's real upload events. From a situation: **Upload & attach**. |
| Accepted files | PDF, PNG, JPEG, TXT, Markdown. Up to `DOCUMENT_MAX_MB` each (default 10). The type is decided by the file's **content signature**, not its name or the browser's claim. Anything else is refused with a reason and nothing is stored. |
| Duplicates | Detected by SHA-256 of the content. The upload is refused with the existing document's title, and the existing document is kept. |
| Category | Chosen on upload, or **automatic**: a guess from the file name only (`warranty`, `receipt`/`invoice`/`bill`, `manual`/`instructions`, `delivery`/`courier`/`parcel`, `service`/`repair`, `note`). Images default to Photo, everything else to Other. Editable later. |
| Text extraction | Local only. PDFs are read page by page with `unpdf`; text and Markdown are read directly. **No OCR**: images are stored and searchable by title, tags and description only, and the UI says so. Capped at 100,000 characters per page and 1,000,000 per document (marked as truncated). |
| Extraction status | `completed`, `unsupported` (images), `failed` (for example a damaged PDF, which is still stored and downloadable), `not_required`, `pending`. Each failure carries a plain-language note. |
| Search | SQLite FTS5 over title, file name, category, tags, description, notes, the titles of linked situations, and extracted text. Results are ranked by how many query words they cover, then BM25. Snippets highlight the matches and show the PDF page. |
| Preview | PDF in the browser's viewer, images inline, text in a monospaced panel; the extracted text per page; download. |
| Situations and tasks | A document can be attached to several situations and tasks (v4) and detached without deleting either. Attach/detach events appear in the timelines. Deleting a document removes its links and records that on each linked situation and task. |
| Metadata | Title, category, tags (up to 12), description, notes. All searchable. |
| Delete | Two-step confirmation in the UI. Removes the file, its text, its search entries and its links, and records `document_deleted` in each linked situation. |

## Assistant

The rules agent understands, for example:

- `Find the warranty`, `Find my receipts`, `Do I have the manual for the washer?` → searches stored documents and lists them with snippets and page numbers. If nothing matches it says so and does not guess.
- On a situation: `Attach the courier receipt` → attaches it if exactly one document matches; if several match it asks which one and attaches nothing. `Which documents are attached to this situation?` → reads the stored links.
- On a document page: `What does this document say?` → returns the stored extracted text (it does not write summaries), or explains why there is none.

Attaching from the assistant is a user-requested action and is recorded as such. Approval of plans is unchanged: documents never approve anything.

## Privacy and safety

- **Files never leave the machine** in the default configuration. The optional LLM agent is **not** given the document-content tools (`search_documents`, `get_document_text`) unless `LLM_DOCUMENT_ACCESS=true`. Metadata tools stay available.
- **Extracted text is untrusted data.** It is never interpreted as instructions; the LLM system prompt says so, and a test stores a document containing a prompt-injection attempt and checks that nothing is executed.
- **No paths from clients.** No MCP tool accepts a file path. Binary content moves only through the internal upload/content endpoints, which require the service secret, and those are reached only through the API.
- **Safe storage.** Files are written under `DOCUMENTS_DIR` (default `.data/documents`, git-ignored) with random UUID names, via a temporary file then rename. The original name is kept only as metadata, sanitised. A storage key that is not a UUID is refused, so a tampered row cannot point outside the folder.
- **Safe serving.** `X-Content-Type-Options: nosniff`, a `sandbox` Content-Security-Policy for non-PDF content, `Content-Disposition` with an encoded file name, and `Cross-Origin-Resource-Policy: same-origin`.

## MCP tools

`list_documents`, `search_documents`, `get_document`, `get_document_text`, `get_situation_documents`, `link_document_to_situation`, `unlink_document_from_situation`, `update_document_metadata`, `delete_document` (requires the service secret). Upload is deliberately **not** an MCP tool; see above.

## Limits

- No OCR, no Word/Excel files, no virus scanning, no encryption at rest beyond the operating system's.
- Single user, local only; the vault is not shared between machines.
- Search is word-based (with prefix and stemming), not semantic.
