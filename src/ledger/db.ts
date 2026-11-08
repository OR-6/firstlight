import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Open (or create) the SQLite database and apply migrations.
 * Use ':memory:' in tests. Tables for later milestones (plans, approvals,
 * donations, webhook_events, ...) are added when those features land.
 */
export function openDb(path = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
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
      kind          TEXT NOT NULL CHECK (kind IN ('donation_credit','payout_debit','payout_reversal','seed_credit')),
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

    CREATE TABLE IF NOT EXISTS audit_log (
      seq           INTEGER PRIMARY KEY,
      ts_ms         INTEGER NOT NULL,
      type          TEXT NOT NULL,
      payload       TEXT NOT NULL,          -- canonical JSON
      prev_hash     TEXT NOT NULL,
      hash          TEXT NOT NULL UNIQUE
    );

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
}
