import { PLAY } from "./db.ts";

/** "$5", "5", "5.5", "$12.50" → cents. Returns NaN for anything else. */
export function parseMoney(raw: string | undefined): number {
  const m = raw?.trim().match(/^\$?(\d+(?:\.\d{1,2})?)$/);
  return m ? Math.round(Number(m[1]) * 100) : Number.NaN;
}

/** 1250 → "$12.50" (real money) or "12.5 coins" (play money). */
export function usd(cents: number): string {
  if (PLAY) return `${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} coins`;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = abs % 100;
  return `${sign}$${dollars}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** 1250 → "12.50", for prefilled payment links. */
export const plainAmount = (cents: number) => (cents / 100).toFixed(2);
