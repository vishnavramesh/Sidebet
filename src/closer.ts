import type { Reply } from "./commands.ts";
import { awaitingResolution, closeMarket, closingSoon, displayName, markReminded, markWarned, pastCloseTime } from "./markets.ts";

// Close times: a last call shortly before, an automatic lock at the time, then
// a reminder to the creator until they resolve it.

type Deliver = (spaceId: string, reply: Reply) => Promise<void>;

const LAST_CALL_MS = Number(process.env.LAST_CALL_MINUTES ?? 15) * 60_000;
const REMIND_EVERY_MS = Number(process.env.RESOLVE_REMIND_HOURS ?? 12) * 3_600_000;

export function startCloser(deliver: Deliver, intervalMs = 30_000) {
  const tick = async () => {
    const now = Date.now();
    for (const m of closingSoon(LAST_CALL_MS, now)) {
      markWarned(m);
      const mins = Math.max(1, Math.round((m.closes_at! - now) / 60_000));
      await deliver(m.space_id, { text: `Last call: #${m.id} closes in ${mins} min.\n${m.question}`, marketId: m.id });
    }
    for (const m of pastCloseTime(now)) {
      closeMarket(m);
      markReminded(m, now);
      const next = m.external
        ? "It settles automatically when the real market does."
        : `${displayName(m.space_id, m.creator)}, resolve it with !resolve ${m.id} yes|no`;
      await deliver(m.space_id, { text: `#${m.id} is closed. No more bets.\n${next}`, marketId: m.id });
    }
    for (const m of awaitingResolution(REMIND_EVERY_MS, now)) {
      markReminded(m, now);
      await deliver(m.space_id, {
        text: `Reminder: #${m.id} is closed but not resolved.\n${displayName(m.space_id, m.creator)}, settle it with !resolve ${m.id} yes|no`,
        marketId: m.id,
      });
    }
  };
  const timer = setInterval(() => void tick().catch((err) => console.warn("[closer]", err)), intervalMs);
  void tick().catch((err) => console.warn("[closer]", err));
  return () => clearInterval(timer);
}
