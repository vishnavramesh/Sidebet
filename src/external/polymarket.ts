import type { ExternalMarket, ExternalSource } from "./index.ts";
import { getJson } from "./index.ts";

const BASE = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  outcomes: string; // JSON string, e.g. '["Yes","No"]'
  outcomePrices: string; // JSON string, e.g. '["0.42","0.58"]'
  closed: boolean;
  umaResolutionStatus?: string;
}

interface SearchResp {
  events?: { slug: string; closed: boolean; markets: GammaMarket[] }[];
}

function toExternal(m: GammaMarket, eventSlug?: string): ExternalMarket | null {
  let outcomes: string[];
  let prices: number[];
  try {
    outcomes = JSON.parse(m.outcomes);
    prices = (JSON.parse(m.outcomePrices) as string[]).map(Number);
  } catch {
    return null;
  }
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIdx < 0 || outcomes.length !== 2) return null; // binary Yes/No only
  const yes = prices[yesIdx] ?? null;
  const resolved =
    m.closed && (m.umaResolutionStatus === "resolved" || yes === 1 || yes === 0)
      ? yes === 1
        ? "yes"
        : yes === 0
          ? "no"
          : null
      : null;
  return {
    ref: `poly:${m.id}`,
    title: m.question,
    yesPrice: yes,
    url: `https://polymarket.com/event/${eventSlug ?? m.slug}`,
    resolved,
  };
}

export const polymarket: ExternalSource = {
  prefix: "poly",
  name: "Polymarket",

  async search(query, limit = 3) {
    const data = await getJson<SearchResp>(
      `${BASE}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`,
    );
    const out: ExternalMarket[] = [];
    for (const ev of data.events ?? []) {
      for (const m of ev.markets.filter((m) => !m.closed).slice(0, 2)) {
        const x = toExternal(m, ev.slug);
        if (x) out.push(x);
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  },

  async get(id) {
    try {
      return toExternal(await getJson<GammaMarket>(`${BASE}/markets/${encodeURIComponent(id)}`));
    } catch {
      return null;
    }
  },
};
