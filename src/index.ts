import { execFileSync } from "node:child_process";
import { attachment, type Message, Spectrum, type Space } from "spectrum-ts";
import { lookupSender } from "./chatdb.ts";
import { handleCommand, isCommand, type Reply, suggestions, TAPBACK_CENTS } from "./commands.ts";
import { detectBet, detectionEnabled } from "./detect.ts";
import { sources } from "./external/index.ts";
import { recordMessage } from "./history.ts";
import { scheduleChart } from "./live.ts";
import { keepCacheWarm } from "./oracle.ts";
import { isKnownUser, linkMarketMessage, marketForMessage } from "./markets.ts";
import { startNagger } from "./nagger.ts";
import { startCloser } from "./closer.ts";
import { startResolver } from "./resolver.ts";
import { botVoice, plainText } from "./voice.ts";

/**
 * Provider selection:
 *   --terminal                  local REPL, no iMessage needed (great for demos/dev)
 *   SPECTRUM_PROJECT_ID set     Spectrum Cloud iMessage line
 *   otherwise                   this Mac's Messages.app (needs Full Disk Access)
 *
 * Each branch calls Spectrum() separately because its overloads are typed per
 * provider set; the loop below only needs the shared [Space, Message] stream
 * plus a way to open a 1:1 chat for payment reminders.
 */
type OwnMessage = { chatId: string; guid: string; text: string; ts: number };
type Tapback = { chatId: string; guid: string; sender: string; kind: string; target: string; removed: boolean };
type App = {
  messages: AsyncIterable<[Space, Message]>;
  openDm: (userId: string) => Promise<Space | undefined>;
  /** Local mode only: the owner's own messages and everyone's tapbacks, in these chats. */
  watchLocal?: (chatIds: string[], onOwn: (m: OwnMessage) => void, onTapback: (t: Tapback) => void) => Promise<void>;
  getSpace?: (id: string) => Promise<Space>;
};

async function createApp(): Promise<App> {
  if (process.argv.includes("--terminal")) {
    const { terminal } = await import("spectrum-ts/providers/terminal");
    const app = await Spectrum({ providers: [terminal.config()] });
    return { messages: app.messages, openDm: async () => undefined };
  }
  if (process.env.SPECTRUM_PROJECT_ID) {
    const { imessage } = await import("spectrum-ts/providers/imessage");
    const app = await Spectrum({
      projectId: process.env.SPECTRUM_PROJECT_ID,
      projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
      providers: [imessage.config()],
    });
    return { messages: app.messages, openDm: (u) => imessage(app).space.create(u) };
  }
  const { localIMessage } = await import("@spectrum-ts/imessage-local");
  const app = await Spectrum({ providers: [localIMessage.config()] });
  return {
    messages: app.messages,
    openDm: (u) => localIMessage(app).space.create(u),
    getSpace: (id) => localIMessage(app).space.get(id),
    // Spectrum only streams other people's text messages, so poll chat.db for
    // the two things it drops: the owner's own messages and tapbacks. Polling
    // (not imessage-kit's watcher) because a row often lands before its text or
    // sender does, and the watcher looks at each row only once. The callers
    // de-duplicate by message id and skip rows that aren't complete yet.
    watchLocal: async (chatIds, onOwn, onTapback) => {
      const { IMessageSDK } = await import("@photon-ai/imessage-kit");
      const sdk = new IMessageSDK();
      const since = new Date();
      const poll = async () => {
        for (const chatId of chatIds) {
          const rows = await sdk.getMessages({ chatId, since, limit: 40 }).catch(() => []);
          for (const m of rows) {
            const r = m.reaction;
            if (r) {
              const sender = m.isFromMe ? OWNER : m.participant;
              const target = r.targetMessageId?.replace(/^(?:b?p:\d+\/)/, "");
              if (sender && target) onTapback({ chatId, guid: m.id, sender, kind: r.kind, target, removed: r.isRemoved });
            } else if (m.isFromMe && m.text) {
              onOwn({ chatId, guid: m.id, text: m.text, ts: m.createdAt.getTime() });
            }
          }
        }
      };
      setInterval(() => void poll(), Number(process.env.OWN_POLL_MS ?? 2000));
    },
  };
}

const app = await createApp();

// Remember spaces we've seen so background settlements and reminders can post into them.
const spaces = new Map<string, Space>();
const pending = new Map<string, Reply[]>();

// Local mode sends through Messages.app. If someone quit it, relaunch it
// in the background and retry once instead of dropping the reply.
async function send(space: Space, content: string | ReturnType<typeof attachment>) {
  if (typeof content === "string") {
    content = botVoice(content);
    remember(content); // what actually lands in chat.db, for the own-message filter
  }
  try {
    return await space.send(content);
  } catch (err) {
    if (!String(err).includes("Messages app is not running")) throw err;
    console.warn("[send] Messages was closed, reopening it");
    execFileSync("open", ["-g", "-a", "Messages"]);
    await new Promise((r) => setTimeout(r, 4000));
    return await space.send(content);
  }
}

async function sendDm(userId: string, text: string) {
  if (userId === OWNER) return console.log(`[dm → owner, skipped] ${text}`); // can't DM yourself
  const space = await app.openDm(userId).catch((err) => {
    console.warn(`[dm] can't open chat with ${userId}`, err);
    return undefined;
  });
  if (space) await send(space, text);
  else console.log(`[dm → ${userId}] ${text}`);
}

// Texts the bot sent recently, so the own-message watcher never treats a bot
// reply (which also comes from this account) as the owner typing.
const sentByBot = new Set<string>();
const remember = (text: string) => {
  sentByBot.add(text.trim());
  if (sentByBot.size > 200) sentByBot.delete(sentByBot.values().next().value!);
};

// Bot texts about a market, so the poller can tie the chat.db row (and any
// tapbacks on it) back to that market once it shows up.
const marketTexts = new Map<string, number>();

async function sendTo(space: Space, reply: Reply) {
  if (reply.marketId) {
    marketTexts.set(botVoice(reply.text).trim(), reply.marketId);
    if (marketTexts.size > 200) marketTexts.delete(marketTexts.keys().next().value!);
  }
  await send(space, reply.text);
  if (reply.image) {
    await send(space, attachment(reply.image, { name: "market.png", mimeType: "image/png" }))
      .catch((err) => console.warn("[chart] couldn't send image", err));
  }
  for (const dm of reply.dms ?? []) await sendDm(dm.to, dm.text).catch((err) => console.warn("[dm]", err));
}

async function deliver(spaceId: string, reply: Reply) {
  const space = spaces.get(spaceId);
  if (space) await sendTo(space, reply);
  else pending.set(spaceId, [...(pending.get(spaceId) ?? []), reply]); // flush on next message
}

// Local mode sees every chat on this Mac. ALLOWED_CHATS (comma-separated chat
// ids) limits the bot to specific group chats; --discover only logs ids, never replies.
// DMs are always allowed from people the bot already knows, so debtors can reply !paid.
const allowed = new Set(
  (process.env.ALLOWED_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const discover = process.argv.includes("--discover");
const isDmSpace = (id: string) => id.includes(";-;");
/** The bot owner's user id: their own messages carry no sender handle. */
const OWNER = "me";

if (!discover) {
  // Load the scanned history into Claude's cache now, so the first market is fast.
  const firstChat = [...allowed][0];
  if (firstChat) keepCacheWarm(firstChat);
  startResolver(deliver);
  startCloser(deliver);
  startNagger({ dm: sendDm, announce: (spaceId, text) => deliver(spaceId, { text }) });
}
console.log(
  `🎲 group-markets running · bet detection ${detectionEnabled ? "on" : "off"} · ` +
    (discover ? "DISCOVER mode (read-only)" : allowed.size ? `chats: ${[...allowed].join(", ")}` : "ALL chats"),
);

/** A text in an allowed group chat, from anyone including the owner. */
async function onGroupText(space: Space, userId: string, rawText: string, guid: string, ts: number) {
  const text = plainText(rawText);
  spaces.set(space.id, space);
  for (const r of pending.get(space.id) ?? []) await sendTo(space, r);
  pending.delete(space.id);

  // Keep the history the odds come from current.
  recordMessage(space.id, { guid, sender: userId, text, ts });

  try {
    if (isCommand(text)) {
      const notify = async (note: string) => {
        await send(space, note);
      };
      const reply = await handleCommand({ spaceId: space.id, userId, text, notify });
      if (reply) await sendTo(space, reply);
      if (reply?.betOn) scheduleChart(reply.betOn, deliver);
      return;
    }
    if (userId === OWNER) return; // don't run bet detection on the owner's own chatter

    const hit = await detectBet(space.id, text);
    if (!hit) return;

    let line = "";
    if (hit.search_query) {
      const [top] = await sources[0]!.search(hit.search_query, 1).catch(() => []);
      if (top && !top.resolved) {
        line = `\nKalshi: YES ${Math.round((top.yesPrice ?? 0) * 100)}% (!mirror ${top.ref})`;
      }
    }
    suggestions.set(space.id, { question: hit.question });
    const suggestion = `Possible market: "${hit.question}"\nReply !new to open it.${line}`;
    await send(space, suggestion);
  } catch (err) {
    console.error("[loop]", err);
  }
}

// The owner's own messages (same handling as anyone's) and tapback bets.
const seenOwn = new Set<string>();
const seenTapbacks = new Set<string>();
const TAPBACK_SIDES: Record<string, "yes" | "no"> = { like: "yes", dislike: "no" };

if (!discover && app.watchLocal && app.getSpace) {
  const spaceFor = async (id: string) => spaces.get(id) ?? (await app.getSpace!(id));
  void app
    .watchLocal(
      [...allowed],
      async (m) => {
        if (seenOwn.has(m.guid) || isDmSpace(m.chatId)) return; // polled again every few seconds
        if (allowed.size > 0 && !allowed.has(m.chatId)) return;
        const text = m.text.trim();
        if (sentByBot.has(text)) {
          // Our own reply landing in chat.db: if it's about a market, remember its id.
          const marketId = marketTexts.get(text);
          if (marketId) linkMarketMessage(m.guid, marketId);
          seenOwn.add(m.guid);
          return;
        }
        seenOwn.add(m.guid);
        await onGroupText(await spaceFor(m.chatId), OWNER, text, m.guid, m.ts).catch((err) => console.error("[own]", err));
      },
      async (t) => {
        if (seenTapbacks.has(t.guid)) return;
        const side = TAPBACK_SIDES[t.kind];
        if (!side || t.removed) return void seenTapbacks.add(t.guid); // other tapbacks are just tapbacks
        // The bot message it targets may not be linked yet (same poll); retry next time.
        const market = marketForMessage(t.target);
        if (!market) return;
        seenTapbacks.add(t.guid);
        if (market.space_id !== t.chatId) return;
        const space = await spaceFor(t.chatId);
        const reply = await handleCommand({ spaceId: t.chatId, userId: t.sender, text: `!${side} ${market.id} ${TAPBACK_CENTS / 100}` });
        if (reply) await sendTo(space, reply).catch((err) => console.error("[tapback]", err));
        if (reply?.betOn) scheduleChart(reply.betOn, deliver);
      },
    )
    .catch((err) => console.warn("[local] can't watch chat.db", err));
}

for await (const [space, message] of app.messages) {
  if (discover) {
    const name = await space.getDisplayName().catch(() => undefined);
    const preview = message.content.type === "text" ? message.content.text.slice(0, 40) : message.content.type;
    console.log(`[discover] chat=${space.id} name=${name ?? "-"} from=${message.sender?.id ?? "me"} "${preview}"`);
    continue;
  }
  if (message.content.type !== "text") continue;
  if (message.sender?.kind === "agent") continue; // our own replies

  // The local stream sometimes hands over a message before its sender is
  // linked. Look it up in the Messages database rather than guess.
  const userId = message.sender?.id || (await lookupSender(message.id).catch(() => undefined));
  if (!userId) {
    console.warn(`[loop] message ${message.id} in ${space.id} with no sender, skipped`);
    continue;
  }

  const isDm = isDmSpace(space.id);
  if (isDm ? !isKnownUser(userId) : allowed.size > 0 && !allowed.has(space.id)) continue;

  const text = plainText(message.content.text);
  if (isDm) {
    if (!isCommand(text)) continue;
    const reply = await handleCommand({ spaceId: space.id, userId, text, isDm: true });
    if (reply) await sendTo(space, reply).catch((err) => console.error("[dm loop]", err));
    continue;
  }

  const ts = message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now();
  await onGroupText(space, userId, text, message.id.split(":")[0]!, ts);
}
