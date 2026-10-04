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

/** Pull a chat's full history from Messages into the local table. */
export async function importChat(spaceId: string, name: string | null, onPage?: (n: number) => void) {
  const rows = await readChatHistory(spaceId, onPage);
  db.exec("BEGIN");
  for (const r of rows) recordMessage(spaceId, r);
  db.exec("COMMIT");
  db.prepare(
    "INSERT INTO scanned_chats (space_id, name, scanned_at) VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET name = excluded.name, scanned_at = excluded.scanned_at",
  ).run(spaceId, name, Date.now());
  return rows;
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
export function recentTail(spaceId: string, since = lastScanAt(), limit = 200): string {
  const rows = db
    .prepare("SELECT sender, text, ts FROM history WHERE space_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?")
    .all(spaceId, since, limit) as { sender: string; text: string; ts: number }[];
  return rows
    .reverse()
    .map((r) => `[${new Date(r.ts).toISOString().slice(0, 16).replace("T", " ")}] ${who(r.sender)}: ${r.text}`)
    .join("\n");
}

function lastScanAt(): number {
  const row = db.prepare("SELECT MAX(scanned_at) AS t FROM scanned_chats").get() as { t: number | null };
  return row.t ?? Date.now();
}

