import { Resvg } from "@resvg/resvg-js";
import type { Market } from "./db.ts";
import { displayName, extHistory, impliedYes, oddsHistory, payouts, pools, stakes } from "./markets.ts";
import { usd } from "./money.ts";
import { describeWhen } from "./when.ts";

// Minimal cards rendered as SVG → PNG and sent as iMessage images.
// One ink color, one accent per side, lots of whitespace.
const C = {
  bg: "#FAFAF7",
  ink: "#111111",
  muted: "#8C8C88",
  line: "#E6E5E0",
  yes: "#1E8E5A",
  no: "#D2453F",
  ext: "#5B6CF0",
};
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const W = 1200;
const PAD = 72;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const perLine = Math.floor(maxWidth / (size * 0.52));
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if ((cur + " " + word).trim().length > perLine && cur) {
      lines.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

const t = (x: number, y: number, s: string, size: number, fill = C.ink, weight = 400, anchor = "start") =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

function render(svg: string): Buffer {
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" }, background: C.bg })
    .render()
    .asPng();
}

/** Split bar: YES share on the left, NO on the right. */
function splitBar(x: number, y: number, w: number, h: number, yes: number, no: number) {
  const total = yes + no;
  if (!total) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.line}"/>`;
  const yw = Math.round((yes / total) * w);
  return `<clipPath id="bar"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/></clipPath>
    <g clip-path="url(#bar)">
      <rect x="${x}" y="${y}" width="${yw}" height="${h}" fill="${C.yes}"/>
      <rect x="${x + yw}" y="${y}" width="${w - yw}" height="${h}" fill="${C.no}"/>
    </g>`;
}

/** Step path through time-ordered points, extended flat to `tEnd`. */
function stepPath(pts: { t: number; yes: number }[], x: (t: number) => number, y: (p: number) => number, tEnd: number) {
  let d = "";
  pts.forEach((p, i) => {
    d += i ? ` H${x(p.t).toFixed(1)} V${y(p.yes).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.yes).toFixed(1)}`;
  });
  return `${d} H${x(tEnd).toFixed(1)}`;
}

const mult = (x: number) => `${x.toFixed(x < 10 ? 1 : 0)}x`;

/** Detail card for one market: odds, pot, odds over time vs the real market, who's in. */
export function marketCard(m: Market, external?: { name: string; yes: number | null }): Buffer {
  const p = pools(m.id);
  const hist = oddsHistory(m);
  const ext = m.external ? extHistory(m.id) : [];
  const people = stakes(m.id);
  const yesP = impliedYes(m);
  const pay = payouts(m.id);

  const parts: string[] = [];
  let y = PAD + 8;

  const status =
    m.status === "resolved"
      ? `RESOLVED ${m.outcome?.toUpperCase()}`
      : m.status === "closed"
        ? "LOCKED"
        : m.closes_at
          ? `LIVE  ·  CLOSES ${describeWhen(m.closes_at).toUpperCase()}`
          : "LIVE";
  parts.push(t(PAD, y, `#${m.id}  ·  ${status}`, 24, m.status === "open" ? C.yes : C.muted, 600));
  y += 64;
  for (const line of wrap(m.question, 46, W - PAD * 2, 3)) {
    parts.push(t(PAD, y, line, 46, C.ink, 600));
    y += 58;
  }
  if (m.prior_why) {
    for (const line of wrap(`Opened at ${Math.round((m.prior ?? 0.5) * 100)}%: ${m.prior_why}`, 26, W - PAD * 2, 2)) {
      parts.push(t(PAD, y, line, 26, C.muted));
      y += 36;
    }
  }
  y += 90;

  // Headline numbers.
  parts.push(t(PAD, y, `${Math.round(yesP * 100)}%`, 120, yesP >= 0.5 ? C.yes : C.no, 700));
  parts.push(t(PAD, y + 44, "chance of YES", 26, C.muted));
  parts.push(t(W - PAD, y, usd(p.total), 84, C.ink, 700, "end"));
  const n = new Set(people.map((s) => s.user_id)).size;
  parts.push(t(W - PAD, y + 44, `pot · ${n} ${n === 1 ? "person" : "people"}`, 26, C.muted, 400, "end"));
  y += 100;

  // Payout odds: what $1 returns on each side right now.
  if (p.total) {
    parts.push(t(PAD, y, pay.yes == null ? "YES wins the pot" : `YES pays ${mult(pay.yes)}`, 30, C.yes, 600));
    parts.push(t(PAD + 340, y, pay.no == null ? "NO wins the pot" : `NO pays ${mult(pay.no)}`, 30, C.no, 600));
    y += 40;
  }
  y += 40;

  // Odds over time: the group (ink) against the real market (dashed blue).
  const cx = PAD;
  const cw = W - PAD * 2 - 70;
  const ch = 240;
  const cy = y;
  const t0 = m.created_at;
  const tEnd = Math.max(Date.now(), t0 + 60_000);
  const px = (tt: number) => cx + ((Math.max(tt, t0) - t0) / (tEnd - t0)) * cw;
  const py = (pr: number) => cy + ch - pr * ch;
  for (const g of [0, 0.5, 1]) {
    parts.push(`<line x1="${cx}" y1="${py(g)}" x2="${cx + cw}" y2="${py(g)}" stroke="${C.line}" stroke-width="2"/>`);
    parts.push(t(W - PAD, py(g) + 8, `${g * 100}%`, 22, C.muted, 400, "end"));
  }
  const extPts = ext.length ? ext : external?.yes != null ? [{ t: t0, yes: external.yes }] : [];
  if (extPts.length) {
    parts.push(`<path d="${stepPath(extPts, px, py, tEnd)}" fill="none" stroke="${C.ext}" stroke-width="3" stroke-dasharray="10 8"/>`);
  }
  parts.push(`<path d="${stepPath(hist, px, py, tEnd)}" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"/>`);
  parts.push(`<circle cx="${px(tEnd)}" cy="${py(yesP)}" r="9" fill="${C.ink}"/>`);
  y = cy + ch + 40;
  parts.push(`<line x1="${PAD}" y1="${y - 8}" x2="${PAD + 36}" y2="${y - 8}" stroke="${C.ink}" stroke-width="4"/>`);
  parts.push(t(PAD + 48, y, "this group", 22, C.muted));
  if (extPts.length) {
    const lx = PAD + 220;
    parts.push(`<line x1="${lx}" y1="${y - 8}" x2="${lx + 36}" y2="${y - 8}" stroke="${C.ext}" stroke-width="3" stroke-dasharray="10 8"/>`);
    const last = extPts[extPts.length - 1]!.yes;
    parts.push(t(lx + 48, y, `${external?.name ?? "Kalshi"} ${Math.round(last * 100)}%`, 22, C.ext));
  }
  y += 60;

  // Where the money is.
  parts.push(splitBar(PAD, y, W - PAD * 2, 22, p.yes, p.no));
  y += 58;
  parts.push(t(PAD, y, `YES ${usd(p.yes)}`, 28, C.yes, 600));
  parts.push(t(W - PAD, y, `NO ${usd(p.no)}`, 28, C.no, 600, "end"));
  y += 60;

  // Who's in, two columns.
  const rows = people.slice(0, 8);
  const colW = (W - PAD * 2 - 80) / 2;
  rows.forEach((s, i) => {
    const x = PAD + (i % 2) * (colW + 80);
    const ry = y + Math.floor(i / 2) * 48;
    parts.push(`<circle cx="${x + 9}" cy="${ry - 9}" r="9" fill="${s.side === "yes" ? C.yes : C.no}"/>`);
    parts.push(t(x + 32, ry, displayName(m.space_id, s.user_id), 28));
    parts.push(t(x + colW, ry, usd(s.amount), 28, C.ink, 600, "end"));
  });
  if (!rows.length) parts.push(t(PAD, y, "No bets yet. !yes or !no to get in.", 26, C.muted));
  if (people.length > rows.length) parts.push(t(PAD, y + Math.ceil(rows.length / 2) * 48, `+${people.length - rows.length} more`, 24, C.muted));
  y += Math.max(1, Math.ceil(rows.length / 2)) * 48 + (people.length > rows.length ? 48 : 0) + PAD - 20;

  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">${parts.join("")}</svg>`);
}

/** Compact board of open markets: one row each with odds bar and pot. */
export function boardCard(title: string, markets: Market[]): Buffer {
  const parts: string[] = [];
  let y = PAD + 8;
  parts.push(t(PAD, y, title.toUpperCase(), 24, C.muted, 500));
  y += 40;
  for (const m of markets) {
    const p = pools(m.id);
    const yesP: number | null = impliedYes(m);
    y += 56;
    const [q] = wrap(`#${m.id}  ${m.question}`, 34, W - PAD * 2 - 260, 1);
    parts.push(t(PAD, y, q!, 34, C.ink, 600));
    parts.push(t(W - PAD, y, yesP == null ? "—" : `${Math.round(yesP * 100)}%`, 34, yesP == null ? C.muted : yesP >= 0.5 ? C.yes : C.no, 700, "end"));
    y += 28;
    parts.push(splitBar(PAD, y, W - PAD * 2 - 260, 14, p.yes, p.no).replace(/id="bar"/g, `id="bar${m.id}"`).replace(/url\(#bar\)/g, `url(#bar${m.id})`));
    parts.push(t(W - PAD, y + 14, `${usd(p.total)} pot${m.status === "closed" ? " · locked" : ""}`, 24, C.muted, 400, "end"));
    y += 34;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  }
  y += PAD - 10;
  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">${parts.join("")}</svg>`);
}

/** Who pays whom after a market settles. */
export function settleCard(m: Market, debts: { debtor: string; creditor: string; amount: number }[]): Buffer {
  const parts: string[] = [];
  let y = PAD + 8;
  parts.push(t(PAD, y, `#${m.id}  ·  RESOLVED ${m.outcome?.toUpperCase()}`, 24, m.outcome === "yes" ? C.yes : C.no, 600));
  y += 60;
  for (const line of wrap(m.question, 40, W - PAD * 2, 2)) {
    parts.push(t(PAD, y, line, 40, C.ink, 600));
    y += 52;
  }
  y += 40;
  parts.push(t(PAD, y, "SETTLE UP", 24, C.muted, 500));
  y += 20;
  for (const d of debts) {
    y += 64;
    parts.push(t(PAD, y, displayName(m.space_id, d.debtor), 36, C.ink, 600));
    parts.push(t(PAD + 330, y, "→", 36, C.muted, 400));
    parts.push(t(PAD + 400, y, displayName(m.space_id, d.creditor), 36, C.ink, 600));
    parts.push(t(W - PAD, y, usd(d.amount), 36, C.ink, 700, "end"));
    parts.push(`<line x1="${PAD}" y1="${y + 26}" x2="${W - PAD}" y2="${y + 26}" stroke="${C.line}" stroke-width="2"/>`);
  }
  y += PAD + 20;
  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">${parts.join("")}</svg>`);
}
