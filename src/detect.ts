import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { displayName, impliedYes, listMarkets, stakes } from "./markets.ts";
import { usd } from "./money.ts";
import { MODEL, PERSONA } from "./oracle.ts";
import { pct } from "./external/index.ts";
import { localStamp } from "./history.ts";

// The bot watching the chat between commands. One Claude call per message
// (after a cooldown) does two jobs: spot a claim that could become a market,
// and react when a message is evidence for a market people have money on.
// Optional: only runs when ANTHROPIC_API_KEY is set and BET_DETECTION isn't "off".
const enabled = !!process.env.ANTHROPIC_API_KEY && process.env.BET_DETECTION !== "off";
const client = enabled ? new Anthropic() : null;

const Observation = z.object({
  related_market: z.number().describe("Id of the open market this message is real evidence for, or 0 if none"),
  leans: z.enum(["yes", "no", "neither"]).describe("Which way the message pushes that market"),
  reaction: z
    .string()
    .describe("If related_market is set: one short line (max 18 words) reacting to what this means for the people who bet, naming them. Else empty"),
  is_bettable: z.boolean(),
  question: z.string().describe("A crisp yes/no question with a clear resolution, or empty"),
  search_query: z
    .string()
    .describe("2-4 keywords to look this up on Kalshi/Polymarket if it's a public event, else empty"),
});
type Observation = z.infer<typeof Observation>;
export type Detection = Pick<Observation, "question" | "search_query">;

const SYSTEM = `${PERSONA}

You're watching the chat between commands. For each message, do two things.

1. React to the action. If the message is real evidence for one of the open markets listed (someone says they're running late on a "will X be on time" market, posts their gym PR on an "is X jacked" market, confirms or cancels a plan), set related_market and leans, and write one short reaction aimed at the people with money on it: who just got closer to winning or losing. Use names and amounts. Only real evidence counts: a message that merely mentions the topic, or is a joke about it, gets related_market 0. Most messages get 0.

2. Spot new bets. Flag a message as bettable only when it contains a concrete, verifiable claim or prediction about the future (or a disputed fact that can be checked), e.g. "Jake is 100% going to be late again", "Lions win Sunday easy", "no way it snows before Thanksgiving", "bet you can't finish that burrito". Friends roasting each other count too ("Nishant is gonna flake again", "Ajay is never learning to swim", "Vish will not pay you back"): those are the best markets, so flag them and keep the teasing energy in the question. Never flag questions about someone's religion, race, sexuality or sex life. Ignore greetings, opinions with no resolution, logistics, and jokes with nothing to settle. Don't flag something an open market already covers.

When bettable, write the question so it resolves cleanly: name who/what, the threshold, and the deadline if implied (e.g. "Will Jake arrive after 8:00pm tonight?"). If it's about a public event (sports, politics, markets, weather, pop culture), give a short search_query; otherwise leave it empty.

Plain everyday words, no trading jargon.`;

/** The chat's open markets and who has money where, for the model to react to. */
function openBook(spaceId: string): string {
  const ms = listMarkets(spaceId, ["open"]);
  if (!ms.length) return "No open markets.";
  return ms
    .map((m) => {
      const who = stakes(m.id).map((s) => `${displayName(spaceId, s.user_id)} ${usd(s.amount)} ${s.side.toUpperCase()}`);
      return `#${m.id} ${m.question} (YES ${pct(impliedYes(m))}) · ${who.length ? who.join(", ") : "no bets yet"}`;
    })
    .join("\n");
}

const lastRun = new Map<string, number>();
const COOLDOWN_MS = Number(process.env.DETECT_COOLDOWN_MS ?? 45_000);
// Reactions are fun once, noise five times: at most one per chat every
// REACT_COOLDOWN_MS, and one per market every REACT_MARKET_COOLDOWN_MS.
const REACT_COOLDOWN_MS = Number(process.env.REACT_COOLDOWN_MS ?? 90_000);
const REACT_MARKET_COOLDOWN_MS = Number(process.env.REACT_MARKET_COOLDOWN_MS ?? 15 * 60_000);
const lastReact = new Map<string, number>();

export interface Seen {
  /** A line to post reacting to the message, about a market with money on it. */
  reaction?: { marketId: number; text: string };
  /** A claim worth turning into a market. */
  suggestion?: Detection;
}

export async function observe(spaceId: string, sender: string, text: string): Promise<Seen | null> {
  if (!client) return null;
  if (text.length < 4 || text.length > 500) return null;
  const now = Date.now();
  if (now - (lastRun.get(spaceId) ?? 0) < COOLDOWN_MS) return null;
  lastRun.set(spaceId, now);

  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      output_config: MODEL.startsWith("claude-haiku") ? { format: zodOutputFormat(Observation) } : { effort: "low", format: zodOutputFormat(Observation) },
      system: SYSTEM,
      messages: [{ role: "user", content: `It is now ${localStamp(now)}.\nOpen markets:\n${openBook(spaceId)}\n\n${displayName(spaceId, sender)}: ${text}` }],
    });
    if (res.stop_reason === "refusal") return null;
    const out = res.parsed_output;
    if (!out) return null;

    const seen: Seen = {};
    const market = out.related_market ? listMarkets(spaceId, ["open"]).find((m) => m.id === out.related_market) : undefined;
    const hasMoney = market && stakes(market.id).length > 0;
    if (market && hasMoney && out.leans !== "neither" && out.reaction.trim() && canReact(spaceId, market.id, now)) {
      seen.reaction = { marketId: market.id, text: `👀 #${market.id} · ${out.reaction.trim()}` };
    }
    if (out.is_bettable && out.question) seen.suggestion = { question: out.question, search_query: out.search_query };
    return seen.reaction || seen.suggestion ? seen : null;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn("[observe] rate limited");
    else if (err instanceof Anthropic.APIError) console.warn(`[observe] API ${err.status}: ${err.message}`);
    else console.warn("[observe]", err);
    return null;
  }
}

function canReact(spaceId: string, marketId: number, now: number) {
  const chatKey = spaceId;
  const marketKey = `${spaceId}#${marketId}`;
  if (now - (lastReact.get(chatKey) ?? 0) < REACT_COOLDOWN_MS) return false;
  if (now - (lastReact.get(marketKey) ?? 0) < REACT_MARKET_COOLDOWN_MS) return false;
  lastReact.set(chatKey, now);
  lastReact.set(marketKey, now);
  return true;
}

export const detectionEnabled = enabled;
