import type { ExternalMarket, ExternalSource } from "./index.ts";
import { getJson } from "./index.ts";

// Public, unauthenticated market data. Trading would need per-user API keys
// (RSA-signed requests) — see README "Stretch goals".
const BASE = "https://api.elections.kalshi.com";

const num = (s: string | undefined | null) => {
  const n = s == null || s === "" ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
};

interface SearchResp {
  current_page: {
    event_ticker: string;
    event_title: string;
    series_ticker: string;
    markets: {
      ticker: string;
      title: string;
      yes_subtitle?: string;
      result: string;
      yes_bid_dollars?: string;
      yes_ask_dollars?: string;
      last_price_dollars?: string;
    }[];
  }[];
}

interface MarketResp {
  market: {
    ticker: string;
    event_ticker: string;
    title: string;
    yes_sub_title?: string;
    status: string;
    result: string;
    yes_bid_dollars?: string;
    yes_ask_dollars?: string;
    last_price_dollars?: string;
  };
}

function mid(bid?: string, ask?: string, last?: string) {
  const b = num(bid);
  const a = num(ask);
  if (b != null && a != null && a > 0 && a >= b) return (a + b) / 2;
  return num(last);
}

const url = (eventTicker: string) =>
  `https://kalshi.com/markets/${eventTicker.split("-")[0]!.toLowerCase()}`;

export const kalshi: ExternalSource = {
  prefix: "kalshi",
  name: "Kalshi",

  async search(query, limit = 3) {
    const data = await getJson<SearchResp>(
      `${BASE}/v1/search/series?query=${encodeURIComponent(query)}&page_size=${limit}`,
    );
    const out: ExternalMarket[] = [];
    const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const hits = (m: SearchResp["current_page"][number]["markets"][number]) => {
      const text = `${m.yes_subtitle ?? ""} ${m.title}`.toLowerCase();
      return terms.filter((w) => text.includes(w)).length;
    };
    for (const ev of data.current_page ?? []) {
      // Multi-outcome events (e.g. 32 Super Bowl teams) have many markets;
      // surface the outcomes the query names, else the first couple.
      const ranked = ev.markets.map((m, i) => ({ m, i, h: hits(m) })).sort((a, b) => b.h - a.h || a.i - b.i);
      for (const { m } of ranked.slice(0, 2)) {
        const sub = m.yes_subtitle && ev.markets.length > 1 ? ` (${m.yes_subtitle})` : "";
        out.push({
          ref: `kalshi:${m.ticker}`,
          title: (m.title || ev.event_title) + sub,
          yesPrice: mid(m.yes_bid_dollars, m.yes_ask_dollars, m.last_price_dollars),
          url: url(ev.event_ticker),
          resolved: m.result === "yes" || m.result === "no" ? m.result : null,
        });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  },

  async get(ticker) {
    try {
      const { market: m } = await getJson<MarketResp>(
        `${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker.toUpperCase())}`,
      );
      const settled = ["settled", "finalized", "determined"].includes(m.status);
      return {
        ref: `kalshi:${m.ticker}`,
        title: m.title,
        yesPrice: mid(m.yes_bid_dollars, m.yes_ask_dollars, m.last_price_dollars),
        url: url(m.event_ticker),
        resolved: settled && (m.result === "yes" || m.result === "no") ? m.result : null,
      };
    } catch {
      return null;
    }
  },
};

interface ListResp {
  markets: { ticker: string; yes_sub_title?: string; close_time: string; yes_bid_dollars?: string; yes_ask_dollars?: string }[];
}

/**
 * For live demos: the hourly crypto market closing soonest (but not too soon)
 * whose odds are closest to a coin flip, phrased as a plain question.
 */
export async function soonestCoinFlip(asset: "btc" | "eth", minMinutes = 10, maxMinutes = 180) {
  const series = asset === "eth" ? "KXETHD" : "KXBTCD";
  const name = asset === "eth" ? "Ethereum" : "Bitcoin";
  const now = Math.floor(Date.now() / 1000);
  const { markets } = await getJson<ListResp>(
    `${BASE}/trade-api/v2/markets?series_ticker=${series}&status=open&min_close_ts=${now + minMinutes * 60}&max_close_ts=${now + maxMinutes * 60}&limit=500`,
  );
  const priced = markets
    .map((m) => ({ m, p: mid(m.yes_bid_dollars, m.yes_ask_dollars) }))
    .filter((x): x is { m: (typeof markets)[number]; p: number } => x.p != null);
  if (!priced.length) return null;
  const firstClose = priced.map((x) => x.m.close_time).sort()[0];
  const best = priced.filter((x) => x.m.close_time === firstClose).sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5))[0]!;
  const closesAt = new Date(best.m.close_time);
  const when = closesAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return {
    ref: `kalshi:${best.m.ticker}`,
    question: `Will ${name} be ${best.m.yes_sub_title ?? "above the line"} at ${when}?`,
    yesPrice: best.p,
    closesAt: closesAt.getTime(),
  };
}
