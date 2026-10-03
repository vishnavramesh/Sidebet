import {
  type Bet,
  DAILY_BONUS,
  type Market,
  STARTING_BALANCE,
  type Side,
  db,
  tx,
} from "./db.ts";

export class BetError extends Error {}

// ---------- users ----------

export function ensureUser(spaceId: string, userId: string) {
  db.prepare(
    "INSERT OR IGNORE INTO users (space_id, user_id, balance) VALUES (?, ?, ?)",
  ).run(spaceId, userId, STARTING_BALANCE);
}

export function getBalance(spaceId: string, userId: string): number {
  ensureUser(spaceId, userId);
  const row = db
    .prepare("SELECT balance FROM users WHERE space_id = ? AND user_id = ?")
    .get(spaceId, userId) as { balance: number };
  return row.balance;
}

function addBalance(spaceId: string, userId: string, delta: number) {
  ensureUser(spaceId, userId);
  db.prepare(
    "UPDATE users SET balance = balance + ? WHERE space_id = ? AND user_id = ?",
  ).run(delta, spaceId, userId);
}

export function setName(spaceId: string, userId: string, name: string) {
  ensureUser(spaceId, userId);
  db.prepare("UPDATE users SET name = ? WHERE space_id = ? AND user_id = ?").run(
    name,
    spaceId,
    userId,
  );
}

export function displayName(spaceId: string, userId: string): string {
  const row = db
    .prepare("SELECT name FROM users WHERE space_id = ? AND user_id = ?")
    .get(spaceId, userId) as { name: string | null } | undefined;
  if (row?.name) return row.name;
  // Phone numbers / emails are ugly in a group chat; show a short tail.
  const digits = userId.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : userId.split("@")[0]!;
}

export function claimDaily(spaceId: string, userId: string): number | null {
  ensureUser(spaceId, userId);
  const today = Math.floor(Date.now() / 86_400_000);
  const row = db
    .prepare("SELECT last_daily FROM users WHERE space_id = ? AND user_id = ?")
    .get(spaceId, userId) as { last_daily: number };
  if (row.last_daily >= today) return null;
  db.prepare(
    "UPDATE users SET balance = balance + ?, last_daily = ? WHERE space_id = ? AND user_id = ?",
  ).run(DAILY_BONUS, today, spaceId, userId);
  return getBalance(spaceId, userId);
}

export function leaderboard(spaceId: string, limit = 10) {
  return db
    .prepare(
      "SELECT user_id, balance FROM users WHERE space_id = ? ORDER BY balance DESC LIMIT ?",
    )
    .all(spaceId, limit) as { user_id: string; balance: number }[];
}

// ---------- markets ----------

export function createMarket(
  spaceId: string,
  creator: string,
  question: string,
  external: string | null = null,
): Market {
  ensureUser(spaceId, creator);
  const res = db
    .prepare(
      "INSERT INTO markets (space_id, question, creator, external, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(spaceId, question, creator, external, Date.now());
  return getMarket(spaceId, Number(res.lastInsertRowid))!;
}

export function getMarket(spaceId: string, id: number): Market | undefined {
  return db
    .prepare("SELECT * FROM markets WHERE id = ? AND space_id = ?")
    .get(id, spaceId) as Market | undefined;
}

export function listMarkets(spaceId: string, statuses: string[] = ["open", "closed"]) {
  const ph = statuses.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM markets WHERE space_id = ? AND status IN (${ph}) ORDER BY id DESC LIMIT 15`,
    )
    .all(spaceId, ...statuses) as unknown as Market[];
}

export function linkedUnresolved(): Market[] {
  return db
    .prepare(
      "SELECT * FROM markets WHERE external IS NOT NULL AND status IN ('open','closed')",
    )
    .all() as unknown as Market[];
}

export function setExternal(market: Market, external: string) {
  db.prepare("UPDATE markets SET external = ? WHERE id = ?").run(external, market.id);
}

export function pools(marketId: number) {
  const rows = db
    .prepare("SELECT side, SUM(amount) AS total FROM bets WHERE market_id = ? GROUP BY side")
    .all(marketId) as { side: Side; total: number }[];
  const yes = rows.find((r) => r.side === "yes")?.total ?? 0;
  const no = rows.find((r) => r.side === "no")?.total ?? 0;
  return { yes, no, total: yes + no };
}

export function betsFor(marketId: number): Bet[] {
  return db.prepare("SELECT * FROM bets WHERE market_id = ?").all(marketId) as unknown as Bet[];
}

export function placeBet(
  spaceId: string,
  userId: string,
  marketId: number,
  side: Side,
  amount: number,
) {
  if (!Number.isInteger(amount) || amount <= 0) throw new BetError("Amount must be a positive whole number.");
  return tx(() => {
    const m = getMarket(spaceId, marketId);
    if (!m) throw new BetError(`No market #${marketId} in this chat.`);
    if (m.status !== "open") throw new BetError(`Market #${marketId} is ${m.status}.`);
    const bal = getBalance(spaceId, userId);
    if (bal < amount) throw new BetError(`You only have ${bal} 🪙.`);
    addBalance(spaceId, userId, -amount);
    db.prepare("INSERT INTO bets (market_id, user_id, side, amount) VALUES (?, ?, ?, ?)").run(
      marketId,
      userId,
      side,
      amount,
    );
    return { market: m, pools: pools(marketId), balance: bal - amount };
  });
}

export function closeMarket(m: Market) {
  db.prepare("UPDATE markets SET status = 'closed' WHERE id = ? AND status = 'open'").run(m.id);
}

export function cancelMarket(m: Market) {
  return tx(() => {
    for (const b of betsFor(m.id)) addBalance(m.space_id, b.user_id, b.amount);
    db.prepare("UPDATE markets SET status = 'cancelled' WHERE id = ?").run(m.id);
  });
}

/**
 * Parimutuel settlement: winners split the whole pot pro-rata to their stake.
 * If nobody backed the winning side, everyone is refunded.
 */
export function resolveMarket(m: Market, outcome: Side) {
  return tx(() => {
    const fresh = getMarket(m.space_id, m.id)!;
    if (fresh.status === "resolved" || fresh.status === "cancelled") {
      throw new BetError(`Market #${m.id} is already ${fresh.status}.`);
    }
    const all = betsFor(m.id);
    const p = pools(m.id);
    const winPool = p[outcome];
    const payouts = new Map<string, number>();

    if (winPool === 0) {
      for (const b of all) payouts.set(b.user_id, (payouts.get(b.user_id) ?? 0) + b.amount);
    } else {
      // Floor each payout, then hand leftover rounding chips to the biggest winner.
      let paid = 0;
      for (const b of all.filter((b) => b.side === outcome)) {
        const share = Math.floor((b.amount / winPool) * p.total);
        payouts.set(b.user_id, (payouts.get(b.user_id) ?? 0) + share);
        paid += share;
      }
      const top = [...payouts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && p.total - paid > 0) payouts.set(top[0], top[1] + (p.total - paid));
    }

    for (const [user, amt] of payouts) addBalance(m.space_id, user, amt);
    db.prepare("UPDATE markets SET status = 'resolved', outcome = ? WHERE id = ?").run(outcome, m.id);

    const staked = new Map<string, number>();
    for (const b of all) staked.set(b.user_id, (staked.get(b.user_id) ?? 0) + b.amount);
    return { payouts, staked, pools: p, refunded: winPool === 0 };
  });
}
