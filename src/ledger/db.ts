import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Open (or create) the SQLite database and apply migrations.
 * Use ':memory:' in tests. Tables for later milestones (plans, approvals,
 * donations, webhook_events, ...) are added when those features land.
 */
export function instanceId(db: Db): string {
  return (db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string }).value;
}

export function openDb(path = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  dropVerdictDigestUnique(db);
  widenLedgerKinds(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      aliases       TEXT NOT NULL,          -- JSON array of other network ids
      time_ms       INTEGER NOT NULL,
      updated_ms    INTEGER NOT NULL,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      depth_km      REAL,
      mag           REAL NOT NULL,
      alert         TEXT,
      status        TEXT NOT NULL,
      revision      INTEGER NOT NULL DEFAULT 1,
      raw           TEXT NOT NULL           -- canonical JSON of the normalised event
    );

    -- Pool money. Signed cents: credits positive, debits negative.
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL CHECK (kind IN (${LEDGER_KINDS_SQL})),
      amount_cents  INTEGER NOT NULL,
      ref           TEXT NOT NULL,
      created_ms    INTEGER NOT NULL,
      UNIQUE (kind, ref)                    -- a donation or payout is booked at most once
    );

    CREATE TABLE IF NOT EXISTS payout_batches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id          TEXT NOT NULL,
      plan_version      INTEGER NOT NULL,
      paypal_request_id TEXT NOT NULL UNIQUE,
      verdict_digest    TEXT NOT NULL,
      paypal_batch_id   TEXT,
      status            TEXT NOT NULL,
      created_ms        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payout_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id      INTEGER NOT NULL REFERENCES payout_batches(id),
      event_id      TEXT NOT NULL,
      recipient_id  TEXT NOT NULL,
      amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
      status        TEXT NOT NULL,
      created_ms    INTEGER NOT NULL,
      UNIQUE (event_id, recipient_id)       -- R6 again, enforced by the database
    );

    -- One row per agent assessment; versions increase per event (SPEC §6 "plans (versioned)").
    CREATE TABLE IF NOT EXISTS plans (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id           TEXT NOT NULL,
      version            INTEGER NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('assessed','agent_failed')),
      raw_plan           TEXT,                 -- exactly what the agent submitted (untrusted)
      agent_json         TEXT NOT NULL,        -- model, turns, tool steps
      sentinel_json      TEXT NOT NULL,
      corroboration_json TEXT NOT NULL,
      llm_mode           TEXT NOT NULL,
      created_ms         INTEGER NOT NULL,
      UNIQUE (event_id, version)
    );

    CREATE TABLE IF NOT EXISTS verdicts (
      plan_id       INTEGER PRIMARY KEY REFERENCES plans(id),
      -- Not unique: re-assessing an unchanged event gives the same digest (same money).
      digest        TEXT NOT NULL,
      overall       TEXT NOT NULL,
      verdict_json  TEXT NOT NULL,
      created_ms    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS verdicts_digest ON verdicts(digest);

    CREATE TABLE IF NOT EXISTS approvals (
      plan_id       INTEGER PRIMARY KEY REFERENCES plans(id),  -- one decision per plan, final
      decision      TEXT NOT NULL CHECK (decision IN ('approve','deny')),
      approver      TEXT NOT NULL,
      reason        TEXT NOT NULL,
      decided_ms    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq           INTEGER PRIMARY KEY,
      ts_ms         INTEGER NOT NULL,
      type          TEXT NOT NULL,
      payload       TEXT NOT NULL,          -- canonical JSON
      prev_hash     TEXT NOT NULL,
      hash          TEXT NOT NULL UNIQUE
    );

    -- One random id per database. Mixed into PayPal idempotency keys so a
    -- demo reset (fresh database) is not mistaken by PayPal for a resend.
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('instance_id', lower(hex(randomblob(8))));

    -- Donations into the pool (SPEC §5.6 / §5.6b). donor_ref and message are untrusted
    -- text: stored as data, escaped on display, never fed to the agent or sentinel.
    CREATE TABLE IF NOT EXISTS donations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id       TEXT NOT NULL UNIQUE,
      source           TEXT NOT NULL CHECK (source IN ('human','agent')),
      donor_ref        TEXT NOT NULL,
      message          TEXT,
      amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
      idempotency_key  TEXT,
      order_id         TEXT UNIQUE,
      approval_url     TEXT,
      capture_id       TEXT UNIQUE,
      status           TEXT NOT NULL,
      created_ms       INTEGER NOT NULL,
      captured_ms      INTEGER,
      UNIQUE (donor_ref, idempotency_key)
    );

    -- Allowances: a person lets one agent donate up to a cap until an expiry (a mandate).
    -- Only the sha256 of the bearer token is stored; the token is shown once, at creation.
    CREATE TABLE IF NOT EXISTS allowances (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,
      label         TEXT NOT NULL,
      cap_cents     INTEGER NOT NULL CHECK (cap_cents > 0),
      created_ms    INTEGER NOT NULL,
      expires_ms    INTEGER NOT NULL,
      revoked_ms    INTEGER
    );

    -- Verified PayPal webhook deliveries, de-duplicated on PayPal's event id.
    CREATE TABLE IF NOT EXISTS webhook_events (
      id            TEXT PRIMARY KEY,
      event_type    TEXT NOT NULL,
      resource_id   TEXT,
      received_ms   INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
  addColumn(db, 'donations', 'allowance_id', 'TEXT');
  addColumn(db, 'donations', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS donations_allowance ON donations(allowance_id)');
}

/** Ledger entry kinds. Refunds and reversals of donations are debits (negative cents). */
export const LEDGER_KINDS = ['donation_credit', 'donation_refund', 'donation_reversal', 'payout_debit', 'payout_reversal', 'seed_credit'] as const;
const LEDGER_KINDS_SQL = LEDGER_KINDS.map((k) => `'${k}'`).join(',');

function addColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Older databases had a CHECK on ledger_entries.kind without the donation refund/reversal kinds. Rebuild it. */
function widenLedgerKinds(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger_entries'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'donation_refund'")) return;
  db.transaction(() => {
    db.exec(`ALTER TABLE ledger_entries RENAME TO ledger_entries_old;
      CREATE TABLE ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN (${LEDGER_KINDS_SQL})),
        amount_cents INTEGER NOT NULL, ref TEXT NOT NULL, created_ms INTEGER NOT NULL, UNIQUE (kind, ref));
      INSERT INTO ledger_entries (id, kind, amount_cents, ref, created_ms) SELECT id, kind, amount_cents, ref, created_ms FROM ledger_entries_old;
      DROP TABLE ledger_entries_old;`);
  })();
}

/** Older databases declared verdicts.digest UNIQUE, which made a second assessment of an unchanged event fail. */
function dropVerdictDigestUnique(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verdicts'").get() as { sql: string } | undefined;
  if (!row || !/digest\s+TEXT NOT NULL UNIQUE/.test(row.sql)) return;
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`ALTER TABLE verdicts RENAME TO verdicts_old;
      CREATE TABLE verdicts (
        plan_id INTEGER PRIMARY KEY REFERENCES plans(id), digest TEXT NOT NULL, overall TEXT NOT NULL,
        verdict_json TEXT NOT NULL, created_ms INTEGER NOT NULL);
      INSERT INTO verdicts SELECT plan_id, digest, overall, verdict_json, created_ms FROM verdicts_old;
      DROP TABLE verdicts_old;`);
  })();
  db.pragma('foreign_keys = ON');
}
