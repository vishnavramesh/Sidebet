import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { attachment, type Message, Spectrum, type Space } from "spectrum-ts";
import { lookupSender } from "./chatdb.ts";
import { handleCommand, isCommand, type Reply, suggestions } from "./commands.ts";
import { detectionEnabled, observe } from "./detect.ts";
import { sources } from "./external/index.ts";
import { recordMessage } from "./history.ts";
import { scheduleChart } from "./live.ts";
import { keepCacheWarm } from "./oracle.ts";
import { isKnownUser } from "./markets.ts";
import { startNagger } from "./nagger.ts";
import { startCloser } from "./closer.ts";
import { startResolver } from "./resolver.ts";
import { startWeb } from "./web.ts";
import { bold, botVoice, plainText } from "./voice.ts";

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
type App = {
  messages: AsyncIterable<[Space, Message]>;
  openDm: (userId: string) => Promise<Space | undefined>;
  /** Local mode only: the owner's own messages in these chats. */
  watchLocal?: (chatIds: string[], onOwn: (m: OwnMessage) => void) => Promise<void>;
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
    // what it drops: the owner's own messages (when texting as the owner). Polling
    // (not imessage-kit's watcher) because a row often lands before its text or
    // sender does, and the watcher looks at each row only once. The callers
    // de-duplicate by message id and skip rows that aren't complete yet.
    watchLocal: async (chatIds, onOwn) => {
      const { IMessageSDK } = await import("@photon-ai/imessage-kit");
      const sdk = new IMessageSDK();
      const since = new Date();
      const poll = async () => {
        for (const chatId of chatIds) {
          const rows = await sdk.getMessages({ chatId, since, limit: 40 }).catch(() => []);
          for (const m of rows) {
            if (!m.reaction && m.isFromMe && m.text) {
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
  // (reassigned below when DMing the owner from a dedicated bot account)
  if (userId === OWNER) {
    // Texting as the owner, the bot can't DM them; as its own account it can.
    if (!DEDICATED || !ownerHandles[0]) return console.log(`[dm → owner, skipped] ${text}`);
    userId = (process.env.OWNER_HANDLES ?? "").split(",")[0]!.trim().replace(/^tel:/, "");
  }
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

async function sendTo(space: Space, reply: Reply) {
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

// BOT_ACCOUNT=dedicated: this Mac user's Messages is signed into the bot's own
// Apple ID. Then "from me" means the bot itself, and the owner is a normal
// member whose phone/email (OWNER_HANDLES) map back to "me", so their wallet,
// profiles and history carry over from when the bot texted as them.
const DEDICATED = process.env.BOT_ACCOUNT === "dedicated";
const normHandle = (h: string) => {
  const s = h.trim().replace(/^tel:/, "").toLowerCase();
  return s.includes("@") ? s : s.replace(/\D/g, "").slice(-10);
};
const ownerHandles = (process.env.OWNER_HANDLES ?? "").split(",").map(normHandle).filter(Boolean);
const asUser = (handle: string) => (ownerHandles.includes(normHandle(handle)) ? OWNER : handle);

// LOG_UNKNOWN_CHATS=on: note (once) every chat that isn't allowed yet, by id and
// name only, so a new bot account's chat ids can be found without --discover.
const loggedChats = new Set<string>();
async function noteUnknownChat(space: Space) {
  if (process.env.LOG_UNKNOWN_CHATS !== "on" || loggedChats.has(space.id)) return;
  loggedChats.add(space.id);
  const name = await space.getDisplayName().catch(() => undefined);
  console.log(`[chat] not allowed yet: ${space.id} name=${JSON.stringify(name ?? "")}`);
}

// RESTART_FILE: touching this file makes the bot exit cleanly; launchd (or
// whatever started it) brings it back up with the new .env and code.
if (process.env.RESTART_FILE) {
  setInterval(() => {
    if (existsSync(process.env.RESTART_FILE!)) {
      unlinkSync(process.env.RESTART_FILE!);
      console.log("[restart] requested");
      process.exit(0);
    }
  }, 2000).unref();
}

if (!discover) {
  // Load the scanned history into Claude's cache now, so the first market is fast.
  const firstChat = [...allowed][0];
  if (firstChat) keepCacheWarm(firstChat);
  startResolver(deliver);
  startCloser(deliver);
  startWeb();
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
    // Texting as the owner, the owner's chatter is mixed up with the bot's own; skip it.
    if (userId === OWNER && !DEDICATED) return;

    const seen = await observe(space.id, userId, text);
    if (seen?.reaction) await sendTo(space, seen.reaction);
    const hit = seen?.suggestion;
    if (!hit) return;

    let line = "";
    if (hit.search_query) {
      const [top] = await sources[0]!.search(hit.search_query, 1).catch(() => []);
      if (top && !top.resolved) {
        line = `\n\n📡 Kalshi has it at ${Math.round((top.yesPrice ?? 0) * 100)}%\n!mirror ${top.ref}`;
      }
    }
    suggestions.set(space.id, { question: hit.question });
    const suggestion = `👀 Sounds like a bet\n━━━━━━━━━━━━━━\n${bold(hit.question)}\n\nReply !new to open it.${line}`;
    await send(space, suggestion);
  } catch (err) {
    console.error("[loop]", err);
  }
}

// The owner's own messages, handled like anyone's. Only needed when texting as
// the owner: on a dedicated bot account, "from me" is just the bot.
const seenOwn = new Set<string>();

if (!discover && !DEDICATED && app.watchLocal && app.getSpace) {
  const spaceFor = async (id: string) => spaces.get(id) ?? (await app.getSpace!(id));
  void app
    .watchLocal(
      [...allowed],
      async (m) => {
        if (seenOwn.has(m.guid) || isDmSpace(m.chatId)) return; // polled again every few seconds
        if (allowed.size > 0 && !allowed.has(m.chatId)) return;
        const text = m.text.trim();
        // An attachment row (the bot's chart) is just a placeholder character: not something anyone said.
        if (!text.replace(/\uFFFC/g, "").trim()) return void seenOwn.add(m.guid);
        seenOwn.add(m.guid);
        if (sentByBot.has(text)) return; // our own reply landing in chat.db
        await onGroupText(await spaceFor(m.chatId), OWNER, text, m.guid, m.ts).catch((err) => console.error("[own]", err));
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
  const rawUser = message.sender?.id || (await lookupSender(message.id).catch(() => undefined));
  const userId = rawUser && asUser(rawUser);
  if (!userId) {
    console.warn(`[loop] message ${message.id} in ${space.id} with no sender, skipped`);
    continue;
  }

  const isDm = isDmSpace(space.id);
  if (!isDm && allowed.size > 0 && !allowed.has(space.id)) {
    await noteUnknownChat(space);
    continue;
  }
  if (isDm && !isKnownUser(userId)) continue;

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
