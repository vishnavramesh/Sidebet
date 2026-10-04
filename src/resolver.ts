import { type Reply, settlementReply } from "./commands.ts";
import { fetchRef } from "./external/index.ts";
import { onExternalPrice } from "./live.ts";
import { linkedUnresolved, resolveMarket } from "./markets.ts";

type Deliver = (spaceId: string, reply: Reply) => Promise<void>;

/**
 * Poll linked Kalshi/Polymarket markets: track their price for the live chart,
 * and settle ours when theirs settles.
 */
export function startResolver(deliver: Deliver, intervalMs = Number(process.env.RESOLVE_INTERVAL_MS ?? 60_000)) {
  const tick = async () => {
    for (const m of linkedUnresolved()) {
      try {
        const ext = await fetchRef(m.external!);
        if (!ext) continue;
        if (ext.resolved) {
          const r = resolveMarket(m, ext.resolved);
          await deliver(m.space_id, settlementReply(m, ext.resolved, r, "Real market settled. "));
        } else if (ext.yesPrice != null) {
          await onExternalPrice(m, ext.yesPrice, deliver);
        }
      } catch (err) {
        console.warn(`[resolver] #${m.id}`, err);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
