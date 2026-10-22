import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE situations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(title) > 0),
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL CHECK (category IN ('delivery','maintenance','family_visit','general')),
    status TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','resolved')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    expected_at TEXT,
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','demo')),
    constraints_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX idx_situations_status ON situations(status);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) > 0),
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('followup','coordination','contingency','general')),
    status TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','blocked','cancelled')),
    due_at TEXT,
    depends_on_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_tasks_situation ON tasks(situation_id);

  CREATE TABLE plan_proposals (
    id TEXT PRIMARY KEY,
    situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
    plan_json TEXT NOT NULL,
    applied_action_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    rejected_at TEXT
  );
  CREATE INDEX idx_proposals_situation ON plan_proposals(situation_id);

  CREATE TABLE activity_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    situation_id TEXT REFERENCES situations(id) ON DELETE CASCADE,
    task_id TEXT,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','agent','system')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_activity_situation ON activity_events(situation_id);

  CREATE TABLE preferences (
    scope TEXT NOT NULL CHECK (scope IN ('household','demo')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );
  `,
  // v2 — scenario templates: tasks remember which template produced them (stable identity for replanning)
  `
  ALTER TABLE tasks ADD COLUMN template_key TEXT;
  CREATE INDEX idx_tasks_template ON tasks(situation_id, template_key);
  `,
  // v3 — household document vault. Files live on disk under opaque keys; only metadata and extracted text are in SQLite.
  `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(title) > 0),
    original_filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pdf','image','text')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('receipt','warranty','manual','delivery','maintenance_record','photo','note','other')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    extraction_status TEXT NOT NULL CHECK (extraction_status IN ('not_required','pending','completed','unsupported','failed')),
    extraction_note TEXT,
    page_count INTEGER,
    text_chars INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_documents_created ON documents(created_at);
  CREATE TABLE document_pages (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (document_id, page)
  );
  CREATE TABLE document_links (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, situation_id)
  );
  CREATE INDEX idx_document_links_situation ON document_links(situation_id);
  CREATE VIRTUAL TABLE documents_fts USING fts5(document_id UNINDEXED, page UNINDEXED, field UNINDEXED, content, tokenize = 'porter unicode61');
  `,
  // v4 — standalone household tasks and task attributes. SQLite cannot relax NOT NULL in place, so the table is
  // rebuilt (create, copy, drop, rename) with foreign keys off; migrate() re-checks every foreign key afterwards.
  `
  CREATE TABLE tasks_v4 (
    id TEXT PRIMARY KEY,
    situation_id TEXT REFERENCES situations(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) > 0),
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('followup','coordination','contingency','general')),
    status TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','blocked','cancelled')),
    due_at TEXT,
    depends_on_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    template_key TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','maintenance','cleaning','shopping','bills','family','garden','other')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','weekly','monthly')),
    recurrence_of TEXT UNIQUE,
    CHECK (depends_on_task_id IS NULL OR depends_on_task_id != id)
  );
  INSERT INTO tasks_v4 (id, situation_id, title, description, kind, status, due_at, depends_on_task_id, created_at, updated_at, completed_at, template_key)
    SELECT id, situation_id, title, description, kind, status, due_at, depends_on_task_id, created_at, updated_at, completed_at, template_key FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v4 RENAME TO tasks;
  CREATE INDEX idx_tasks_situation ON tasks(situation_id);
  CREATE INDEX idx_tasks_template ON tasks(situation_id, template_key);
  CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);
  CREATE INDEX idx_tasks_depends ON tasks(depends_on_task_id);
  CREATE TABLE task_documents (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, document_id)
  );
  CREATE INDEX idx_task_documents_document ON task_documents(document_id);
  CREATE INDEX idx_activity_task ON activity_events(task_id);
  `,
  // v5 — OAuth for the opt-in remote profile. Only SHA-256 hashes of codes and tokens are stored, never the values.
  `
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    subject TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    family_id TEXT NOT NULL,
    code_hash TEXT,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    subject TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    replaced_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);
  CREATE INDEX idx_oauth_tokens_code ON oauth_tokens(code_hash);
  `,
];

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** Repeatable: applies only migrations newer than PRAGMA user_version. Never drops data. */
export function migrate(db: Db, target: number = MIGRATIONS.length): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= Math.min(target, MIGRATIONS.length)) return;
  // Table rebuilds need foreign keys off (the pragma is ignored inside a transaction); every key is verified before commit.
  const fk = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    for (let v = current; v < Math.min(target, MIGRATIONS.length); v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        const broken = db.pragma("foreign_key_check") as unknown[];
        if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign key reference(s); rolled back`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    if (fk) db.pragma("foreign_keys = ON");
  }
}
