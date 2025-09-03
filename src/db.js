import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "punks.sqlite");

export function openDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db) {
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
  `);
}

export function getMeta(db, key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  if (!row) return defaultValue;
  return row.value;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

