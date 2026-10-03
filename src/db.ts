import { DatabaseSync } from "node:sqlite";

export const STARTING_BALANCE = 1000;
export const DAILY_BONUS = 100;

export type Side = "yes" | "no";
export type MarketStatus = "open" | "closed" | "resolved" | "cancelled";

export interface Market {
  id: number;
  space_id: string;
  question: string;
  creator: string;
  status: MarketStatus;
  outcome: Side | null;
  external: string | null; // e.g. "kalshi:KXRATECUT-26DEC31" or "poly:12345"
  created_at: number;
}

export interface Bet {
  id: number;
  market_id: number;
  user_id: string;
  side: Side;
  amount: number;
}

export const db = new DatabaseSync(process.env.DB_PATH ?? "markets.db");
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    balance INTEGER NOT NULL,
    last_daily INTEGER NOT NULL DEFAULT 0,
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
