import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "punks.sqlite");

export function openDb(): any {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Wait for up to 5 seconds if another process holds a write lock
  db.pragma("busy_timeout = 30000");
  migrate(db);
  return db;
}

function migrate(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_logs (
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      address TEXT NOT NULL,
      topic0 TEXT,
      topic1 TEXT,
      topic2 TEXT,
      topic3 TEXT,
      data TEXT,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS assigns (
      punk_index INTEGER NOT NULL,
      to_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS transfers (
      punk_index INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS offers (
      punk_index INTEGER NOT NULL,
      min_value_wei TEXT NOT NULL,
      to_address TEXT,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS offer_cancellations (
      punk_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS bids (
      punk_index INTEGER NOT NULL,
      value_wei TEXT NOT NULL,
      from_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS bid_withdrawals (
      punk_index INTEGER NOT NULL,
      value_wei TEXT NOT NULL,
      from_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS buys (
      punk_index INTEGER NOT NULL,
      value_wei TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS owners (
      punk_index INTEGER PRIMARY KEY,
      owner TEXT NOT NULL
    );

    -- Indexes for fast API filtering/sorting
    CREATE INDEX IF NOT EXISTS idx_raw_logs_blk_log ON raw_logs(block_number, log_index);

    CREATE INDEX IF NOT EXISTS idx_assigns_blk_log ON assigns(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_assigns_punk_blk_log ON assigns(punk_index, block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_assigns_to ON assigns(to_address);

    CREATE INDEX IF NOT EXISTS idx_transfers_blk_log ON transfers(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_transfers_punk_blk_log ON transfers(punk_index, block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address);
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_address);

    CREATE INDEX IF NOT EXISTS idx_offers_blk_log ON offers(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_offers_punk_blk_log ON offers(punk_index, block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_offers_to ON offers(to_address);
    CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(active);

    CREATE INDEX IF NOT EXISTS idx_offer_cancel_blk_log ON offer_cancellations(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_offer_cancel_punk_blk_log ON offer_cancellations(punk_index, block_number, log_index);

    CREATE INDEX IF NOT EXISTS idx_bids_blk_log ON bids(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_bids_punk_blk_log ON bids(punk_index, block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_bids_from ON bids(from_address);
    CREATE INDEX IF NOT EXISTS idx_bids_active ON bids(active);

    CREATE INDEX IF NOT EXISTS idx_bid_withdraw_blk_log ON bid_withdrawals(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_bid_withdraw_punk_blk_log ON bid_withdrawals(punk_index, block_number, log_index);

    CREATE INDEX IF NOT EXISTS idx_buys_blk_log ON buys(block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_buys_punk_blk_log ON buys(punk_index, block_number, log_index);
    CREATE INDEX IF NOT EXISTS idx_buys_from ON buys(from_address);
    CREATE INDEX IF NOT EXISTS idx_buys_to ON buys(to_address);

    CREATE INDEX IF NOT EXISTS idx_owners_owner ON owners(owner);
  `);
}

export function getMeta<T = string | null>(db: any, key: string, defaultValue: T | null = null): T | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  if (!row) return defaultValue;
  return row.value as T;
}

export function setMeta(db: any, key: string, value: string | number | bigint) {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
