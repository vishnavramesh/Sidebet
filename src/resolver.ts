import { fetchRef } from "./external/index.ts";
import { linkedUnresolved, resolveMarket } from "./markets.ts";
import { settlementMessage } from "./commands.ts";

type Announce = (spaceId: string, text: string) => Promise<void>;

/** Poll linked Kalshi/Polymarket markets and settle ours when theirs settles. */
export function startResolver(announce: Announce, intervalMs = Number(process.env.RESOLVE_INTERVAL_MS ?? 60_000)) {
  const tick = async () => {
    for (const m of linkedUnresolved()) {
      try {
        const ext = await fetchRef(m.external!);
        if (!ext?.resolved) continue;
        const r = resolveMarket(m, ext.resolved);
        await announce(m.space_id, `📡 ${ext.title} settled on the real market.\n${settlementMessage(m, ext.resolved, r)}`);
      } catch (err) {
        console.warn(`[resolver] #${m.id}`, err);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
