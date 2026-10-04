import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { type ExternalMarket, sources } from "./external/index.ts";
import { chatDigest, localStamp, recentTail, storedProfiles, transcript } from "./history.ts";

// Claude reads the group's scanned history to (1) guess a starting probability
// for a new market and (2) decide whether a Kalshi market is the same question.
// Without ANTHROPIC_API_KEY everything falls back to 50% and keyword matching.

const enabled = !!process.env.ANTHROPIC_API_KEY;
const client = enabled ? new Anthropic() : null;
// Opus 5.5 by default: in a side-by-side on real chat history it cited the
// chat most accurately, was the funniest, and was the only model that kept
// real hardships out of roasts (~6¢ a market). claude-sonnet-5-5 is the
// half-price runner-up; claude-haiku-4-5 is cheapest but makes things up.
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
// Haiku 4.5 rejects the effort setting, and refusal fallbacks are for the 5.x models.
const isHaiku = MODEL.startsWith("claude-haiku");
export const oracleEnabled = enabled;

/** Who the bot is, shared by every prompt that writes something the chat will read. */
export const PERSONA = `You are the group chat's bookie: a dry, quick-witted friend who has read every message in this chat, remembers everyone's track record, and loves it when people put coins where their mouth is. You talk like one of the friends: short, casual, deadpan, a little smug when the odds were right. Roast habits, track records and reputations, never real hardships (health, family news, breakups) or anyone's identity.`;

// Field order matters: the model writes these in order, so the evidence comes
// first and the number is decided after weighing it.
const Estimate = z.object({
  yes_no: z.boolean().describe("True if the question can settle as a plain yes or no. False for 'who/which/what' or 'A or B' questions"),
  rewrite: z.string().describe("If yes_no is false, the closest yes/no version of the question (e.g. 'Is Nishant the funniest in the gc?'); else empty"),
  off_limits: z
    .boolean()
    .describe("True if the market bets on a real person's religion, race, ethnicity, sexuality, gender identity or disability, or describes sex acts involving them. Ordinary roasts and insults are NOT off limits"),
  public_event: z.boolean().describe("True if this is about a real-world public event (sports, politics, markets, weather, pop culture)"),
  kalshi_query: z.string().describe("If public_event, 2-5 keywords to find it on Kalshi; else empty"),
  for_yes: z.array(z.string()).describe("1-3 terse fragments supporting YES, 3-8 words each"),
  for_no: z.array(z.string()).describe("1-3 terse fragments supporting NO, 3-8 words each"),
  why: z.string().describe("Short summary of which side wins and why, max 12 words"),
  probability: z.number().describe("Chance the market resolves YES, 0.02 to 0.98, consistent with the summary"),
});
export type Estimate = z.infer<typeof Estimate>;

const ESTIMATE_SYSTEM = `You set opening odds for a friendly prediction market inside an iMessage group chat. The friends bet real money against each other on yes/no questions, often about each other.

Use the chat history below as evidence: who is usually late, who follows through, running jokes, reputations, recent plans. Teasing questions about a friend ("Is X a bitch?", "Will Ajay fold again?") are banter between close friends who roast each other constantly. Take ordinary roasts at face value, never refuse or water them down, and judge them by how the group actually talks about that person. If the history says little, stay near 50%. Never go below 2% or above 98%.

For real-world events (sports, markets, politics), base the number on what you know about the world, not on the group's opinions, and keep longshots low (a single team winning a championship is usually under 15%). Only cite chat points that are actually about the question's subject: don't stretch unrelated messages (a different team, person, or event) into evidence.

${PERSONA}

First check the question itself. If it isn't answerable yes or no ("who's funniest", "A or B"), set yes_no false and suggest a yes/no rewrite. If it bets on someone's religion, race, ethnicity, sexuality, gender identity or disability, or on sex acts involving them, set off_limits true. Crude roasts ("is X a bitch", "is X a fatass") are fine and stay on.

Everything you write is posted in the chat as the case for your number. Write in that voice: short, no emoji, and jabs are welcome when the chat backs them up ("Has 'been about to' learn swimming since June", "Owes Jason for tickets. Again."). Roast habits, track records, and reputations. Leave out real hardships (health, family news, breakups) and anything about identity; those aren't jokes.
- "why": a short summary, max 12 words.
- "for_yes" and "for_no": 1-3 points each, written as terse fragments of 3-8 words, not sentences. Name who and roughly when ("Harish has a tent (Aug 3)", "No plans since August"). No filler words. If one side has nothing, use a single point like "Nothing in chat". Together they should explain the number.
- Plain everyday words. No trading or betting jargon (scalping, break-even, spread, hedge, liquidity).`;

const estimateFormat = betaZodOutputFormat(Estimate);

async function ask<T>(system: Anthropic.Beta.BetaTextBlockParam[], user: string, format: ReturnType<typeof betaZodOutputFormat<z.ZodType<T>>>, effort: "low" | "medium") {
  const res = await client!.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...(isHaiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    output_config: isHaiku ? { format } : { effort, format },
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

// What each estimate reads about the group. "digest" (default): the dossier
// written once at scan time, ~10x smaller than the raw chat, so every market
// and every cache reload is cheap and restarts cost nothing. "full": the raw
// history (~85K tokens), slightly richer but ~65¢ per cache reload on Opus.
// Built once and reused byte-for-byte so Claude can serve it from cache.
const CONTEXT_MODE = process.env.CONTEXT_MODE === "full" ? "full" : "digest";
// Per chat, never shared: a market only ever sees its own chat's dossier and
// profiles. Built once per chat and reused byte-for-byte so it stays cached.
const contextMemo = new Map<string, string>();
const contextFor = (spaceId: string) => {
  let c = contextMemo.get(spaceId);
  if (c == null) {
    const chat = CONTEXT_MODE === "full" ? transcript(isHaiku ? 300_000 : 600_000, undefined, spaceId) : chatDigest(spaceId);
    c = [chat, profilesContext(spaceId)].filter(Boolean).join("\n\n");
    contextMemo.set(spaceId, c);
  }
  return c;
};

let lastCall = 0;

/** Opening odds for a question, from the group's history. */
export async function estimate(spaceId: string, question: string): Promise<Estimate | null> {
  if (!client) return null;
  lastCall = Date.now();
  const history_ = contextFor(spaceId);
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: ESTIMATE_SYSTEM },
    // The scanned history is the big, stable part: cache it for an hour.
    ...(history_ ? [{ type: "text" as const, text: history_, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] : []),
  ];
  const tail = recentTail(spaceId);
  const user = `${tail ? `Latest messages in the chat where this market was opened:\n${tail}\n\n` : ""}It is now ${localStamp(Date.now())} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).\nNew market: "${question}"`;
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
  // The dossier is small enough that a cold read costs about a cent: no warm-up needed.
  if (!client || !contextFor(spaceId) || CONTEXT_MODE === "digest") return;
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
        [{ type: "text", text: "You match a friend group's prediction market question to an identical Kalshi market. Kalshi words things formally: the Super Bowl is the \"Pro Football Championship\", the NBA Finals the \"Pro Basketball Championship\", teams appear as city plus name or abbreviation (\"DET Lions\"), and \"this season\" means the season's championship market. Pick a candidate when it resolves on the same event and the same condition: same team or person, same threshold, and the same deadline. Check deadlines carefully: \"before 2027\" means by Dec 31, 2026, so a market ending Dec 31, 2027 is NOT a match. A formal title for the same thing counts. If none is the same question, return empty." }],
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

const DIGEST_SYSTEM = `You read a friend group's entire iMessage history once and write the dossier a bookie will use, instead of the raw chat, to set odds on bets about these people. It must be dense and evidence-backed, because nobody will see the original messages again.

Plain text, terse bullets, no preamble. Up to ~2,500 words.

PEOPLE: one section per person (use the names as they appear). Under each:
- Reliability: plans they proposed or joined, and what happened. Date each one.
- Habits and reputation: what the group says about them, with short quotes and dates ("ESPECIALLY vish" won't pay, Jul 21).
- Money: who owes whom, who fronts, who pays late.
- Interests, teams, rivalries, running jokes about them.
PLANS: every group plan, when first pitched, latest status, and who is in.
RUNNING JOKES AND BITS: one line each.
SENSITIVE (never joke about): real hardships such as health, family news, or breakups, listed briefly so the odds-setter knows to leave them out.

Prefer specifics over adjectives. Keep dates as "Mon D".`;

/** One-time read of a whole chat into the dossier markets use. Streams, since it's long. */
export async function buildDigest(chatName: string, fullTranscript: string): Promise<string | null> {
  if (!client) return null;
  try {
    // Refusal fallback: chats full of bot commands can trip a safety classifier
    // by mistake, and this re-runs the request on a fallback model instead.
    const msg = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        ...(isHaiku
          ? {}
          : { output_config: { effort: "medium" as const }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        system: DIGEST_SYSTEM,
        messages: [{ role: "user", content: `Group chat "${chatName}":\n\n${fullTranscript}` }],
      })
      .finalMessage();
    if (msg.stop_reason === "refusal") {
      console.warn(`[digest] declined (${msg.stop_details?.category ?? "no category"})`);
      return null;
    }
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (!text) console.warn(`[digest] no text returned (stop: ${msg.stop_reason})`);
    console.log(`[oracle] dossier: ${msg.usage.input_tokens} tokens read, ${msg.usage.output_tokens} written`);
    return text || null;
  } catch (err) {
    logApiError("digest", err);
    return null;
  }
}

// ---------- personality profiles ----------

const PersonProfile = z.object({
  vibe: z.string().describe("Who they are in the group, one line, max 20 words"),
  humor: z.string().describe("Their sense of humor and how they text, max 20 words"),
  reliability: z.string().describe("Follow-through on plans, with dated evidence, max 25 words"),
  money: z.string().describe("How they handle paying, owing, spending, with evidence, max 20 words; 'Nothing in chat' if none"),
  interests: z.array(z.string()).describe("2-5 interests, teams, obsessions, 1-4 words each"),
  catchphrases: z.array(z.string()).describe("0-4 things they actually say, quoted verbatim from their messages"),
  roastable: z.array(z.string()).describe("2-4 fair-game jabs grounded in the chat, 3-10 words each"),
  avoid: z.array(z.string()).describe("Real hardships (health, family news, breakups) or identity topics to never joke about; empty if none"),
});
export type PersonProfile = z.infer<typeof PersonProfile>;
const profileFormat = betaZodOutputFormat(PersonProfile);

const PROFILE_SYSTEM = `You write a short personality profile of one person as one specific group chat knows them, for a bot that sets odds on friendly bets about them and occasionally roasts them. Base every line only on the messages given from this chat: cite dates or quotes where you can, never invent, and don't bring in outside knowledge about them. Plain everyday words, no trading or betting jargon. Dry and specific beats generic ("Pitched beach day 6 times since June, 0 dates set" beats "a bit flaky"). Real hardships go in "avoid" only, never anywhere else.`;

/** One person's cached profile, built from their messages and what friends say about them. */
export async function buildProfile(name: string, evidence: string): Promise<PersonProfile | null> {
  if (!client) return null;
  try {
    return await ask([{ type: "text", text: PROFILE_SYSTEM }], `Person: ${name}\n\n${evidence}`, profileFormat, "medium");
  } catch (err) {
    logApiError("profile", err);
    return null;
  }
}

/** This chat's cached profiles, as one stable block for its odds context. */
function profilesContext(spaceId: string): string {
  const rows = storedProfiles(spaceId);
  if (!rows.length) return "";
  const lines = rows.map(({ name, data }) => {
    const p = JSON.parse(data) as PersonProfile;
    return [
      `${name}: ${p.vibe}`,
      `  Humor: ${p.humor}`,
      `  Reliability: ${p.reliability}`,
      `  Money: ${p.money}`,
      `  Into: ${p.interests.join(", ")}`,
      p.catchphrases.length ? `  Says: ${p.catchphrases.map((c) => `"${c}"`).join(", ")}` : "",
      `  Fair game: ${p.roastable.join("; ")}`,
      p.avoid.length ? `  NEVER joke about: ${p.avoid.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `=== Personality profiles (people in this chat, as this chat knows them) ===\n${lines.join("\n\n")}`;
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
