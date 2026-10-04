import { boardCard, marketCard, settleCard } from "./charts.ts";
import type { Debt, Market, Side } from "./db.ts";
import { DAILY_COINS, MAX_BET_CENTS, PLAY } from "./db.ts";
import { fetchRef, parseRef, pct, sources } from "./external/index.ts";
import { soonestCoinFlip } from "./external/kalshi.ts";
import { estimate, findKalshiTwin, oracleEnabled } from "./oracle.ts";
import {
  BetError,
  balance,
  cancelMarket,
  claimDaily,
  richList,
  closeMarket,
  createMarket,
  displayName,
  ensureUser,
  getDebt,
  getMarket,
  getMarketById,
  impliedYes,
  latestOpenMarket,
  leaderboard,
  listMarkets,
  openDebtsFor,
  openDebtsInSpace,
  payouts,
  placeBet,
  pools,
  recordExtPrice,
  resolveMarket,
  setDebtStatus,
  setExternal,
  setExtPosted,
  setHandle,
  setName,
  setCloseTime,
  setPrior,
} from "./markets.ts";
import { parseMoney, usd } from "./money.ts";
import { describeWhen, parseWhen } from "./when.ts";
import { type Dm, howToPay, settlementDms } from "./nagger.ts";

export interface Ctx {
  spaceId: string;
  userId: string;
  text: string;
  /** Private chat with the bot: only debt and profile commands apply. */
  isDm?: boolean;
  /** Post a quick "working on it" message before a slow reply. */
  notify?: (text: string) => Promise<void>;
}

/** What the bot sends back: text to the chat, an optional chart, and private DMs. */
export interface Reply {
  text: string;
  image?: Buffer;
  dms?: Dm[];
  /** A bet landed on this market: the live loop re-posts its chart shortly. */
  betOn?: Market;
  /** This message is about this market, so a 👍/👎 tapback on it places a bet. */
  marketId?: number;
}

/** Last bot-suggested question per chat, so `!new` with no args can adopt it. */
export const suggestions = new Map<string, { question: string; external?: string }>();

const PREFIXES = ["!", "/"];
export const isCommand = (text: string) => PREFIXES.some((p) => text.trimStart().startsWith(p));

/** Example bet size in hints: 5 dollars or 50 coins. */
const HINT = PLAY ? 50 : 5;

export const TAPBACK_CENTS = Math.round(Number(process.env.TAPBACK_AMOUNT ?? (PLAY ? 100 : 5)) * 100);

const HELP = `Group Markets · ${PLAY ? "play money, 1,000 coins each to start" : "real money, settled between you"}

!new <question>      open a market (odds from chat history + Kalshi)
!yes 1 ${HINT} · !no 1 ${HINT} bet ${usd(HINT * 100)} on #1${PLAY ? "" : ` (max ${usd(MAX_BET_CENTS)})`}
!yes ${HINT}${PLAY ? "             " : "              "} bet on the newest market
👍 / 👎 a market     bet ${usd(TAPBACK_CENTS)} YES / NO
!closes 1 2h         stop betting in 2 hours (or 30m, 3d, fri 8pm)
!m 1 · !markets      charts
!why 1               case behind the opening odds
!resolve 1 yes|no    creator settles
!close 1 · !cancel 1

${
  PLAY
    ? "!bal · !daily        balance, +100 coins a day"
    : "!owe                 who owes who\n!paid 3              you sent IOU 3\n!got 3 · !nope 3     confirm or deny\n!forgive 3\n!venmo you · !cashapp you"
}

!lb · !name Vish
!kalshi <q> · !poly <q> · !mirror kalshi:<TICKER>`;

const DM_COMMANDS = new Set(["help", "owe", "debts", "paid", "got", "nope", "forgive", "venmo", "cashapp"]);

const x = (v: number | null) => (v == null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)}x`);

export const oddsLine = (m: Market) => {
  const p = pools(m.id);
  const pay = payouts(m.id);
  const side = (name: string, v: number | null) => (v == null ? `${name} wins the whole pot` : `${name} pays ${x(v)}`);
  const money = p.total ? ` · ${usd(p.total)} pot · ${side("YES", pay.yes)}, ${side("NO", pay.no)}` : " · no bets yet";
  return `YES ${pct(impliedYes(m))}${money}`;
};

/** "Opening odds 45%. <summary>" plus the points for each side, if Claude gave them. */
function oddsCase(m: Market): string | null {
  if (m.prior == null) return null;
  const lines = [`Opening odds ${pct(m.prior)}.${m.prior_why ? ` ${m.prior_why}` : ""}`];
  const c = m.prior_case ? (JSON.parse(m.prior_case) as { yes: string[]; no: string[] }) : null;
  if (c?.yes.length) lines.push("", "For YES:", ...c.yes.map((p) => `+ ${p}`));
  if (c?.no.length) lines.push("", "For NO:", ...c.no.map((p) => `- ${p}`));
  return lines.join("\n");
}

/**
 * Set a new market's opening odds: an identical Kalshi market wins (and the
 * market then settles with it); otherwise Claude reads the chat history.
 */
async function openWithOdds(m: Market): Promise<string> {
  const est = await estimate(m.space_id, m.question);
  // Claude already judged whether this is a real-world event; only then is a
  // Kalshi twin possible, so friend-group markets skip the search entirely.
  const lookForTwin = !est || est.public_event;
  const twin = lookForTwin ? await findKalshiTwin(m.question, est?.kalshi_query || undefined).catch(() => null) : null;
  if (twin?.yesPrice != null) {
    setExternal(m, twin.ref);
    m.external = twin.ref;
    setPrior(m, twin.yesPrice, `Kalshi has it at ${Math.round(twin.yesPrice * 100)}%.`);
    recordExtPrice(m.id, twin.yesPrice);
    setExtPosted(m, twin.yesPrice);
    return `Mirroring Kalshi: ${twin.title} (YES ${pct(twin.yesPrice)}). Settles when Kalshi does.`;
  }
  if (est) {
    setPrior(m, est.probability, est.why, { yes: est.for_yes, no: est.for_no });
    return oddsCase(m)!;
  }
  setPrior(m, 0.5, null);
  return oracleEnabled ? "Opening odds 50%." : "Opening at 50% (add ANTHROPIC_API_KEY for odds from the chat)";
}

const say = (text: string, extra: Omit<Reply, "text"> = {}): Reply => ({ text, ...extra });

function requireMarket(spaceId: string, raw: string | undefined) {
  const id = Number(raw?.replace("#", ""));
  const m = Number.isInteger(id) ? getMarket(spaceId, id) : undefined;
  if (!m) throw new BetError(`No market ${raw ? `#${raw.replace("#", "")} ` : ""}in this chat. See !markets`);
  return m;
}

function requireCreator(m: Market, userId: string) {
  if (m.creator !== userId) throw new BetError(`Only ${displayName(m.space_id, m.creator)} can do that (market creator).`);
}

/** Chart rendering is a nice-to-have; a failure never blocks the text reply. */
function chart(fn: () => Buffer): Buffer | undefined {
  try {
    return fn();
  } catch (err) {
    console.warn("[chart]", err);
    return undefined;
  }
}

export function settlementReply(m: Market, outcome: Side, r: ReturnType<typeof resolveMarket>, prefix = ""): Reply {
  const settled = { ...m, status: "resolved" as const, outcome };
  const head = `${prefix}#${m.id} resolved ${outcome.toUpperCase()}`;
  if (r.staked.size === 0) return say(`${head}. No bets were placed.`);
  if (r.washed) return say(`${head}. Nobody took ${outcome.toUpperCase()}, so it's a wash. Nothing is owed.`);
  if (PLAY) {
    const rows = [...r.nets].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${displayName(m.space_id, u)} ${n >= 0 ? "+" : ""}${usd(n)}`);
    return say(`${head}\n${rows.join("\n")}`);
  }
  if (!r.debts.length) return say(`${head}. Everyone broke even.`);
  const lines = r.debts.map((d) => `${displayName(m.space_id, d.debtor)} → ${displayName(m.space_id, d.creditor)} ${usd(d.amount)}`);
  return say(`${head}\n${lines.join("\n")}\nPayment instructions sent by DM.`, {
    image: chart(() => settleCard(settled, r.debts)),
    dms: settlementDms(settled, r.debts),
  });
}

function debtLine(d: Debt, me: string) {
  const m = getMarketById(d.market_id);
  const other = displayName(d.space_id, d.debtor === me ? d.creditor : d.debtor);
  const dir = d.debtor === me ? `you owe ${other}` : `${other} owes you`;
  const flag = d.status === "claimed" ? " (marked paid, awaiting confirmation)" : "";
  return `IOU ${d.id} · ${dir} ${usd(d.amount)} · #${m?.id}${flag}`;
}

/** `!paid`, `!got`, `!nope`, `!forgive` take an IOU id, or none to mean "all of mine". */
function pickDebts(me: string, raw: string | undefined, role: "debtor" | "creditor", status: Debt["status"]) {
  if (raw) {
    const d = getDebt(Number(raw.replace(/^(iou|#)/i, "")));
    if (!d || d[role] !== me) throw new BetError(`IOU ${raw} isn't yours. See !owe`);
    if (d.status !== status) throw new BetError(`IOU ${d.id} is already ${d.status}.`);
    return [d];
  }
  const ds = openDebtsFor(me).filter((d) => d[role] === me && d.status === status);
  if (!ds.length) throw new BetError("Nothing to update. See !owe");
  return ds;
}

export async function handleCommand({ spaceId, userId, text, isDm = false, notify }: Ctx): Promise<Reply | null> {
  const trimmed = text.trim().slice(1);
  const [rawCmd = "", ...args] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const rest = trimmed.slice(rawCmd.length).trim();

  if (isDm && !DM_COMMANDS.has(cmd)) {
    return cmd ? say("That command works in the group chat. Available here: !owe, !paid, !got, !nope, !forgive, !venmo, !cashapp") : null;
  }
  if (!isDm) ensureUser(spaceId, userId);

  try {
    switch (cmd) {
      case "help":
      case "bets":
        return say(HELP);

      case "new":
      case "bet":
      case "market": {
        let question = rest;
        let external: string | null = null;
        if (!question) {
          const s = suggestions.get(spaceId);
          if (!s) return say("Usage: !new Will Jake show up on time?");
          question = s.question;
          external = s.external ?? null;
        }
        suggestions.delete(spaceId);
        // "!new Will Jake be late? | 8pm" sets a close time too.
        const [q, closeText] = question.split(/\s+\|\s+/);
        question = q!.trim();
        const closesAt = closeText ? parseWhen(closeText) : null;
        if (closeText && !closesAt) return say(`Couldn't read "${closeText}" as a time. Try 2h, 30m, 8pm or fri 8pm.`);
        if (!question.endsWith("?")) question += "?";
        const m = createMarket(spaceId, userId, question, external);
        if (closesAt) setCloseTime(m, closesAt.getTime());
        if (oracleEnabled) await notify?.(`Reading chat history to set odds for #${m.id}…`).catch(() => {});
        const opening = await openWithOdds(m);
        const closes = m.closes_at ? `\nBetting closes ${describeWhen(m.closes_at)}.` : "";
        return say(`#${m.id} ${m.question}\n${opening}${closes}\n\n!yes ${m.id} ${HINT} · !no ${m.id} ${HINT} · or 👍 / 👎 this`, {
          marketId: m.id,
          image: chart(() => marketCard(m)),
        });
      }

      case "yes":
      case "no": {
        // "!yes 5" means the newest open market.
        const [idRaw, amtRaw] = args.length === 1 ? [undefined, args[0]] : args;
        const m = idRaw ? requireMarket(spaceId, idRaw) : latestOpenMarket(spaceId);
        if (!m) throw new BetError("No open markets. Start one with !new <question>");
        const cents = PLAY && amtRaw?.toLowerCase() === "all" ? balance(spaceId, userId) : parseMoney(amtRaw);
        placeBet(spaceId, userId, m.id, cmd, cents);
        return say(`Bet placed: ${displayName(spaceId, userId)} · ${usd(cents)} ${cmd.toUpperCase()} on #${m.id}\n${oddsLine(m)}`, { betOn: m, marketId: m.id });
      }

      case "markets":
      case "ls": {
        const ms = listMarkets(spaceId);
        if (!ms.length) return say("No open markets. Start one with !new <question>");
        return say(ms.map((m) => `#${m.id}${m.status === "closed" ? " (locked)" : ""} ${m.question}\n${oddsLine(m)}`).join("\n\n"), {
          image: chart(() => boardCard("Open markets", ms)),
        });
      }

      case "why": {
        const m = args[0] ? requireMarket(spaceId, args[0]) : latestOpenMarket(spaceId);
        if (!m) throw new BetError("No open markets. Start one with !new <question>");
        return say(`#${m.id} ${m.question}\n${oddsCase(m) ?? "No opening odds recorded."}\nNow: ${oddsLine(m)}`);
      }

      case "m":
      case "chart":
      case "info": {
        const m = requireMarket(spaceId, args[0]);
        const ext = m.external ? await fetchRef(m.external).catch(() => null) : null;
        const extName = m.external ? parseRef(m.external)?.source.name : undefined;
        const lines = [`#${m.id} ${m.question}`, oddsLine(m)];
        if (m.status === "open" && m.closes_at) lines.push(`Closes ${describeWhen(m.closes_at)}.`);
        if (ext && extName) lines.push(`${extName}: YES ${pct(ext.yesPrice)} · ${ext.url}`);
        return say(lines.join("\n"), {
          marketId: m.id,
          image: chart(() => marketCard(m, ext && extName ? { name: extName, yes: ext.yesPrice } : undefined)),
        });
      }

      case "closes": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        if (m.status !== "open") throw new BetError(`#${m.id} is already ${m.status}.`);
        const at = parseWhen(args.slice(1).join(" "));
        if (!at) return say(`Usage: !closes ${m.id} 2h (or 30m, 8pm, tomorrow 9am, fri 8pm)`);
        setCloseTime(m, at.getTime());
        return say(`#${m.id} closes ${describeWhen(at.getTime())}. Last call ${process.env.LAST_CALL_MINUTES ?? 15} min before.`, { marketId: m.id });
      }

      case "demo": {
        // A real market that settles within the hour, so the auto-resolve
        // happens on stage. Off unless DEMO=on.
        if (process.env.DEMO !== "on") return null;
        const pick = await soonestCoinFlip(args[0]?.toLowerCase() === "eth" ? "eth" : "btc");
        if (!pick) return say("No hourly Kalshi crypto market is open right now. Try !kalshi.");
        const m = createMarket(spaceId, userId, pick.question, pick.ref);
        setPrior(m, pick.yesPrice, `Kalshi has it at ${pct(pick.yesPrice)}.`);
        recordExtPrice(m.id, pick.yesPrice);
        setExtPosted(m, pick.yesPrice);
        setCloseTime(m, pick.closesAt);
        return say(
          `#${m.id} ${m.question}\nKalshi: YES ${pct(pick.yesPrice)}. Betting closes ${describeWhen(pick.closesAt)}, then it settles on its own.\n\n!yes ${m.id} ${HINT} · !no ${m.id} ${HINT} · or 👍 / 👎 this`,
          { marketId: m.id, image: chart(() => marketCard(m, { name: "Kalshi", yes: pick.yesPrice })) },
        );
      }

      case "close": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        closeMarket(m);
        return say(`#${m.id} locked. No more bets.`);
      }

      case "cancel": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        if (m.status === "resolved" || m.status === "cancelled") throw new BetError(`#${m.id} is already ${m.status}.`);
        cancelMarket(m);
        return say(`#${m.id} cancelled. All bets void.`);
      }

      case "resolve": {
        const m = requireMarket(spaceId, args[0]);
        const outcome = args[1]?.toLowerCase();
        if (outcome !== "yes" && outcome !== "no") return say(`Usage: !resolve ${m.id} yes|no`);
        requireCreator(m, userId);
        if (m.external) throw new BetError(`#${m.id} follows Kalshi and settles automatically.`);
        return settlementReply(m, outcome, resolveMarket(m, outcome));
      }

      case "bal":
      case "balance":
        if (!PLAY) return say("Real-money mode: there are no balances. See !owe");
        return say(`${displayName(spaceId, userId)}: ${usd(balance(spaceId, userId))}`);

      case "daily": {
        if (!PLAY) return null;
        const bal = claimDaily(spaceId, userId);
        return say(bal == null ? "Daily coins already claimed. Come back tomorrow." : `+${usd(DAILY_COINS)}. Balance: ${usd(bal)}`);
      }

      case "owe":
      case "debts": {
        if (PLAY) return say("Play-money mode: nothing is owed. See !bal");
        const mine = openDebtsFor(userId).map((d) => debtLine(d, userId));
        const group = isDm ? [] : openDebtsInSpace(spaceId).filter((d) => d.debtor !== userId && d.creditor !== userId);
        const lines = mine.length ? mine : ["No open IOUs."];
        if (group.length) {
          lines.push("", "Rest of the group:");
          for (const d of group) lines.push(`${displayName(spaceId, d.debtor)} → ${displayName(spaceId, d.creditor)} ${usd(d.amount)}`);
        }
        return say(lines.join("\n"));
      }

      case "paid": {
        const ds = pickDebts(userId, args[0], "debtor", "owed");
        for (const d of ds) setDebtStatus(d.id, "claimed");
        return say(`Marked ${ds.length === 1 ? `IOU ${ds[0]!.id}` : `${ds.length} IOUs`} as sent. Awaiting confirmation.`, {
          dms: ds.map((d) => ({
            to: d.creditor,
            text: `${displayName(d.space_id, d.debtor)} marked ${usd(d.amount)} as sent (IOU ${d.id}).\nReply !got ${d.id} to confirm or !nope ${d.id} if it did not arrive.`,
          })),
        });
      }

      case "got": {
        const ds = pickDebts(userId, args[0], "creditor", "claimed");
        for (const d of ds) setDebtStatus(d.id, "paid");
        return say(`Confirmed. ${ds.map((d) => `IOU ${d.id}`).join(", ")} closed.`, {
          dms: ds.map((d) => ({ to: d.debtor, text: `${displayName(d.space_id, d.creditor)} confirmed your ${usd(d.amount)}. IOU closed.` })),
        });
      }

      case "nope": {
        const ds = pickDebts(userId, args[0], "creditor", "claimed");
        for (const d of ds) setDebtStatus(d.id, "owed", Date.now() + 6 * 3_600_000); // the DM below is today's nag
        return say(`Noted. Reminders resumed.`, {
          dms: ds.map((d) => {
            const m = getMarketById(d.market_id)!;
            return { to: d.debtor, text: `${displayName(d.space_id, d.creditor)} reports the ${usd(d.amount)} did not arrive.\n\n${howToPay(d, m)}` };
          }),
        });
      }

      case "forgive": {
        const id = Number(args[0]?.replace(/^(iou|#)/i, ""));
        const d = getDebt(id);
        if (!d || d.creditor !== userId || (d.status !== "owed" && d.status !== "claimed")) return say("Usage: !forgive <IOU id> (see !owe)");
        setDebtStatus(d.id, "forgiven");
        return say(`IOU ${d.id} forgiven.`, {
          dms: [{ to: d.debtor, text: `${displayName(d.space_id, d.creditor)} forgave your ${usd(d.amount)}. IOU closed.` }],
        });
      }

      case "venmo":
      case "cashapp": {
        const handle = args[0]?.replace(/^[@$]/, "");
        if (!handle || !/^[\w.-]{2,40}$/.test(handle)) return say(`Usage: !${cmd} yourname`);
        setHandle(userId, cmd, handle);
        return say(`Saved. Payment reminders to you will include a ${cmd === "venmo" ? "Venmo" : "Cash App"} link.`);
      }

      case "lb":
      case "leaderboard": {
        const rows = PLAY ? richList(spaceId) : leaderboard(spaceId);
        if (!rows.length) return say("No settled markets yet.");
        const sign = (n: number) => (PLAY ? "" : n >= 0 ? "+" : "");
        return say(rows.map((r, i) => `${i + 1}. ${displayName(spaceId, r.user_id)} ${sign(r.net)}${usd(r.net)}`).join("\n"));
      }

      case "name": {
        const name = rest.slice(0, 24);
        if (!name) return say("Usage: !name Vish");
        setName(spaceId, userId, name);
        return say(`Name set: ${name}.`);
      }

      case "kalshi":
      case "poly":
      case "polymarket": {
        if (!rest) return say(`Usage: !${cmd} fed rate cut`);
        const source = sources.find((s) => s.prefix === (cmd === "kalshi" ? "kalshi" : "poly"))!;
        const results = await source.search(rest, 4);
        if (!results.length) return say(`No ${source.name} results for "${rest}".`);
        return say([`${source.name} · "${rest}"`, ...results.map((r) => `${r.title}\nYES ${pct(r.yesPrice)} · !mirror ${r.ref}`)].join("\n\n"));
      }

      case "mirror": {
        const ext = args[0] ? await fetchRef(args[0]) : null;
        if (!ext) return say("Usage: !mirror kalshi:<TICKER> (find one with !kalshi)");
        if (ext.resolved) return say(`That market already settled ${ext.resolved.toUpperCase()}.`);
        const m = createMarket(spaceId, userId, ext.title.endsWith("?") ? ext.title : `${ext.title}?`, ext.ref);
        const name = parseRef(ext.ref)!.source.name;
        if (ext.yesPrice != null) {
          setPrior(m, ext.yesPrice, `${name} has it at ${pct(ext.yesPrice)}.`);
          recordExtPrice(m.id, ext.yesPrice);
          setExtPosted(m, ext.yesPrice);
        }
        return say(`#${m.id} ${m.question}\n${name}: YES ${pct(ext.yesPrice)}. Settles automatically.\n!yes ${m.id} ${HINT} · !no ${m.id} ${HINT} · or 👍 / 👎 this`, {
          marketId: m.id,
          image: chart(() => marketCard(m, { name, yes: ext.yesPrice })),
        });
      }

      case "link": {
        const m = requireMarket(spaceId, args[0]);
        requireCreator(m, userId);
        const ext = args[1] ? await fetchRef(args[1]) : null;
        if (!ext) return say(`Usage: !link ${m.id} kalshi:<TICKER>`);
        setExternal(m, ext.ref);
        return say(`#${m.id} now follows ${ext.title} (YES ${pct(ext.yesPrice)}) and settles with it.`);
      }

      default:
        return null; // unknown "!" text — stay quiet so we don't spam normal chat
    }
  } catch (err) {
    if (err instanceof BetError) return say(err.message);
    console.error("[command]", err);
    return say("Something went wrong. Try again.");
  }
}
