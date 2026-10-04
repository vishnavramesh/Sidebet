import type { Market, Side } from "./db.ts";

// Instant reactions to a bet, shown as a short tag in the bet card's header
// ("Vishnav · YES 50 · first in"). All local and free; the Claude-written
// reactions to chat messages live in detect.ts.

export interface BetMoment {
  market: Market;
  name: string;
  side: Side;
  cents: number;
  /** Pools and odds just before this bet. */
  before: { yes: number; no: number; odds: number };
  after: { odds: number };
  /** Play money: the bettor's balance before the bet. */
  bankroll?: number;
}

/** A short tag when a bet is worth remarking on, or null. Most notable first. */
export function betReaction(b: BetMoment): string | null {
  const mine = b.before[b.side];
  const theirs = b.before[b.side === "yes" ? "no" : "yes"];
  const share = b.bankroll ? b.cents / b.bankroll : 0;
  const swing = Math.round((b.after.odds - b.before.odds) * 100);
  const aboutThem = new RegExp(`\\b${escape(b.name)}`, "i").test(b.market.question);

  if (b.bankroll && b.cents >= b.bankroll) return "‼️ all in";
  if (share >= 0.5) return `‼️ ${Math.round(share * 100)}% of their stack`;
  if (aboutThem) return b.side === "yes" ? "betting on themselves" : "betting against themselves";
  if (mine === 0 && theirs === 0) return "first in";
  if (theirs > mine && b.cents * 4 >= theirs && Math.abs(swing) < 10) return "fading the room";
  if (Math.abs(swing) >= 10) return `moved it ${swing > 0 ? "↑" : "↓"}${Math.abs(swing)}`;
  return null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
