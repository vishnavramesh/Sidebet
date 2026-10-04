import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { type Market, PLAY } from "./db.ts";
import { displayName, extHistory, impliedYes, oddsHistory, payouts, pools, stakes } from "./markets.ts";
import { usd } from "./money.ts";
import { describeWhen } from "./when.ts";

// Minimal cards rendered as SVG → PNG and sent as iMessage images, styled
// after Kalshi: white, one green and one red, big numbers, thin lines. Kalshi's
// own face (Kalshi Sans) isn't licensed for use, so this uses Inter, the
// closest open neo-grotesk, bundled in assets/fonts (SIL Open Font License).
const C = {
  bg: "#FFFFFF",
  ink: "#0B0D10",
  muted: "#7A808A",
  faint: "#B9BEC6",
  line: "#ECEEF1",
  yes: "#00A76F",
  yesTint: "#E8F7F0",
  no: "#E5484D",
  noTint: "#FDECEC",
  ext: "#7A808A",
};
const FONT = "Inter";
const FONT_FILES = ["Regular", "Medium", "SemiBold", "Bold"].map((w) =>
  fileURLToPath(new URL(`../assets/fonts/Inter-${w}.ttf`, import.meta.url)),
);
const W = 1200;
const PAD = 72;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const perLine = Math.floor(maxWidth / (size * 0.55));
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
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: true, defaultFontFamily: FONT }, background: C.bg })
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

/** Odds hold until a bet moves them: flat runs with a step at each point, extended to `tEnd`. */
function linePath(pts: { t: number; yes: number }[], x: (t: number) => number, y: (p: number) => number, tEnd: number) {
  const d = pts.map((p, i) => (i ? `H${x(p.t).toFixed(1)} V${y(p.yes).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.yes).toFixed(1)}`)).join(" ");
  return `${d} H${x(tEnd).toFixed(1)}`;
}

const clock = (ms: number) => new Date(ms).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
const mult = (x: number | null) => (x == null ? "—" : `${x.toFixed(x < 10 ? 1 : 0)}x`);
/** Plain number in play money ("50"), dollars in real money. */
const money = (cents: number) => (PLAY ? (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) : usd(cents));

/** Kalshi-style card for one market: chance, odds over time, Yes/No prices, and who's on each side. */
export function marketCard(m: Market, external?: { name: string; yes: number | null }): Buffer {
  const p = pools(m.id);
  const hist = oddsHistory(m);
  const ext = m.external ? extHistory(m.id) : [];
  const people = stakes(m.id);
  const yesP = impliedYes(m);
  const pay = payouts(m.id);
  const parts: string[] = [];
  let y = PAD + 4;

  // Status line, then the question.
  const status =
    m.status === "resolved"
      ? `Resolved ${m.outcome === "yes" ? "Yes" : "No"}`
      : m.status === "closed"
        ? "Betting closed"
        : m.closes_at
          ? `Live · closes ${describeWhen(m.closes_at)}`
          : "Live";
  const statusColor = m.status === "resolved" ? (m.outcome === "yes" ? C.yes : C.no) : m.status === "open" ? C.yes : C.muted;
  if (m.status === "open") parts.push(`<circle cx="${PAD + 7}" cy="${y - 8}" r="7" fill="${C.yes}"/>`);
  parts.push(t(m.status === "open" ? PAD + 24 : PAD, y, `#${m.id} · ${status}`, 24, statusColor, 500));
  y += 62;
  for (const line of wrap(m.question, 44, W - PAD * 2, 3)) {
    parts.push(t(PAD, y, line, 44, C.ink, 600));
    y += 56;
  }
  y += 70;

  // "64% chance  ▲ 9"
  const moved = m.prior == null ? 0 : Math.round((yesP - m.prior) * 100);
  const delta = moved ? `<tspan dx="20" font-size="30" font-weight="600" fill="${moved > 0 ? C.yes : C.no}">${moved > 0 ? "▲" : "▼"} ${Math.abs(moved)}</tspan>` : "";
  parts.push(
    `<text x="${PAD}" y="${y}" font-family="${FONT}" fill="${C.ink}"><tspan font-size="104" font-weight="700" letter-spacing="-3">${Math.round(yesP * 100)}%</tspan><tspan dx="14" font-size="36" font-weight="500" fill="${C.muted}">chance</tspan>${delta}</text>`,
  );
  y += 50;

  // Odds over time: the group's line (green, soft fill) and the real market's (dashed grey).
  const cx = PAD;
  const cw = W - PAD * 2 - 72;
  const ch = 260;
  const cy = y;
  const t0 = m.created_at;
  const tEnd = Math.max(Date.now(), t0 + 60_000, hist[hist.length - 1]!.t);
  const px = (tt: number) => cx + ((Math.max(tt, t0) - t0) / (tEnd - t0)) * cw;
  const py = (pr: number) => cy + ch - pr * ch;
  for (const g of [0.25, 0.5, 0.75]) {
    parts.push(`<line x1="${cx}" y1="${py(g)}" x2="${cx + cw}" y2="${py(g)}" stroke="${C.line}" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>`);
    parts.push(t(W - PAD, py(g) + 8, `${g * 100}%`, 22, C.faint, 500, "end"));
  }
  const extPts = ext.length ? ext : external?.yes != null ? [{ t: t0, yes: external.yes }] : [];
  if (extPts.length) {
    parts.push(`<path d="${linePath(extPts, px, py, tEnd)}" fill="none" stroke="${C.ext}" stroke-width="3" stroke-dasharray="8 8"/>`);
  }
  const path = linePath(hist, px, py, tEnd);
  parts.push(
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.yes}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.yes}" stop-opacity="0"/></linearGradient></defs>`,
    `<path d="${path} L${px(tEnd).toFixed(1)},${cy + ch} L${px(t0).toFixed(1)},${cy + ch} Z" fill="url(#fill)"/>`,
    `<path d="${path}" fill="none" stroke="${C.yes}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`,
    `<circle cx="${px(tEnd)}" cy="${py(yesP)}" r="16" fill="${C.yes}" fill-opacity="0.18"/>`,
    `<circle cx="${px(tEnd)}" cy="${py(yesP)}" r="8" fill="${C.yes}"/>`,
  );
  y = cy + ch + 40;
  parts.push(t(cx, y, `Opened ${clock(t0)}`, 22, C.faint, 500));
  if (extPts.length) {
    const last = extPts[extPts.length - 1]!.yes;
    parts.push(t(cx + cw / 2, y, `- - ${external?.name ?? "Kalshi"} ${Math.round(last * 100)}%`, 22, C.muted, 500, "middle"));
  }
  parts.push(t(cx + cw, y, m.status === "open" ? "Now" : clock(tEnd), 22, C.faint, 500, "end"));
  y += 56;

  // Yes / No price buttons.
  const bw = (W - PAD * 2 - 24) / 2;
  const bh = 92;
  const button = (x: number, label: string, price: number, payout: number | null, fill: string, tint: string) =>
    `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="18" fill="${tint}"/>` +
    t(x + 32, y + 58, `${label} ${Math.round(price * 100)}%`, 34, fill, 700) +
    t(x + bw - 32, y + 56, p.total && m.status === "open" ? `pays ${mult(payout)}` : "", 26, fill, 500, "end");
  parts.push(button(PAD, "Yes", yesP, pay.yes, C.yes, C.yesTint), button(PAD + bw + 24, "No", 1 - yesP, pay.no, C.no, C.noTint));
  y += bh + 64;

  // Who's on each side, like an order book.
  const sides = (["yes", "no"] as const).map((side) => people.filter((s) => s.side === side));
  const colX = [PAD, PAD + bw + 24];
  sides.forEach((rows, i) => {
    const side = i === 0 ? "yes" : "no";
    const color = i === 0 ? C.yes : C.no;
    parts.push(t(colX[i]!, y, `${side.toUpperCase()} · ${money(p[side])}`, 24, color, 600));
    parts.push(`<line x1="${colX[i]}" y1="${y + 20}" x2="${colX[i]! + bw}" y2="${y + 20}" stroke="${C.line}" stroke-width="2"/>`);
    rows.slice(0, 5).forEach((s, r) => {
      const ry = y + 70 + r * 50;
      parts.push(t(colX[i]!, ry, displayName(m.space_id, s.user_id), 30, C.ink, 500));
      parts.push(t(colX[i]! + bw, ry, money(s.amount), 30, C.ink, 600, "end"));
    });
    if (!rows.length) parts.push(t(colX[i]!, y + 70, "No one yet", 28, C.faint, 500));
    if (rows.length > 5) parts.push(t(colX[i]!, y + 70 + 5 * 50, `+${rows.length - 5} more`, 24, C.muted, 500));
  });
  const longest = Math.max(1, ...sides.map((r) => Math.min(r.length, 5) + (r.length > 5 ? 1 : 0)));
  y += 70 + (longest - 1) * 50 + 56;

  // Footer: pot and head count.
  const n = new Set(people.map((s) => s.user_id)).size;
  parts.push(`<line x1="${PAD}" y1="${y - 30}" x2="${W - PAD}" y2="${y - 30}" stroke="${C.line}" stroke-width="2"/>`);
  parts.push(t(PAD, y + 10, `${money(p.total)} pot · ${n} ${n === 1 ? "person" : "people"}`, 24, C.muted, 500));
  if (m.status === "open") parts.push(t(W - PAD, y + 10, `!yes ${m.id} · !no ${m.id}`, 24, C.faint, 500, "end"));
  y += 10 + PAD - 10;

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
