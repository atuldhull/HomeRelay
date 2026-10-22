import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fromRoot, loadEnv } from "./env";

/**
 * Restores a backup made by scripts/backup.ts. Stop every HomeRelay process first (local servers and the remote profile).
 * Nothing is deleted: the current database and documents are moved aside to <name>.pre-restore-<timestamp>.
 * Usage: npm run restore -- <backup dir>
 */
loadEnv();
const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, "homerelay.db"))) { console.error("Usage: restore.ts <backup dir containing homerelay.db>"); process.exit(1); }
const dbPath = fromRoot(process.env.DATABASE_PATH ?? ".data/homerelay.db");
const docsDir = process.env.DOCUMENTS_DIR ? fromRoot(process.env.DOCUMENTS_DIR) : path.join(path.dirname(dbPath), "documents");

const check = new Database(path.join(src, "homerelay.db"), { readonly: true });
const integrity = check.pragma("integrity_check", { simple: true });
check.close();
if (integrity !== "ok") { console.error(`The backup failed its integrity check (${integrity}); nothing was changed.`); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
let kept = 0;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) { fs.renameSync(f, `${f}.pre-restore-${stamp}`); kept++; }
fs.copyFileSync(path.join(src, "homerelay.db"), dbPath);
if (fs.existsSync(path.join(src, "documents"))) {
  if (fs.existsSync(docsDir)) { fs.renameSync(docsDir, `${docsDir}.pre-restore-${stamp}`); kept++; }
  fs.cpSync(path.join(src, "documents"), docsDir, { recursive: true });
}
console.log(`Restored ${src} to ${dbPath}.${kept ? ` The previous files were kept with the suffix .pre-restore-${stamp}.` : " There was no previous database."}`);
