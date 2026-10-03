import type { Side } from "../db.ts";

export interface ExternalMarket {
  ref: string; // "kalshi:TICKER" | "poly:ID" — stored on our market row
  title: string;
  yesPrice: number | null; // 0..1 implied probability
  url: string;
  resolved: Side | null;
}

/** Any outside venue we can mirror odds from and auto-settle against. */
export interface ExternalSource {
  prefix: string;
  name: string;
  search(query: string, limit?: number): Promise<ExternalMarket[]>;
  get(id: string): Promise<ExternalMarket | null>;
}

import { kalshi } from "./kalshi.ts";
import { polymarket } from "./polymarket.ts";

export const sources: ExternalSource[] = [kalshi, polymarket];

export function parseRef(ref: string): { source: ExternalSource; id: string } | null {
  const [prefix, ...rest] = ref.split(":");
  const source = sources.find((s) => s.prefix === prefix?.toLowerCase());
  const id = rest.join(":").trim();
  return source && id ? { source, id } : null;
}

export async function fetchRef(ref: string): Promise<ExternalMarket | null> {
  const parsed = parseRef(ref);
  return parsed ? parsed.source.get(parsed.id) : null;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return (await res.json()) as T;
}

export const pct = (p: number | null) => (p == null ? "?" : `${Math.round(p * 100)}%`);
