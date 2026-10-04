import type { Market, Side } from "./db.ts";
import { PLAY } from "./db.ts";
import { pct } from "./external/index.ts";
import { displayName, impliedYes, oddsHistory, pools, stakes } from "./markets.ts";
import { usd } from "./money.ts";
import { bold } from "./voice.ts";
import { describeWhen } from "./when.ts";

// Every reply about a market is laid out the same way, in plain iMessage text:
//
//   Vishnav · YES 50 · first in
//   ━━━━━━━━━━━━━━
//   will harish stay up 30 more mins?        (bold)
//   #51 · 50 pot · 1 in
//
//   YES 64%  ↑9  ·  NO 36%
//   ▰▰▰▰▰▰▱▱▱▱  64% chance
//   ▁▁▂▃▅█  since open
//
//   10 on YES → 10 back
//   10 on NO → 60 back
//      (no one's on NO yet)
//   ━━━━━━━━━━━━━━
//   !yes 51 10   !no 51 10
//
// Lines stay short so nothing wraps mid-line in a phone-width bubble.

export const RULE = "━━━━━━━━━━━━━━";

/** 50 (coins) or $50: plain numbers in play money, dollars in real money. */
export const amt = (cents: number) => (PLAY ? (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) : usd(cents));

/** Example bet size in the call-to-action lines. */
export const HINT = PLAY ? 50 : 5;

const BAR = 10;
export const bar = (yes: number) => {
  const n = Math.min(BAR, Math.max(0, Math.round(yes * BAR)));
  return `${"▰".repeat(n)}${"▱".repeat(BAR - n)}  ${pct(yes)} chance`;
};

const SPARKS = "▁▂▃▄▅▆▇█";
/** The odds since open as a tiny sparkline, or null before any bets. */
function sparkline(m: Market): string | null {
  const pts = oddsHistory(m).map((p) => p.yes);
  if (pts.length < 2) return null;
  const last = pts.slice(-8);
  const lo = Math.min(...last);
  const hi = Math.max(...last);
  const step = (v: number) => (hi - lo < 0.02 ? 3 : Math.round(((v - lo) / (hi - lo)) * (SPARKS.length - 1)));
  return `${last.map((v) => SPARKS[step(v)]).join("")}  since open`;
}

/** What `cents` on `side` would pay back right now if it wins. */
function wouldPay(m: Market, side: Side, cents: number) {
  const p = pools(m.id);
  return Math.floor((cents / (p[side] + cents)) * (p.total + cents));
}

/** "YES 64%  ↑9  ·  NO 36%" with the move since open. */
function oddsHeadline(m: Market) {
  const yes = impliedYes(m);
  const moved = m.prior == null ? 0 : Math.round((yes - m.prior) * 100);
  const arrow = moved ? `  ${moved > 0 ? "↑" : "↓"}${Math.abs(moved)}` : "";
  return `${bold(`YES ${pct(yes)}`)}${arrow}  ·  NO ${pct(1 - yes)}`;
}

/** "#51 · 50 pot · 1 in" (plus close time). */
function subline(m: Market) {
  const p = pools(m.id);
  const people = new Set(stakes(m.id).map((s) => s.user_id)).size;
  const money = p.total ? `${amt(p.total)} pot · ${people} in` : "no bets yet";
  const closes = m.status === "open" && m.closes_at ? `\n⏳ closes ${describeWhen(m.closes_at)}` : "";
  return `#${m.id} · ${money}${closes}`;
}

/** The middle of every card: question, odds, bar, sparkline, payouts. */
export function marketBlock(m: Market): string[] {
  const p = pools(m.id);
  const lines = [bold(m.question), subline(m), "", oddsHeadline(m), bar(impliedYes(m))];
  const spark = sparkline(m);
  if (spark) lines.push(spark);
  if (m.status === "open") {
    const ex = HINT * 100;
    lines.push("", `${amt(ex)} on YES → ${amt(wouldPay(m, "yes", ex))} back`, `${amt(ex)} on NO → ${amt(wouldPay(m, "no", ex))} back`);
    if (p.total && !(p.yes && p.no)) lines.push(`   (no one's on ${p.yes ? "NO" : "YES"} yet)`);
  } else {
    lines.push("", m.status === "closed" ? "🔒 betting closed" : `${m.status}`);
  }
  return lines;
}

const actions = (m: Market) => (m.status === "open" ? [RULE, `!yes ${m.id} ${HINT}   !no ${m.id} ${HINT}`] : []);

/** Reply to a bet. */
export function betCard(m: Market, name: string, side: Side, cents: number, tag: string | null): string {
  const head = `${name} · ${side.toUpperCase()} ${amt(cents)}${tag ? ` · ${tag}` : ""}`;
  return [head, RULE, ...marketBlock(m), ...actions(m)].join("\n");
}

/** `!m`, the live re-post, and anything else that just shows a market. */
export function showCard(m: Market, header: string): string {
  return [header, RULE, ...marketBlock(m), ...actions(m)].join("\n");
}

/** A brand-new market, with the case behind its opening odds. */
export function newCard(m: Market, opener: string, why: string | null, reasons: { yes: string[]; no: string[] } | null): string {
  const lines = [`🆕 ${opener} opened a market`, RULE, bold(m.question), subline(m), "", oddsHeadline(m), bar(impliedYes(m))];
  if (why) lines.push("", why);
  if (reasons?.yes.length) lines.push("", "For YES", ...reasons.yes.map((r) => `+ ${r}`));
  if (reasons?.no.length) lines.push("", "For NO", ...reasons.no.map((r) => `- ${r}`));
  lines.push(RULE, `!yes ${m.id} ${HINT}   !no ${m.id} ${HINT}`);
  return lines.join("\n");
}

/** `!markets`: one short entry per open market. */
export function boardText(ms: Market[]): string {
  const rows = ms.map((m) => {
    const p = pools(m.id);
    const lock = m.status === "closed" ? " · 🔒" : "";
    return [bold(m.question), `#${m.id} · ${p.total ? `${amt(p.total)} pot` : "no bets"}${lock}`, bar(impliedYes(m))].join("\n");
  });
  return [`📋 Open markets`, RULE, rows.join("\n\n")].join("\n");
}

type Transfer = { debtor: string; creditor: string; amount: number };

/** "💰 Vish  +70  (30 → 100)" / "💸 Sam  −50" / "🤝 Priya  even", biggest winner first. */
function resultLines(spaceId: string, nets: Map<string, number>, staked: Map<string, number>, balances?: Map<string, number>) {
  return [...nets]
    .sort((a, b) => b[1] - a[1])
    .map(([u, net]) => {
      const stake = staked.get(u) ?? 0;
      const now = balances?.has(u) ? ` · now ${amt(balances.get(u)!)}` : "";
      const who = displayName(spaceId, u);
      if (net > 0) return `💰 ${who}  +${amt(net)}  (${amt(stake)} → ${amt(stake + net)})${now}`;
      if (net < 0) return `💸 ${who}  −${amt(-net)}${now}`;
      return `🤝 ${who}  even${now}`;
    });
}

/**
 * Settlement: everyone's result, then who pays whom. In play money the coins
 * have already moved, so "who paid who" is just the receipt.
 */
export function resolvedCard(
  m: Market,
  outcome: Side,
  r: { staked: Map<string, number>; nets: Map<string, number>; washed: boolean },
  transfers: Transfer[],
  prefix = "",
  balances?: Map<string, number>,
): string {
  const name = (u: string) => displayName(m.space_id, u);
  const head = `${prefix}🏁 ${bold(`RESOLVED ${outcome.toUpperCase()}`)} ${outcome === "yes" ? "✅" : "❌"}`;
  const lines = [head, RULE, bold(m.question), `#${m.id} · closed at ${pct(impliedYes(m))} · ${amt(pools(m.id).total)} pot`, ""];
  const refunded = PLAY ? "got their coins back" : "owes nothing";
  if (r.staked.size === 0) {
    lines.push("No bets were placed.");
  } else if (r.staked.size === 1) {
    const [u, stake] = [...r.staked][0]!;
    lines.push(`Only ${name(u)} bet, so there was nobody to win from.`, `${name(u)} ${PLAY ? `got ${amt(stake)} back` : "owes nothing"}.`);
  } else if (r.washed) {
    lines.push(`Nobody took ${outcome.toUpperCase()}, so it's a wash.`, `Everyone ${refunded}.`);
  } else if (!transfers.length) {
    lines.push(`Everyone was on ${outcome.toUpperCase()}, so nobody won anything.`, `Everyone ${refunded}.`);
  } else {
    lines.push(bold("Results"), ...resultLines(m.space_id, r.nets, r.staked, balances));
    lines.push("", bold(PLAY ? "Who paid who" : "Who owes who"), ...transfers.map((t) => `${name(t.debtor)} → ${name(t.creditor)}  ${amt(t.amount)}`));
    lines.push("", PLAY ? "Coins already moved. !lb for the standings." : "Payment instructions sent by DM. !owe to check.");
  }
  return lines.join("\n");
}

/** `!close`: betting's locked, so show what each outcome would mean for everyone. */
export function lockedCard(m: Market, ifYes: Map<string, number>, ifNo: Map<string, number>): string {
  const lines = [`🔒 #${m.id} locked · no more bets`, RULE, bold(m.question), `#${m.id} · ${amt(pools(m.id).total)} pot`];
  const staked = new Map<string, number>();
  for (const s of stakes(m.id)) staked.set(s.user_id, (staked.get(s.user_id) ?? 0) + s.amount);
  if (staked.size) {
    lines.push("", bold("If YES"), ...resultLines(m.space_id, ifYes, staked), "", bold("If NO"), ...resultLines(m.space_id, ifNo, staked));
  } else {
    lines.push("", "No bets were placed.");
  }
  lines.push(RULE, `!resolve ${m.id} yes   !resolve ${m.id} no`);
  return lines.join("\n");
}
