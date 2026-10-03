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
    for (const ev of data.current_page ?? []) {
      // Multi-outcome events have many markets; surface the most relevant few.
      for (const m of ev.markets.slice(0, 2)) {
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
