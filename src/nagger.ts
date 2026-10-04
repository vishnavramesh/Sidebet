import type { Debt, Market } from "./db.ts";
import { displayName, dueDebts, getMarketById, getProfile, recordNag } from "./markets.ts";
import { plainAmount, usd } from "./money.ts";

// The bot can't move money (Apple Cash has no API). Instead it DMs whoever
// lost, tells them exactly who to pay and how, and keeps at it until the
// winner confirms with !got.

export type Dm = { to: string; text: string };
type Send = { dm: (userId: string, text: string) => Promise<void>; announce: (spaceId: string, text: string) => Promise<void> };

const HOUR = 3_600_000;
const QUIET_START = Number(process.env.QUIET_START ?? 22); // no DMs from 10pm…
const QUIET_END = Number(process.env.QUIET_END ?? 9); // …to 9am, local time
const PUBLIC_AFTER = Number(process.env.NAG_PUBLIC_AFTER ?? 2); // call out in the group after this many DMs
const PUBLIC = process.env.NAG_PUBLIC !== "off";

/** Gaps between reminders, by how many have already gone out. */
const GAPS_H = [6, 12, 24];
const gapAfter = (nags: number) => (GAPS_H[nags] ?? 24) * HOUR;

const days = (d: Debt) => Math.max(1, Math.ceil((Date.now() - d.created_at) / (24 * HOUR)));

/** How to pay: Apple Cash steps, plus one-tap links if the winner set handles. */
export function howToPay(d: Debt, m: Market): string {
  const who = displayName(d.space_id, d.creditor);
  const p = getProfile(d.creditor);
  const note = encodeURIComponent(`Sidebet #${m.id}`);
  const lines = [`Apple Cash: open your chat with ${who}, tap +, then Apple Cash, then ${usd(d.amount)}.`];
  if (p.venmo) lines.push(`Venmo: https://venmo.com/${p.venmo}?txn=pay&amount=${plainAmount(d.amount)}&note=${note}`);
  if (p.cashapp) lines.push(`Cash App: https://cash.app/$${p.cashapp}/${plainAmount(d.amount)}`);
  lines.push(`Then reply !paid ${d.id}`);
  return lines.join("\n");
}

/** The first DMs right after a market settles. */
export function settlementDms(m: Market, debts: Debt[]): Dm[] {
  const out: Dm[] = [];
  for (const d of debts) {
    const winner = displayName(d.space_id, d.creditor);
    const loser = displayName(d.space_id, d.debtor);
    out.push({
      to: d.debtor,
      text: `#${m.id} "${m.question}" resolved ${m.outcome?.toUpperCase()}.\nYou owe ${winner} ${usd(d.amount)} (IOU ${d.id}).\n\n${howToPay(d, m)}`,
    });
    out.push({
      to: d.creditor,
      text: `You won ${usd(d.amount)} from ${loser} on #${m.id}. Reminders will go out until you reply !got ${d.id}.${
        getProfile(d.creditor).venmo || getProfile(d.creditor).cashapp ? "" : "\nTip: !venmo yourname or !cashapp yourtag adds a one-tap pay link."
      }`,
    });
  }
  return out;
}

/** Reminders get less polite as they go. */
function nagText(d: Debt, m: Market): string {
  const amt = usd(d.amount);
  const who = displayName(d.space_id, d.creditor);
  const lines = [
    `Reminder: you owe ${who} ${amt} for #${m.id}. Reply !paid ${d.id} once it's sent.`,
    `Reminder #2: ${amt} to ${who} is still outstanding.`,
    `Reminder #3: ${amt} to ${who} is still unpaid.`,
    `Reminder #${d.nags + 1}: ${amt} to ${who}. Reminders continue until !paid ${d.id}.`,
    `Reminder #${d.nags + 1}: ${amt} to ${who}, outstanding for ${days(d)} days.`,
    `Reminder #${d.nags + 1}: ${amt} to ${who}. Reply !paid ${d.id} to stop these.`,
    `Day ${days(d)}: ${amt} to ${who} is still unpaid.`,
  ];
  const text = lines[Math.min(d.nags, lines.length - 1)]!;
  // Repeat the pay instructions every few nags so they're never far up the thread.
  return d.nags % 3 === 0 ? `${text}\n\n${howToPay(d, m)}` : text;
}

function quietNow() {
  const h = new Date().getHours();
  return QUIET_START > QUIET_END ? h >= QUIET_START || h < QUIET_END : h >= QUIET_START && h < QUIET_END;
}

export function startNagger(send: Send, intervalMs = Number(process.env.NAG_INTERVAL_MS ?? 10 * 60_000)) {
  const tick = async () => {
    if (quietNow()) return;
    for (const d of dueDebts()) {
      const m = getMarketById(d.market_id);
      if (!m) continue;
      try {
        await send.dm(d.debtor, nagText(d, m));
        const goPublic = PUBLIC && d.nags + 1 >= PUBLIC_AFTER && Date.now() - d.last_public_at > 24 * HOUR;
        if (goPublic) {
          await send.announce(
            d.space_id,
            `${displayName(d.space_id, d.debtor)} still owes ${displayName(d.space_id, d.creditor)} ${usd(d.amount)} from #${m.id} (day ${days(d)}).`,
          );
        }
        recordNag(d.id, Date.now() + gapAfter(d.nags + 1), goPublic ? Date.now() : undefined);
      } catch (err) {
        console.warn(`[nagger] IOU ${d.id}`, err);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
