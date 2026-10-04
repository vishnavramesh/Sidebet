import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type HistoryRow, readChatHistory } from "./chatdb.ts";
import { db } from "./db.ts";

// A local copy of group chat history, so the bot can set starting odds from
// what the group actually says. Filled once by `npm run scan` and then kept
// up to date by the live loop.

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    guid TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_space_ts ON history (space_id, ts);
  CREATE TABLE IF NOT EXISTS scanned_chats (
    space_id TEXT PRIMARY KEY,
    name TEXT,
    lore TEXT,
    scanned_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contacts (
    handle TEXT PRIMARY KEY, -- digits-only phone tail or lowercased email
    name TEXT NOT NULL
  );
`);

const insert = db.prepare("INSERT OR IGNORE INTO history (guid, space_id, sender, text, ts) VALUES (?, ?, ?, ?, ?)");

export function recordMessage(spaceId: string, row: HistoryRow) {
  insert.run(row.guid, spaceId, row.sender, row.text, row.ts);
}

/**
 * Pull a chat's full history from this Mac user's Messages into the local
 * table, filed under `spaceId`. `sourceId` is the chat's id in this user's
 * Messages when it differs, e.g. scanning from the owner's account for a bot
 * account that sees the same group under another id.
 */
export async function importChat(spaceId: string, name: string | null, onPage?: (n: number) => void, sourceId = spaceId) {
  const rows = await readChatHistory(sourceId, onPage);
  db.exec("BEGIN");
  for (const r of rows) recordMessage(spaceId, r);
  db.exec("COMMIT");
  db.prepare(
    "INSERT INTO scanned_chats (space_id, name, scanned_at) VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET name = excluded.name, scanned_at = excluded.scanned_at",
  ).run(spaceId, name, Date.now());
  return rows;
}

// The dossier Claude writes from a full read of the chat at scan time. Markets
// read this (a few thousand tokens) instead of the raw history (~85K).
if (!(db.prepare("PRAGMA table_info(scanned_chats)").all() as { name: string }[]).some((c) => c.name === "digest")) {
  db.exec("ALTER TABLE scanned_chats ADD COLUMN digest TEXT");
}

export function setDigest(spaceId: string, digest: string) {
  db.prepare("UPDATE scanned_chats SET digest = ? WHERE space_id = ?").run(digest, spaceId);
}

export function setLore(spaceId: string, lore: string) {
  db.prepare("UPDATE scanned_chats SET lore = ? WHERE space_id = ?").run(lore, spaceId);
}

export function scannedChats() {
  return db.prepare("SELECT space_id, name, lore FROM scanned_chats ORDER BY scanned_at").all() as {
    space_id: string;
    name: string | null;
    lore: string | null;
  }[];
}

export const isScanned = (spaceId: string) => !!db.prepare("SELECT 1 FROM scanned_chats WHERE space_id = ?").get(spaceId);

// ---------- names ----------

const handleKey = (h: string) => (h.includes("@") ? h.toLowerCase() : h.replace(/\D/g, "").slice(-10));

/** Copy phone/email → name from the macOS Contacts database. */
export function importContacts(): number {
  const base = join(homedir(), "Library/Application Support/AddressBook/Sources");
  let n = 0;
  const up = db.prepare("INSERT OR REPLACE INTO contacts (handle, name) VALUES (?, ?)");
  for (const dir of readdirSync(base)) {
    let ab: DatabaseSync;
    try {
      ab = new DatabaseSync(join(base, dir, "AddressBook-v22.abcddb"), { readOnly: true });
    } catch {
      continue;
    }
    const name = "TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,''))";
    const phones = ab.prepare(`SELECT p.ZFULLNUMBER AS h, ${name} AS n FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`).all();
    const emails = ab.prepare(`SELECT e.ZADDRESS AS h, ${name} AS n FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`).all();
    for (const { h, n: nm } of [...phones, ...emails] as { h: string | null; n: string }[]) {
      if (h && nm) {
        up.run(handleKey(h), nm);
        n++;
      }
    }
    ab.close();
  }
  return n;
}

export function contactName(handle: string): string | undefined {
  if (handle === "me") return process.env.OWNER_NAME || "me (the bot's owner)";
  const row = db.prepare("SELECT name FROM contacts WHERE handle = ?").get(handleKey(handle)) as { name: string } | undefined;
  return row?.name;
}

const who = (handle: string) => contactName(handle) ?? `…${handle.replace(/\D/g, "").slice(-4) || handle}`;

// ---------- transcripts for Claude ----------

/**
 * Chat history as plain text, newest last, capped to roughly `maxChars`
 * (keeping the most recent messages). One block per scanned chat.
 */
export function transcript(maxChars = 600_000, before = lastScanAt(), only?: string): string {
  const chats = scannedChats().filter((c) => !only || c.space_id === only);
  if (!chats.length) return "";
  const budget = Math.floor(maxChars / chats.length);
  return chats
    .map((c) => {
      const rows = db.prepare("SELECT sender, text, ts FROM history WHERE space_id = ? AND ts < ? ORDER BY ts DESC").all(c.space_id, before) as {
        sender: string;
        text: string;
        ts: number;
      }[];
      // Newest first until the budget runs out, then flip to oldest first.
      // One date header per day instead of a timestamp per line: timestamps
      // were more than half the tokens.
      const kept: typeof rows = [];
      let used = 0;
      for (const r of rows) {
        const len = who(r.sender).length + r.text.length + 3;
        if (used + len > budget) break;
        kept.push(r);
        used += len;
      }
      const lines: string[] = [];
      let day = "";
      for (const r of kept.reverse()) {
        const d = new Date(r.ts).toDateString();
        if (d !== day) lines.push(`-- ${(day = d)} --`);
        lines.push(`${who(r.sender)}: ${r.text}`);
      }
      const head = `=== Group chat "${c.name ?? c.space_id}" (${rows.length} messages${kept.length < rows.length ? `, most recent ${kept.length} shown` : ""}) ===`;
      const lore = c.lore ? `\nWhat we already learned about this group:\n${c.lore}\n` : "";
      return `${head}${lore}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Messages that arrived after the last scan. Kept out of `transcript()` so the
 * big scanned block stays byte-identical and Claude can serve it from cache.
 */
export function recentTail(spaceId: string, since = lastScanAt(), limit = 400): string {
  const rows = db
    .prepare("SELECT sender, text, ts FROM history WHERE space_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?")
    .all(spaceId, since, limit) as { sender: string; text: string; ts: number }[];
  return rows
    .reverse()
    .map((r) => `[${localStamp(r.ts)}] ${who(r.sender)}: ${r.text}`)
    .join("\n");
}

/** "Sun Oct 4, 4:49 AM" in this Mac's time zone (not UTC), so Claude reads times the way the chat lives them. */
export const localStamp = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function lastScanAt(): number {
  const row = db.prepare("SELECT MAX(scanned_at) AS t FROM scanned_chats").get() as { t: number | null };
  return row.t ?? Date.now();
}


// ---------- personality profiles ----------
// One cached profile per person PER CHAT, built only from that chat. The same
// person in two group chats has two separate profiles, and nothing one chat
// says about someone is ever shown or used in another. Rebuilt only once they
// have sent PROFILE_REFRESH more messages in that chat.

db.exec(`
  DROP TABLE IF EXISTS person_profiles; -- old cross-chat profiles; they mixed chats
  CREATE TABLE IF NOT EXISTS chat_profiles (
    space_id TEXT NOT NULL,
    handle TEXT NOT NULL,    -- phone/email, or "me" for the Mac's owner
    name TEXT NOT NULL,
    data TEXT NOT NULL,      -- JSON, see PersonProfile in oracle.ts
    msg_count INTEGER NOT NULL,
    built_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, handle)
  );
`);

export const PROFILE_REFRESH = Number(process.env.PROFILE_REFRESH ?? 100);
export const PROFILE_MIN_MESSAGES = Number(process.env.PROFILE_MIN_MESSAGES ?? 10);

/** Everyone who has talked in this chat, with how many messages they sent here. */
export function chatPeople(spaceId: string, minMessages = PROFILE_MIN_MESSAGES) {
  return db
    .prepare(
      `SELECT sender AS handle, COUNT(*) AS n FROM history
       WHERE space_id = ? AND sender != 'unknown'
       GROUP BY sender HAVING n >= ? ORDER BY n DESC`,
    )
    .all(spaceId, minMessages) as { handle: string; n: number }[];
}

export const personName = (handle: string) => who(handle);

/** What a profile is built from: their messages in this chat, and what this chat says about them. */
export function personEvidence(spaceId: string, handle: string, maxOwn = 900, maxMentions = 250): string {
  const name = who(handle).split(" ")[0]!;
  const fmt = (r: { sender: string; text: string; ts: number }) => `[${new Date(r.ts).toDateString().slice(4, 10)}] ${who(r.sender)}: ${r.text}`;
  const own = (
    db
      .prepare("SELECT sender, text, ts FROM history WHERE space_id = ? AND sender = ? ORDER BY ts DESC LIMIT ?")
      .all(spaceId, handle, maxOwn) as { sender: string; text: string; ts: number }[]
  ).reverse();
  const mentions =
    name.length >= 3
      ? (
          db
            .prepare("SELECT sender, text, ts FROM history WHERE space_id = ? AND sender != ? AND text LIKE ? ORDER BY ts DESC LIMIT ?")
            .all(spaceId, handle, `%${name}%`, maxMentions) as { sender: string; text: string; ts: number }[]
        ).reverse()
      : [];
  return `MESSAGES ${who(handle)} SENT IN THIS CHAT:\n${own.map(fmt).join("\n")}\n\nWHAT OTHERS IN THIS CHAT SAID ABOUT ${name.toUpperCase()}:\n${mentions.map(fmt).join("\n") || "(nothing)"}`;
}

export function saveProfile(spaceId: string, handle: string, name: string, data: unknown, msgCount: number) {
  db.prepare(
    `INSERT INTO chat_profiles (space_id, handle, name, data, msg_count, built_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_id, handle) DO UPDATE SET name = excluded.name, data = excluded.data, msg_count = excluded.msg_count, built_at = excluded.built_at`,
  ).run(spaceId, handle, name, JSON.stringify(data), msgCount, Date.now());
}

/** This chat's profiles only. */
export function storedProfiles(spaceId: string) {
  return db
    .prepare("SELECT handle, name, data, msg_count FROM chat_profiles WHERE space_id = ? ORDER BY msg_count DESC")
    .all(spaceId) as { handle: string; name: string; data: string; msg_count: number }[];
}

/** People in this chat whose profile is missing or has PROFILE_REFRESH+ new messages. */
export function staleProfiles(spaceId: string) {
  const built = new Map(storedProfiles(spaceId).map((p) => [p.handle, p.msg_count]));
  return chatPeople(spaceId).filter((p) => !built.has(p.handle) || p.n - built.get(p.handle)! >= PROFILE_REFRESH);
}

/** A profile in this chat by a name someone typed ("nishant", "Paul Lee", "me"). */
export function findProfile(spaceId: string, query: string) {
  const q = query.trim().toLowerCase();
  return storedProfiles(spaceId).find((p) => {
    const n = p.name.toLowerCase();
    return n === q || n.split(" ")[0] === q || (q.length >= 3 && n.includes(q));
  });
}

/** One chat's dossier, or its raw transcript if it has no dossier yet. Never another chat's. */
export function chatDigest(spaceId: string): string {
  const c = db.prepare("SELECT space_id, name, digest FROM scanned_chats WHERE space_id = ?").get(spaceId) as
    | { space_id: string; name: string | null; digest: string | null }
    | undefined;
  if (!c) return "";
  return c.digest
    ? `=== Dossier: this group chat "${c.name ?? c.space_id}" (from a full read of its history) ===\n${c.digest}`
    : transcript(200_000, undefined, c.space_id);
}
