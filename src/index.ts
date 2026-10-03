import { type Message, Spectrum, type Space } from "spectrum-ts";
import { handleCommand, isCommand, suggestions } from "./commands.ts";
import { detectBet, detectionEnabled } from "./detect.ts";
import { sources } from "./external/index.ts";
import { startResolver } from "./resolver.ts";

/**
 * Provider selection:
 *   --terminal                  local REPL, no iMessage needed (great for demos/dev)
 *   SPECTRUM_PROJECT_ID set     Spectrum Cloud iMessage line
 *   otherwise                   this Mac's Messages.app (needs Full Disk Access)
 *
 * Each branch calls Spectrum() separately because its overloads are typed per
 * provider set; the loop below only needs the shared [Space, Message] stream.
 */
type App = { messages: AsyncIterable<[Space, Message]> };

async function createApp(): Promise<App> {
  if (process.argv.includes("--terminal")) {
    const { terminal } = await import("spectrum-ts/providers/terminal");
    return Spectrum({ providers: [terminal.config()] });
  }
  if (process.env.SPECTRUM_PROJECT_ID) {
    const { imessage } = await import("spectrum-ts/providers/imessage");
    return Spectrum({
      projectId: process.env.SPECTRUM_PROJECT_ID,
      projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
      providers: [imessage.config()],
    });
  }
  const { localIMessage } = await import("@spectrum-ts/imessage-local");
  return Spectrum({ providers: [localIMessage.config()] });
}

const app = await createApp();

// Remember spaces we've seen so background settlements can post into them.
const spaces = new Map<string, Space>();
const pending = new Map<string, string[]>();

async function announce(spaceId: string, text: string) {
  const space = spaces.get(spaceId);
  if (space) await space.send(text);
  else pending.set(spaceId, [...(pending.get(spaceId) ?? []), text]); // flush on next message
}

// Local mode sees every chat on this Mac. ALLOWED_CHATS (comma-separated chat
// ids) limits the bot to specific chats; --discover only logs ids, never replies.
const allowed = new Set(
  (process.env.ALLOWED_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const discover = process.argv.includes("--discover");

if (!discover) startResolver(announce);
console.log(
  `🎲 group-markets running · bet detection ${detectionEnabled ? "on" : "off"} · ` +
    (discover ? "DISCOVER mode (read-only)" : allowed.size ? `chats: ${[...allowed].join(", ")}` : "ALL chats"),
);

for await (const [space, message] of app.messages) {
  if (discover) {
    const name = await space.getDisplayName().catch(() => undefined);
    const preview = message.content.type === "text" ? message.content.text.slice(0, 40) : message.content.type;
    console.log(`[discover] chat=${space.id} name=${name ?? "-"} from=${message.sender?.id ?? "me"} "${preview}"`);
    continue;
  }
  if (allowed.size && !allowed.has(space.id)) continue;
  if (message.content.type !== "text") continue;
  if (message.sender?.kind === "agent") continue; // our own replies

  spaces.set(space.id, space);
  for (const text of pending.get(space.id) ?? []) await space.send(text);
  pending.delete(space.id);

  const text = message.content.text;
  // In local mode, messages you type from this Mac arrive as outbound with no
  // sender. Let those through as commands (from "me") but never auto-detect them.
  const outbound = message.direction === "outbound";
  const userId = message.sender?.id ?? "me";

  try {
    if (isCommand(text)) {
      const reply = await handleCommand({ spaceId: space.id, userId, text });
      if (reply) await space.send(reply);
      continue;
    }
    if (outbound) continue;

    const hit = await detectBet(space.id, text);
    if (!hit) continue;

    let line = "";
    if (hit.search_query) {
      const [top] = await sources[0]!.search(hit.search_query, 1).catch(() => []);
      if (top && !top.resolved) {
        line = `\n📈 Kalshi has a market on this: YES ${Math.round((top.yesPrice ?? 0) * 100)}% (!mirror ${top.ref})`;
      }
    }
    suggestions.set(space.id, { question: hit.question });
    await space.send(`👀 That sounds like a bet: "${hit.question}"\nReply !new to open it.${line}`);
  } catch (err) {
    console.error("[loop]", err);
  }
}
