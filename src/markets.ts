import { type Bet, DAILY_COINS, type Debt, MAX_BET_CENTS, PLAY, type Market, STARTING_COINS, type Side, db, tx } from "./db.ts";
import { contactName } from "./history.ts";
import { usd } from "./money.ts";

export class BetError extends Error {}

// ---------- users ----------

export function ensureUser(spaceId: string, userId: string) {
  db.prepare("INSERT OR IGNORE INTO users (space_id, user_id, balance) VALUES (?, ?, 0)").run(spaceId, userId);
}

export function setName(spaceId: string, userId: string, name: string) {
  ensureUser(spaceId, userId);
  db.prepare("UPDATE users SET name = ? WHERE space_id = ? AND user_id = ?").run(name, spaceId, userId);
}

export function displayName(spaceId: string, userId: string): string {
  const row = db
    .prepare("SELECT name FROM users WHERE space_id = ? AND user_id = ?")
    .get(spaceId, userId) as { name: string | null } | undefined;
  if (row?.name) return row.name;
  if (userId === "me") return process.env.OWNER_NAME || "me"; // the Mac's owner
  const contact = contactName(userId);
  if (contact && userId !== "me") return contact.split(" ")[0]!;
  // Phone numbers / emails are ugly in a group chat; show a short tail.
  const digits = userId.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : userId.split("@")[0]!;
}

/** True if this person has ever been seen in a chat the bot runs in. */
export function isKnownUser(userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE user_id = ? LIMIT 1").get(userId);
}

/** All-time net winnings per person in a chat, from settled debts. */
export function leaderboard(spaceId: string, limit = 10) {
  return db
    .prepare(
      `SELECT user_id, SUM(delta) AS net FROM (
         SELECT creditor AS user_id, amount AS delta FROM debts WHERE space_id = ? AND status != 'forgiven'
         UNION ALL
         SELECT debtor, -amount FROM debts WHERE space_id = ? AND status != 'forgiven'
       ) GROUP BY user_id ORDER BY net DESC LIMIT ?`,
    )
    .all(spaceId, spaceId, limit) as { user_id: string; net: number }[];
}

// ---------- play-money wallets ----------

export function balance(spaceId: string, userId: string): number {
  db.prepare("INSERT OR IGNORE INTO wallets (space_id, user_id, coins) VALUES (?, ?, ?)").run(spaceId, userId, STARTING_COINS);
  return (db.prepare("SELECT coins FROM wallets WHERE space_id = ? AND user_id = ?").get(spaceId, userId) as { coins: number }).coins;
}

function addCoins(spaceId: string, userId: string, delta: number) {
  balance(spaceId, userId);
  db.prepare("UPDATE wallets SET coins = coins + ? WHERE space_id = ? AND user_id = ?").run(delta, spaceId, userId);
}

/** +100 coins once per day. Returns the new balance, or null if already claimed. */
export function claimDaily(spaceId: string, userId: string): number | null {
  balance(spaceId, userId);
  const today = Math.floor(Date.now() / 86_400_000);
  const row = db.prepare("SELECT last_daily FROM wallets WHERE space_id = ? AND user_id = ?").get(spaceId, userId) as { last_daily: number };
  if (row.last_daily >= today) return null;
  db.prepare("UPDATE wallets SET coins = coins + ?, last_daily = ? WHERE space_id = ? AND user_id = ?").run(DAILY_COINS, today, spaceId, userId);
  return balance(spaceId, userId);
}

export function richList(spaceId: string, limit = 10) {
  return db
    .prepare("SELECT user_id, coins AS net FROM wallets WHERE space_id = ? ORDER BY coins DESC LIMIT ?")
    .all(spaceId, limit) as { user_id: string; net: number }[];
}

// ---------- markets ----------

export function createMarket(spaceId: string, creator: string, question: string, external: string | null = null): Market {
  ensureUser(spaceId, creator);
  const res = db
    .prepare("INSERT INTO markets (space_id, question, creator, external, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(spaceId, question, creator, external, Date.now());
  return getMarket(spaceId, Number(res.lastInsertRowid))!;
}

export function getMarket(spaceId: string, id: number): Market | undefined {
  return db.prepare("SELECT * FROM markets WHERE id = ? AND space_id = ?").get(id, spaceId) as Market | undefined;
}

export function getMarketById(id: number): Market | undefined {
  return db.prepare("SELECT * FROM markets WHERE id = ?").get(id) as Market | undefined;
}

export function listMarkets(spaceId: string, statuses: string[] = ["open", "closed"]) {
  const ph = statuses.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM markets WHERE space_id = ? AND status IN (${ph}) ORDER BY id DESC LIMIT 8`)
    .all(spaceId, ...statuses) as unknown as Market[];
}

export function linkedUnresolved(): Market[] {
  return db
    .prepare("SELECT * FROM markets WHERE external IS NOT NULL AND status IN ('open','closed')")
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
  return db.prepare("SELECT * FROM bets WHERE market_id = ? ORDER BY id").all(marketId) as unknown as Bet[];
}

// The opening odds act like PRIOR_WEIGHT dollars (or coins) of imaginary money already in
// the pot, so the first real $1 bet nudges the odds instead of slamming them to
// 0% or 100%. Payouts only ever use real money.
const PRIOR_WEIGHT = Number(process.env.PRIOR_WEIGHT ?? (PLAY ? 200 : 20)) * 100;

const blend = (prior: number | null, yes: number, total: number) =>
  ((prior ?? 0.5) * PRIOR_WEIGHT + yes) / (PRIOR_WEIGHT + total);

/** Current YES probability: opening odds blended with where the money is. */
export function impliedYes(m: Market): number {
  const p = pools(m.id);
  return blend(m.prior, p.yes, p.total);
}

/** YES probability at open and after each bet, for the chart. */
export function oddsHistory(m: Market): { t: number; yes: number }[] {
  let y = 0;
  let total = 0;
  const points = [{ t: m.created_at, yes: blend(m.prior, 0, 0) }];
  for (const b of betsFor(m.id)) {
    if (b.side === "yes") y += b.amount;
    total += b.amount;
    points.push({ t: b.created_at, yes: blend(m.prior, y, total) });
  }
  return points;
}

/** What $1 on each side pays back if it wins, at the current pot. */
export function payouts(marketId: number) {
  const p = pools(marketId);
  const x = (side: number) => (side > 0 ? p.total / side : null);
  return { yes: x(p.yes), no: x(p.no), total: p.total };
}

export function setPrior(m: Market, prior: number, why: string | null, reasons?: { yes: string[]; no: string[] }) {
  const json = reasons ? JSON.stringify(reasons) : null;
  db.prepare("UPDATE markets SET prior = ?, prior_why = ?, prior_case = ? WHERE id = ?").run(prior, why, json, m.id);
  m.prior = prior;
  m.prior_why = why;
  m.prior_case = json;
}

export function latestOpenMarket(spaceId: string): Market | undefined {
  return db.prepare("SELECT * FROM markets WHERE space_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(spaceId) as
    | Market
    | undefined;
}

/** Manual markets this person opened that still need resolving, newest first. */
export function unresolvedBy(spaceId: string, userId: string): Market[] {
  return db
    .prepare("SELECT * FROM markets WHERE space_id = ? AND creator = ? AND external IS NULL AND status IN ('open','closed') ORDER BY id DESC LIMIT 5")
    .all(spaceId, userId) as unknown as Market[];
}

// ---------- close times ----------

export function setCloseTime(m: Market, at: number) {
  db.prepare("UPDATE markets SET closes_at = ?, close_warned = 0 WHERE id = ?").run(at, m.id);
  m.closes_at = at;
}

/** Open markets closing within `withinMs` that haven't had their last call. */
export function closingSoon(withinMs: number, now = Date.now()): Market[] {
  return db
    .prepare("SELECT * FROM markets WHERE status = 'open' AND close_warned = 0 AND closes_at > ? AND closes_at <= ?")
    .all(now, now + withinMs) as unknown as Market[];
}

export function markWarned(m: Market) {
  db.prepare("UPDATE markets SET close_warned = 1 WHERE id = ?").run(m.id);
}

export function pastCloseTime(now = Date.now()): Market[] {
  return db.prepare("SELECT * FROM markets WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at <= ?").all(now) as unknown as Market[];
}

/** Closed manual markets nobody has resolved, last nudged more than `everyMs` ago. */
export function awaitingResolution(everyMs: number, now = Date.now()): Market[] {
  return db
    .prepare("SELECT * FROM markets WHERE status = 'closed' AND external IS NULL AND reminded_at <= ?")
    .all(now - everyMs) as unknown as Market[];
}

export function markReminded(m: Market, now = Date.now()) {
  db.prepare("UPDATE markets SET reminded_at = ? WHERE id = ?").run(now, m.id);
}

// ---------- real-market price tracking ----------

export function recordExtPrice(marketId: number, yes: number) {
  db.prepare("INSERT INTO ext_prices (market_id, t, yes) VALUES (?, ?, ?)").run(marketId, Date.now(), yes);
}

export function extHistory(marketId: number) {
  return db.prepare("SELECT t, yes FROM ext_prices WHERE market_id = ? ORDER BY t").all(marketId) as { t: number; yes: number }[];
}

export function setExtPosted(m: Market, yes: number) {
  db.prepare("UPDATE markets SET ext_posted_yes = ? WHERE id = ?").run(yes, m.id);
  m.ext_posted_yes = yes;
}

/** Each person's total stake on each side. */
export function stakes(marketId: number) {
  return db
    .prepare("SELECT user_id, side, SUM(amount) AS amount FROM bets WHERE market_id = ? GROUP BY user_id, side ORDER BY amount DESC")
    .all(marketId) as { user_id: string; side: Side; amount: number }[];
}

export function placeBet(spaceId: string, userId: string, marketId: number, side: Side, cents: number) {
  if (!Number.isFinite(cents) || cents <= 0) throw new BetError("Invalid amount. Try !yes 1 5 or !yes 1 2.50");
  return tx(() => {
    const m = getMarket(spaceId, marketId);
    if (!m) throw new BetError(`No market #${marketId} in this chat.`);
    if (m.status !== "open") throw new BetError(`#${marketId} is ${m.status}.`);
    ensureUser(spaceId, userId);
    const already = (
      db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM bets WHERE market_id = ? AND user_id = ?").get(marketId, userId) as {
        s: number;
      }
    ).s;
    if (PLAY) {
      const bal = balance(spaceId, userId);
      if (cents > bal) throw new BetError(`You only have ${usd(bal)}.`);
      addCoins(spaceId, userId, -cents);
    } else if (already + cents > MAX_BET_CENTS) {
      throw new BetError(`Max is ${usd(MAX_BET_CENTS)} per person per market. You have ${usd(already)} in.`);
    }
    db.prepare("INSERT INTO bets (market_id, user_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)").run(
      marketId,
      userId,
      side,
      cents,
      Date.now(),
    );
    return { market: m, pools: pools(marketId) };
  });
}

export function closeMarket(m: Market) {
  db.prepare("UPDATE markets SET status = 'closed' WHERE id = ? AND status = 'open'").run(m.id);
}

/** Voids every bet. Play money goes back to wallets; real money never moved. */
export function cancelMarket(m: Market) {
  tx(() => {
    if (PLAY) for (const b of betsFor(m.id)) addCoins(m.space_id, b.user_id, b.amount);
    db.prepare("UPDATE markets SET status = 'cancelled' WHERE id = ?").run(m.id);
  });
}

/** What each bettor would net if the market resolved `outcome` now (all zero if nobody's on that side). */
export function projectedNets(marketId: number, outcome: Side): Map<string, number> {
  const p = pools(marketId);
  const nets = new Map<string, number>();
  for (const s of stakes(marketId)) {
    const won = p[outcome] > 0 && s.side === outcome ? Math.floor((s.amount / p[outcome]) * p.total) : p[outcome] > 0 ? 0 : s.amount;
    nets.set(s.user_id, (nets.get(s.user_id) ?? 0) + won - s.amount);
  }
  return nets;
}

/**
 * Turn per-person net results into the fewest payments: the biggest loser pays
 * the biggest winner until everyone is square.
 */
export function minimalTransfers(nets: Map<string, number>) {
  const owe = [...nets].filter(([, v]) => v < 0).map(([u, v]) => ({ u, v: -v })).sort((a, b) => b.v - a.v);
  const get = [...nets].filter(([, v]) => v > 0).map(([u, v]) => ({ u, v })).sort((a, b) => b.v - a.v);
  const out: { debtor: string; creditor: string; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < owe.length && j < get.length) {
    const amount = Math.min(owe[i]!.v, get[j]!.v);
    if (amount > 0) out.push({ debtor: owe[i]!.u, creditor: get[j]!.u, amount });
    owe[i]!.v -= amount;
    get[j]!.v -= amount;
    if (owe[i]!.v === 0) i++;
    if (get[j]!.v === 0) j++;
  }
  return out;
}

/**
 * Parimutuel settlement: winners split the whole pot pro-rata to their stake.
 * If nobody backed the winning side, the market is a wash. Records who owes
 * whom as debts; the nagger chases them.
 */
export function resolveMarket(m: Market, outcome: Side) {
  return tx(() => {
    const fresh = getMarket(m.space_id, m.id)!;
    if (fresh.status === "resolved" || fresh.status === "cancelled") {
      throw new BetError(`#${m.id} is already ${fresh.status}.`);
    }
    const all = betsFor(m.id);
    const p = pools(m.id);
    const winPool = p[outcome];

    const staked = new Map<string, number>();
    for (const b of all) staked.set(b.user_id, (staked.get(b.user_id) ?? 0) + b.amount);

    const payouts = new Map<string, number>();
    if (winPool > 0) {
      // Floor each payout, then hand leftover cents to the biggest winner.
      let paid = 0;
      for (const b of all.filter((b) => b.side === outcome)) {
        const share = Math.floor((b.amount / winPool) * p.total);
        payouts.set(b.user_id, (payouts.get(b.user_id) ?? 0) + share);
        paid += share;
      }
      const top = [...payouts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && p.total - paid > 0) payouts.set(top[0], top[1] + (p.total - paid));
    }

    const nets = new Map<string, number>();
    if (winPool > 0) for (const [u, s] of staked) nets.set(u, (payouts.get(u) ?? 0) - s);

    db.prepare("UPDATE markets SET status = 'resolved', outcome = ? WHERE id = ?").run(outcome, m.id);

    if (PLAY) {
      // Coins: winners get their payout, a wash refunds everyone. Nothing owed.
      if (winPool > 0) for (const [u, amt] of payouts) addCoins(m.space_id, u, amt);
      else for (const [u, s] of staked) addCoins(m.space_id, u, s);
      return { nets, staked, pools: p, washed: winPool === 0, debts: [] as Debt[] };
    }

    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO debts (space_id, market_id, debtor, creditor, amount, next_nag_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const debts: Debt[] = minimalTransfers(nets).map((t) => {
      const res = insert.run(m.space_id, m.id, t.debtor, t.creditor, t.amount, now + firstNagDelayMs(), now);
      return getDebt(Number(res.lastInsertRowid))!;
    });

    return { nets, staked, pools: p, washed: winPool === 0, debts };
  });
}

// ---------- debts ----------

const firstNagDelayMs = () => Number(process.env.NAG_FIRST_HOURS ?? 3) * 3_600_000;

export function getDebt(id: number): Debt | undefined {
  return db.prepare("SELECT * FROM debts WHERE id = ?").get(id) as Debt | undefined;
}

export function openDebtsFor(userId: string) {
  return db
    .prepare("SELECT * FROM debts WHERE (debtor = ? OR creditor = ?) AND status IN ('owed','claimed') ORDER BY id")
    .all(userId, userId) as unknown as Debt[];
}

export function openDebtsInSpace(spaceId: string) {
  return db
    .prepare("SELECT * FROM debts WHERE space_id = ? AND status IN ('owed','claimed') ORDER BY amount DESC")
    .all(spaceId) as unknown as Debt[];
}

export function dueDebts(now = Date.now()) {
  return db.prepare("SELECT * FROM debts WHERE status = 'owed' AND next_nag_at <= ?").all(now) as unknown as Debt[];
}

export function setDebtStatus(id: number, status: Debt["status"], nextNagAt?: number) {
  if (nextNagAt == null) db.prepare("UPDATE debts SET status = ? WHERE id = ?").run(status, id);
  else db.prepare("UPDATE debts SET status = ?, next_nag_at = ? WHERE id = ?").run(status, nextNagAt, id);
}

export function recordNag(id: number, nextNagAt: number, publicAt?: number) {
  db.prepare(
    "UPDATE debts SET nags = nags + 1, next_nag_at = ?, last_public_at = COALESCE(?, last_public_at) WHERE id = ?",
  ).run(nextNagAt, publicAt ?? null, id);
}

// ---------- payment handles ----------

export function getProfile(userId: string) {
  return (db.prepare("SELECT venmo, cashapp FROM profiles WHERE user_id = ?").get(userId) ?? {}) as {
    venmo?: string | null;
    cashapp?: string | null;
  };
}

export function setHandle(userId: string, kind: "venmo" | "cashapp", handle: string) {
  db.prepare("INSERT OR IGNORE INTO profiles (user_id) VALUES (?)").run(userId);
  db.prepare(`UPDATE profiles SET ${kind} = ? WHERE user_id = ?`).run(handle, userId);
}
