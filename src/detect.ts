import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// Passive "that sounds like a bet" detection. Optional: only runs when
// ANTHROPIC_API_KEY is set and BET_DETECTION isn't "off".
const enabled = !!process.env.ANTHROPIC_API_KEY && process.env.BET_DETECTION !== "off";
const client = enabled ? new Anthropic() : null;

const Detection = z.object({
  is_bettable: z.boolean(),
  question: z.string().describe("A crisp yes/no question with a clear resolution, or empty"),
  search_query: z
    .string()
    .describe("2-4 keywords to look this up on Kalshi/Polymarket if it's a public event, else empty"),
});
export type Detection = z.infer<typeof Detection>;

const SYSTEM = `You watch an iMessage group chat of friends and spot moments that could become a friendly prediction market.

Flag a message as bettable only when it contains a concrete, verifiable claim or prediction about the future (or a disputed fact that can be checked), e.g. "Jake is 100% going to be late again", "Lions win Sunday easy", "no way it snows before Thanksgiving", "bet you can't finish that burrito". Ignore greetings, opinions with no resolution, logistics, and jokes with nothing to settle.

When bettable, write the question so it resolves cleanly: name who/what, the threshold, and the deadline if implied (e.g. "Will Jake arrive after 8:00pm tonight?"). If it's about a public event (sports, politics, markets, weather, pop culture), give a short search_query; otherwise leave it empty.`;

const lastRun = new Map<string, number>();
const COOLDOWN_MS = Number(process.env.DETECT_COOLDOWN_MS ?? 45_000);

export async function detectBet(spaceId: string, text: string): Promise<Detection | null> {
  if (!client) return null;
  if (text.length < 12 || text.length > 500) return null;
  const now = Date.now();
  if (now - (lastRun.get(spaceId) ?? 0) < COOLDOWN_MS) return null;
  lastRun.set(spaceId, now);

  try {
    const res = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(Detection) },
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    if (res.stop_reason === "refusal") return null;
    const out = res.parsed_output;
    return out?.is_bettable && out.question ? out : null;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn("[detect] rate limited");
    else if (err instanceof Anthropic.APIError) console.warn(`[detect] API ${err.status}: ${err.message}`);
    else console.warn("[detect]", err);
    return null;
  }
}

export const detectionEnabled = enabled;
