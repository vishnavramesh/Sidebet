import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { marketCard } from "./charts.ts";
import { type Market, PLAY, db } from "./db.ts";
import { parseRef } from "./external/index.ts";
import { displayName, extHistory, getMarketById, impliedYes, oddsHistory, payouts, pools, stakes } from "./markets.ts";
import { livePage } from "./webpage.ts";

// A live page per market, served from the bot itself. Each market gets an
// unguessable token; the page polls a small JSON endpoint every few seconds.
// A Cloudflare quick tunnel gives it a public https URL with no account (the
// URL changes on each restart; set PUBLIC_URL to use your own).

const PORT = Number(process.env.WEB_PORT ?? 8787);
let publicUrl: string | null = process.env.PUBLIC_URL?.replace(/\/$/, "") ?? null;

db.exec("CREATE TABLE IF NOT EXISTS web_tokens (token TEXT PRIMARY KEY, market_id INTEGER NOT NULL UNIQUE REFERENCES markets(id))");

function tokenFor(m: Market): string {
  const row = db.prepare("SELECT token FROM web_tokens WHERE market_id = ?").get(m.id) as { token: string } | undefined;
  if (row) return row.token;
  const token = randomBytes(9).toString("base64url");
  db.prepare("INSERT INTO web_tokens (token, market_id) VALUES (?, ?)").run(token, m.id);
  return token;
}

function marketByToken(token: string): Market | undefined {
  const row = db.prepare("SELECT market_id FROM web_tokens WHERE token = ?").get(token) as { market_id: number } | undefined;
  return row ? getMarketById(row.market_id) : undefined;
}

/** The live link for a market, or null when the page isn't reachable. */
export function marketLink(m: Market): string | null {
  return publicUrl ? `${publicUrl}/${tokenFor(m)}` : null;
}

/** Everything the page shows, in display units (dollars or coins). */
function snapshot(m: Market) {
  const p = pools(m.id);
  const pay = payouts(m.id);
  const extName = m.external ? (parseRef(m.external)?.source.name ?? "Kalshi") : null;
  const reasons = m.prior_case ? (JSON.parse(m.prior_case) as { yes: string[]; no: string[] }) : null;
  return {
    id: m.id,
    question: m.question,
    status: m.status,
    outcome: m.outcome,
    createdAt: m.created_at,
    closesAt: m.closes_at,
    yes: impliedYes(m),
    prior: m.prior,
    pot: p.total / 100,
    pools: { yes: p.yes / 100, no: p.no / 100 },
    pays: pay,
    unit: PLAY ? "coins" : "usd",
    why: m.prior_why,
    reasons,
    history: oddsHistory(m),
    ext: extName ? { name: extName, history: extHistory(m.id) } : null,
    people: stakes(m.id).map((s) => ({ name: displayName(m.space_id, s.user_id), side: s.side, amount: s.amount / 100 })),
    hint: PLAY ? 50 : 5,
    now: Date.now(),
  };
}

export function startWeb() {
  // Off unless WEB=on: chat replies no longer link to it, so no server or tunnel by default.
  if (process.env.WEB !== "on") return;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // /<token> page (or the older /m/<token>), /<token>/card.png image, /api/<token> data
    const parts = url.pathname.split("/").filter(Boolean);
    const kind = parts[0] === "api" ? "api" : "m";
    if (parts[0] === "api" || parts[0] === "m") parts.shift();
    const [token, extra] = parts;
    const m = token ? marketByToken(token) : undefined;
    try {
      if (kind === "api" && m) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(snapshot(m)));
      }
      if (kind === "m" && m && extra === "card.png") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=30" });
        return res.end(marketCard(m));
      }
      if (kind === "m" && m) {
        const s = snapshot(m);
        const self = `${publicUrl ?? ""}/${token}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(livePage({ token: token!, title: `#${m.id} ${m.question}`, description: `YES ${Math.round(s.yes * 100)}% · live odds`, image: `${self}/card.png`, url: self }));
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      console.warn("[web]", err);
      res.writeHead(500).end();
    }
  });
  server.on("error", (err) => console.warn(`[web] can't listen on ${PORT}:`, err.message));
  server.listen(PORT, "127.0.0.1", () => console.log(`[web] live pages on http://localhost:${PORT}`));

  if (!publicUrl) startTunnel();
}

function startTunnel() {
  const bin = process.env.CLOUDFLARED ?? "cloudflared";
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const scan = (chunk: Buffer) => {
    const hit = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (hit && !publicUrl) {
      publicUrl = hit[0];
      console.log(`[web] public link: ${publicUrl}`);
    }
  };
  proc.stdout.on("data", scan);
  proc.stderr.on("data", scan);
  proc.on("error", () => console.warn("[web] cloudflared not found, so live links are off (brew install cloudflared)"));
  proc.on("exit", (code) => {
    console.warn(`[web] tunnel exited (${code}); live links are off until restart`);
    publicUrl = process.env.PUBLIC_URL ?? null;
  });
  process.on("exit", () => proc.kill());
}
