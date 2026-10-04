import { marketCard } from "./charts.ts";
import { oddsLine, type Reply } from "./commands.ts";
import type { Market } from "./db.ts";
import { parseRef } from "./external/index.ts";
import { extHistory, getMarketById, recordExtPrice, setExtPosted } from "./markets.ts";

// Keeps the chart in the chat current: after bets come in, and when the real
// market a group market mirrors moves. iMessage can't host a live widget, so
// "live" means a fresh card each time something real changes.

type Deliver = (spaceId: string, reply: Reply) => Promise<void>;

const CHART_DELAY_MS = Number(process.env.LIVE_CHART_DELAY_MS ?? 15_000);
const MOVE_TO_POST = Number(process.env.KALSHI_MOVE_POINTS ?? 5) / 100;

const timers = new Map<number, NodeJS.Timeout>();

/** Re-post a market's chart once bets stop arriving for a few seconds. */
export function scheduleChart(m: Market, deliver: Deliver) {
  clearTimeout(timers.get(m.id));
  timers.set(
    m.id,
    setTimeout(() => {
      timers.delete(m.id);
      const fresh = getMarketById(m.id);
      if (!fresh || fresh.status === "cancelled") return;
      const ext = extNameAndPrice(fresh);
      void deliver(fresh.space_id, { text: `#${fresh.id} live · ${oddsLine(fresh)}`, image: safeCard(fresh, ext), marketId: fresh.id }).catch((err) =>
        console.warn("[live] chart", err),
      );
    }, CHART_DELAY_MS),
  );
}

function extNameAndPrice(m: Market) {
  if (!m.external) return undefined;
  const last = extHistory(m.id).at(-1);
  return { name: parseRef(m.external)?.source.name ?? "Kalshi", yes: last?.yes ?? null };
}

function safeCard(m: Market, ext?: { name: string; yes: number | null }) {
  try {
    return marketCard(m, ext);
  } catch (err) {
    console.warn("[live] render", err);
    return undefined;
  }
}

/**
 * Called by the resolver each time it fetches a linked market's price.
 * Stores the point for the chart and posts when the price really moved.
 */
export async function onExternalPrice(m: Market, yes: number, deliver: Deliver) {
  const last = extHistory(m.id).at(-1);
  if (!last || Math.abs(last.yes - yes) >= 0.01) recordExtPrice(m.id, yes);
  if (m.status !== "open" || m.ext_posted_yes == null) {
    if (m.ext_posted_yes == null) setExtPosted(m, yes);
    return;
  }
  if (Math.abs(yes - m.ext_posted_yes) < MOVE_TO_POST) return;
  const name = parseRef(m.external!)?.source.name ?? "Kalshi";
  const from = Math.round(m.ext_posted_yes * 100);
  setExtPosted(m, yes);
  await deliver(m.space_id, {
    text: `${name} moved on #${m.id}: ${from}% → ${Math.round(yes * 100)}%\n${oddsLine(m)}`,
    marketId: m.id,
    image: safeCard(m, { name, yes }),
  });
}
