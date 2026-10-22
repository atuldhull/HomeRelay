import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fromRoot, loadEnv } from "./env";

/**
 * Online backup: a consistent SQLite snapshot (the backup API, safe while the servers run) plus a copy of the
 * document files. Usage: npm run backup [-- <target dir>]   (default .data/backups/<timestamp>)
 */
loadEnv();
const dbPath = fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db");
const docsDir = process.env.DOCUMENTS_DIR ? fromRoot(process.env.DOCUMENTS_DIR) : path.join(path.dirname(dbPath), "documents");
const target = path.resolve(process.argv[2] ?? fromRoot(path.join(".data", "backups", new Date().toISOString().replace(/[:.]/g, "-"))));
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}`); process.exit(1); }
fs.mkdirSync(target, { recursive: true });

const src = new Database(dbPath, { readonly: true, fileMustExist: true });
await src.backup(path.join(target, "homerelay.db"));
src.close();
const check = new Database(path.join(target, "homerelay.db"), { readonly: true });
const integrity = check.pragma("integrity_check", { simple: true });
const version = check.pragma("user_version", { simple: true });
check.close();
if (integrity !== "ok") { console.error(`Backup failed its integrity check: ${integrity}`); process.exit(1); }

let files = 0;
if (fs.existsSync(docsDir)) {
  fs.cpSync(docsDir, path.join(target, "documents"), { recursive: true });
  files = fs.readdirSync(path.join(target, "documents"), { recursive: true }).length;
}
console.log(`Backup written to ${target}: database (schema v${version}, integrity ok) and ${files} document entr${files === 1 ? "y" : "ies"}.`);
console.log("It contains household data and OAuth token hashes: store it encrypted and off this machine.");
