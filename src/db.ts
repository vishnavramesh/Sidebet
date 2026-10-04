import { DatabaseSync } from "node:sqlite";

// MONEY_MODE=play (default): everyone gets a coin wallet, settlement moves
// coins, nothing is ever owed. Good for demos and for "is this gambling?".
// MONEY_MODE=real: bets are real dollars; the bot never holds money, it tracks
// who owes whom and reminds them until it's paid.
// Amounts are integer hundredths either way (cents, or 1/100 coin).
export const PLAY = (process.env.MONEY_MODE ?? "play") !== "real";
export const STARTING_COINS = 1000 * 100;
export const DAILY_COINS = 100 * 100;
export const MAX_BET_CENTS = Math.round(Number(process.env.MAX_BET ?? 50) * 100);

export type Side = "yes" | "no";
export type MarketStatus = "open" | "closed" | "resolved" | "cancelled";
export type DebtStatus = "owed" | "claimed" | "paid" | "forgiven";

export interface Market {
  id: number;
  space_id: string;
  question: string;
  creator: string;
  status: MarketStatus;
  outcome: Side | null;
  external: string | null; // e.g. "kalshi:KXRATECUT-26DEC31" or "poly:12345"
  created_at: number;
  prior: number | null; // opening YES probability, 0..1
  prior_why: string | null;
  prior_case: string | null;
  ext_posted_yes: number | null;
  closes_at: number | null;
  close_warned: number;
  reminded_at: number;
}

export interface Bet {
  id: number;
  market_id: number;
  user_id: string;
  side: Side;
  amount: number; // cents
  created_at: number;
}

export interface Debt {
  id: number;
  space_id: string;
  market_id: number;
  debtor: string;
  creditor: string;
  amount: number; // cents
  status: DebtStatus;
  nags: number;
  next_nag_at: number;
  last_public_at: number;
  created_at: number;
}

export const db = new DatabaseSync(process.env.DB_PATH ?? "markets.db");
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    balance INTEGER NOT NULL DEFAULT 0, -- legacy play-money column, unused
    last_daily INTEGER NOT NULL DEFAULT 0, -- legacy, unused
    PRIMARY KEY (space_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    question TEXT NOT NULL,
    creator TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    outcome TEXT,
    external TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id INTEGER NOT NULL REFERENCES markets(id),
    user_id TEXT NOT NULL,
    side TEXT NOT NULL,
    amount INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    market_id INTEGER NOT NULL REFERENCES markets(id),
    debtor TEXT NOT NULL,
    creditor TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'owed',
    nags INTEGER NOT NULL DEFAULT 0,
    next_nag_at INTEGER NOT NULL DEFAULT 0,
    last_public_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  -- Which chat.db message is about which market, so tapbacks on it can bet.
  CREATE TABLE IF NOT EXISTS market_msgs (
    guid TEXT PRIMARY KEY,
    market_id INTEGER NOT NULL REFERENCES markets(id)
  );
  -- Play-money wallets, one per person per chat.
  CREATE TABLE IF NOT EXISTS wallets (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    last_daily INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (space_id, user_id)
  );
  -- Payment handles are per person, not per chat.
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    venmo TEXT,
    cashapp TEXT
  );
`);

// Additive migrations for databases created by earlier versions.
const hasColumn = (table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
if (!hasColumn("bets", "created_at")) db.exec("ALTER TABLE bets ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
// Opening odds (from chat history or Kalshi) and the one-line reason shown to the group.
if (!hasColumn("markets", "prior")) db.exec("ALTER TABLE markets ADD COLUMN prior REAL");
if (!hasColumn("markets", "prior_why")) db.exec("ALTER TABLE markets ADD COLUMN prior_why TEXT");
// The case for and against the opening odds, as JSON {yes: string[], no: string[]}.
if (!hasColumn("markets", "prior_case")) db.exec("ALTER TABLE markets ADD COLUMN prior_case TEXT");
// When betting stops, whether the group got a last-call warning, and when the
// creator was last reminded to resolve.
if (!hasColumn("markets", "closes_at")) db.exec("ALTER TABLE markets ADD COLUMN closes_at INTEGER");
if (!hasColumn("markets", "close_warned")) db.exec("ALTER TABLE markets ADD COLUMN close_warned INTEGER NOT NULL DEFAULT 0");
if (!hasColumn("markets", "reminded_at")) db.exec("ALTER TABLE markets ADD COLUMN reminded_at INTEGER NOT NULL DEFAULT 0");
// Last real-market price we posted, so we only re-post on real moves.
if (!hasColumn("markets", "ext_posted_yes")) db.exec("ALTER TABLE markets ADD COLUMN ext_posted_yes REAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS ext_prices (
    market_id INTEGER NOT NULL REFERENCES markets(id),
    t INTEGER NOT NULL,
    yes REAL NOT NULL
  );
`);

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
