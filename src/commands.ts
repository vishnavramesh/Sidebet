import type { Market, Side } from "./db.ts";
import { fetchRef, parseRef, pct, sources } from "./external/index.ts";
import {
  BetError,
  betsFor,
  cancelMarket,
  claimDaily,
  closeMarket,
  createMarket,
  displayName,
  getBalance,
  getMarket,
  leaderboard,
  listMarkets,
  placeBet,
  pools,
  resolveMarket,
  setExternal,
  setName,
} from "./markets.ts";

export interface Ctx {
  spaceId: string;
  userId: string;
  text: string;
}

/** Last bot-suggested question per chat, so `!new` with no args can adopt it. */
export const suggestions = new Map<string, { question: string; external?: string }>();

const PREFIXES = ["!", "/"];
export const isCommand = (text: string) => PREFIXES.some((p) => text.trimStart().startsWith(p));

const HELP = `🎲 Group Markets — bet on anything with your friends (play money, 🪙)

!new <question>  open a yes/no market
!yes <id> <amt> / !no <id> <amt>  place a bet
!markets  list open markets   ·   !m <id>  details
!resolve <id> yes|no  (creator) settle it
!close <id>  stop betting   ·   !cancel <id>  refund all
!bal  ·  !daily (+100)  ·  !lb leaderboard  ·  !name <nick>

Real-world odds:
!kalshi <search>  ·  !poly <search>
!mirror kalshi:<TICKER> | poly:<id>  market that auto-settles with the real one
!link <id> kalshi:<TICKER>  attach a real market to an existing one`;

const coins = (n: number) => `${n.toLocaleString()} 🪙`;

function oddsLine(m: Market) {
  const p = pools(m.id);
  const yes = p.total ? p.yes / p.total : null;
  return `YES ${pct(yes)} · pot ${coins(p.total)} (Y ${p.yes} / N ${p.no})`;
}

async function marketCard(m: Market) {
  const lines = [`#${m.id} ${m.question}`, oddsLine(m)];
  if (m.external) {
    const ext = await fetchRef(m.external);
    if (ext) lines.push(`📈 ${parseRef(m.external)!.source.name}: YES ${pct(ext.yesPrice)} — ${ext.url}`);
  }
  if (m.status !== "open") lines.push(`status: ${m.status}${m.outcome ? ` → ${m.outcome.toUpperCase()}` : ""}`);
  return lines.join("\n");
}

function requireMarket(spaceId: string, raw: string | undefined) {
  const id = Number(raw?.replace("#", ""));
  const m = Number.isInteger(id) ? getMarket(spaceId, id) : undefined;
  if (!m) throw new BetError(`No market ${raw ? `#${raw.replace("#", "")}` : ""} in this chat. Try !markets`);
  return m;
}

function requireCreator(m: Market, userId: string) {
  if (m.creator !== userId) throw new BetError(`Only ${displayName(m.space_id, m.creator)} (creator) can do that.`);
}

export function settlementMessage(m: Market, outcome: Side, r: ReturnType<typeof resolveMarket>) {
  const head = `✅ #${m.id} resolved ${outcome.toUpperCase()}: ${m.question}`;
  if (r.staked.size === 0) return `${head}\nNo bets were placed.`;
  if (r.refunded) return `${head}\nNobody took ${outcome.toUpperCase()} — all ${coins(r.pools.total)} refunded.`;
  const rows = [...r.staked.keys()]
    .map((u) => ({ u, net: (r.payouts.get(u) ?? 0) - r.staked.get(u)! }))
    .sort((a, b) => b.net - a.net)
    .map(({ u, net }) => `${net >= 0 ? "🤑" : "💀"} ${displayName(m.space_id, u)} ${net >= 0 ? "+" : ""}${net}`);
  return [head, ...rows].join("\n");
}

export async function handleCommand({ spaceId, userId, text }: Ctx): Promise<string | null> {
  const trimmed = text.trim().slice(1);
  const [rawCmd = "", ...args] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const rest = trimmed.slice(rawCmd.length).trim();

  try {
    switch (cmd) {
      case "help":
      case "bets":
        return HELP;

      case "new":
      case "bet":
      case "market": {
        let question = rest;
        let external: string | null = null;
        if (!question) {
          const s = suggestions.get(spaceId);
          if (!s) return "Usage: !new Will Jake show up on time?";
          question = s.question;
          external = s.external ?? null;
        }
        suggestions.delete(spaceId);
        if (!question.endsWith("?")) question += "?";
        const m = createMarket(spaceId, userId, question, external);
        return `📊 Market #${m.id} open: ${m.question}\nBet with !yes ${m.id} <amt> or !no ${m.id} <amt>`;
      }

      case "yes":
      case "no": {
        const [idRaw, amtRaw] = args;
        const amount = amtRaw?.toLowerCase() === "all" ? getBalance(spaceId, userId) : Number(amtRaw);
        const m = requireMarket(spaceId, idRaw);
        const r = placeBet(spaceId, userId, m.id, cmd, amount);
        return `${displayName(spaceId, userId)} put ${coins(amount)} on ${cmd.toUpperCase()} for #${m.id}\n${oddsLine(m)}\nbalance: ${coins(r.balance)}`;
      }

      case "markets":
      case "ls": {
        const ms = listMarkets(spaceId);
        if (!ms.length) return "No open markets. Start one with !new <question>";
        return ms.map((m) => `#${m.id}${m.status === "closed" ? " 🔒" : ""} ${m.question}\n   ${oddsLine(m)}`).join("\n");
      }

      case "m":
      case "market?":
      case "info":
        return marketCard(requireMarket(spaceId, args[0]));

      case "close": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        closeMarket(m);
        return `🔒 #${m.id} closed to new bets.`;
      }

      case "cancel": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        if (m.status === "resolved" || m.status === "cancelled") throw new BetError(`#${m.id} is already ${m.status}.`);
        cancelMarket(m);
        return `🚫 #${m.id} cancelled, ${betsFor(m.id).length} bets refunded.`;
      }

      case "resolve": {
        const m = requireMarket(spaceId, args[0]);
        const outcome = args[1]?.toLowerCase();
        if (outcome !== "yes" && outcome !== "no") return `Usage: !resolve ${m.id} yes|no`;
        requireCreator(m, userId);
        if (m.external) throw new BetError(`#${m.id} is linked to ${m.external} and settles automatically.`);
        return settlementMessage(m, outcome, resolveMarket(m, outcome));
      }

      case "bal":
      case "balance":
        return `${displayName(spaceId, userId)}: ${coins(getBalance(spaceId, userId))}`;

      case "daily": {
        const bal = claimDaily(spaceId, userId);
        return bal == null ? "Already claimed today. Come back tomorrow." : `+100 🪙 → ${coins(bal)}`;
      }

      case "lb":
      case "leaderboard": {
        const rows = leaderboard(spaceId);
        if (!rows.length) return "Nobody's played yet.";
        const medals = ["🥇", "🥈", "🥉"];
        return rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${displayName(spaceId, r.user_id)} ${coins(r.balance)}`).join("\n");
      }

      case "name": {
        const name = rest.slice(0, 24);
        if (!name) return "Usage: !name Vish";
        setName(spaceId, userId, name);
        return `👋 You're ${name} now.`;
      }

      case "kalshi":
      case "poly":
      case "polymarket": {
        if (!rest) return `Usage: !${cmd} fed rate cut`;
        const source = sources.find((s) => s.prefix === (cmd === "kalshi" ? "kalshi" : "poly"))!;
        const results = await source.search(rest, 4);
        if (!results.length) return `Nothing on ${source.name} for "${rest}".`;
        return [
          `${source.name} — "${rest}"`,
          ...results.map((r) => `• ${r.title}\n  YES ${pct(r.yesPrice)} · !mirror ${r.ref}`),
        ].join("\n");
      }

      case "mirror": {
        const ext = args[0] ? await fetchRef(args[0]) : null;
        if (!ext) return "Usage: !mirror kalshi:<TICKER> or !mirror poly:<id> (find one with !kalshi / !poly)";
        if (ext.resolved) return `That market already settled ${ext.resolved.toUpperCase()}.`;
        const m = createMarket(spaceId, userId, ext.title.endsWith("?") ? ext.title : `${ext.title}?`, ext.ref);
        return `📊 Market #${m.id} open: ${m.question}\n📈 ${parseRef(ext.ref)!.source.name} says YES ${pct(ext.yesPrice)} — beat the market.\nSettles automatically. !yes ${m.id} <amt> / !no ${m.id} <amt>`;
      }

      case "link": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        const ext = args[1] ? await fetchRef(args[1]) : null;
        if (!ext) return `Usage: !link ${m.id} kalshi:<TICKER>`;
        setExternal(m, ext.ref);
        return `🔗 #${m.id} now tracks ${ext.title} (YES ${pct(ext.yesPrice)}) and will settle with it.`;
      }

      default:
        return null; // unknown "!" text — stay quiet so we don't spam normal chat
    }
  } catch (err) {
    if (err instanceof BetError) return `⚠️ ${err.message}`;
    console.error("[command]", err);
    return "⚠️ Something broke. Try again?";
  }
}
