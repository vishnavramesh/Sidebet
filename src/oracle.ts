import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { type ExternalMarket, sources } from "./external/index.ts";
import { recentTail, transcript } from "./history.ts";

// Claude reads the group's scanned history to (1) guess a starting probability
// for a new market and (2) decide whether a Kalshi market is the same question.
// Without ANTHROPIC_API_KEY everything falls back to 50% and keyword matching.

const enabled = !!process.env.ANTHROPIC_API_KEY;
const client = enabled ? new Anthropic() : null;
const MODEL = "claude-opus-5-5";
export const oracleEnabled = enabled;

const Estimate = z.object({
  probability: z.number().describe("Chance the market resolves YES, 0.02 to 0.98"),
  why: z.string().describe("One neutral sentence summing up the call (max 20 words)"),
  for_yes: z.array(z.string()).describe("1-3 short points from the chat that support YES, each under 15 words"),
  for_no: z.array(z.string()).describe("1-3 short points from the chat that support NO, each under 15 words"),
  public_event: z.boolean().describe("True if this is about a real-world public event (sports, politics, markets, weather, pop culture)"),
  kalshi_query: z.string().describe("If public_event, 2-5 keywords to find it on Kalshi; else empty"),
});
export type Estimate = z.infer<typeof Estimate>;

const ESTIMATE_SYSTEM = `You set opening odds for a friendly prediction market inside an iMessage group chat. The friends bet real money against each other on yes/no questions, often about each other.

Use the chat history below as evidence: who is usually late, who follows through, running jokes, reputations, recent plans. Teasing questions about a friend ("Is X a bitch?") are banter, so judge them by how the group actually talks about that person. If the history says little, stay near 50%. Never go below 2% or above 98%.

Everything you write is posted in the chat as the case for your number, so keep it neutral and factual, no slang or emoji:
- "why": one sentence summing up the call, under 20 words.
- "for_yes" and "for_no": 1-3 short points each, under 15 words, citing specific things from the chat (who said or did what, and roughly when). If the chat has nothing on one side, give one point saying so. The two lists together should explain why the number sits where it does.`;

const estimateFormat = betaZodOutputFormat(Estimate);

async function ask<T>(system: Anthropic.Beta.BetaTextBlockParam[], user: string, format: ReturnType<typeof betaZodOutputFormat<z.ZodType<T>>>, effort: "low" | "medium") {
  const res = await client!.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format },
    system,
    messages: [{ role: "user", content: user }],
  });
  const u = res.usage;
  console.log(`[oracle] ${u.input_tokens} new + ${u.cache_read_input_tokens ?? 0} cached + ${u.cache_creation_input_tokens ?? 0} written tokens`);
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

function logApiError(where: string, err: unknown) {
  if (err instanceof Anthropic.RateLimitError) console.warn(`[${where}] rate limited`);
  else if (err instanceof Anthropic.AuthenticationError) console.warn(`[${where}] ANTHROPIC_API_KEY was rejected`);
  else if (err instanceof Anthropic.APIError) console.warn(`[${where}] API ${err.status}: ${err.message}`);
  else console.warn(`[${where}]`, err);
}

// The scanned history only changes when `npm run scan` runs, so build the
// big text once and reuse the exact same bytes: that is what lets every
// estimate read it from Claude's cache instead of re-sending it.
let historyMemo: string | undefined;
const history = () => (historyMemo ??= transcript());

let lastCall = 0;

/** Opening odds for a question, from the group's history. */
export async function estimate(spaceId: string, question: string): Promise<Estimate | null> {
  if (!client) return null;
  lastCall = Date.now();
  const history_ = history();
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: ESTIMATE_SYSTEM },
    // The scanned history is the big, stable part: cache it for an hour.
    ...(history_ ? [{ type: "text" as const, text: history_, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] : []),
  ];
  const tail = recentTail(spaceId);
  const user = `${tail ? `Latest messages in the chat where this market was opened:\n${tail}\n\n` : ""}Today is ${new Date().toDateString()}.\nNew market: "${question}"`;
  try {
    const out = await ask(system, user, estimateFormat, "low");
    if (!out) return null;
    return { ...out, probability: Math.min(0.98, Math.max(0.02, out.probability)) };
  } catch (err) {
    logApiError("estimate", err);
    return null;
  }
}

/**
 * Load the chat history into Claude's cache before anyone opens a market, and
 * keep it there. A zero-output warm-up isn't allowed with structured output,
 * so this runs one tiny real estimate; the cache lasts an hour and every real
 * market refreshes it, so we only re-warm after 50 quiet minutes.
 */
export function keepCacheWarm(spaceId: string) {
  if (!client || !history()) return;
  const warm = async () => {
    if (Date.now() - lastCall < 50 * 60_000 && lastCall) return;
    const t0 = Date.now();
    await estimate(spaceId, "Will someone send a message in this chat tomorrow?");
    console.log(`[oracle] cache warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };
  void warm();
  setInterval(() => void warm(), 10 * 60_000).unref();
}

const Match = z.object({
  ticker_ref: z.string().describe('The "ref" of the candidate that asks the same question, or empty if none does'),
});
const matchFormat = betaZodOutputFormat(Match);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["will", "the", "and", "for", "before", "this", "that", "with", "does"].includes(w)),
  );

/**
 * Find the Kalshi market asking the same thing, if any. Claude judges the
 * match when available; otherwise require strong keyword overlap.
 */
export async function findKalshiTwin(question: string, query?: string): Promise<ExternalMarket | null> {
  const kalshi = sources.find((s) => s.prefix === "kalshi")!;
  const candidates = (await kalshi.search(query || question, 6).catch(() => [])).filter((c) => !c.resolved);
  if (!candidates.length) return null;

  if (client) {
    try {
      const list = candidates.map((c) => `ref=${c.ref} | ${c.title} | YES ${Math.round((c.yesPrice ?? 0) * 100)}%`).join("\n");
      const out = await ask(
        [{ type: "text", text: "You match a friend group's prediction market question to an identical Kalshi market. Only pick one that resolves on the same event and the same condition (same team, threshold, and date window). If unsure, return empty." }],
        `Question: "${question}"\nCandidates:\n${list}`,
        matchFormat,
        "low",
      );
      return candidates.find((c) => c.ref === out?.ticker_ref) ?? null;
    } catch (err) {
      logApiError("kalshi-match", err);
    }
  }
  const q = words(question);
  if (q.size < 2) return null;
  const best = candidates
    .map((c) => {
      const t = words(c.title);
      return { c, score: [...q].filter((w) => t.has(w)).length / q.size };
    })
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.7 ? best.c : null;
}

const Lore = z.object({
  summary: z.string().describe("Under 300 words: who is who, their habits and reputations, running jokes, recurring plans"),
});
const loreFormat = betaZodOutputFormat(Lore);

/** One-time read of a whole chat, so later estimates start from a summary. */
export async function buildLore(chatName: string, fullTranscript: string): Promise<string | null> {
  if (!client) return null;
  try {
    const out = await ask(
      [{ type: "text", text: "You read a friend group's entire iMessage history and write a dossier a bookie could use to set odds on bets about these people. Be specific and cite patterns, not single messages." }],
      `Group chat "${chatName}":\n\n${fullTranscript}`,
      loreFormat,
      "medium",
    );
    return out?.summary ?? null;
  } catch (err) {
    logApiError("lore", err);
    return null;
  }
}
