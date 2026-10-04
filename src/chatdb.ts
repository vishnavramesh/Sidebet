import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IMessageSDK } from "@photon-ai/imessage-kit";

// Direct, read-only access to this Mac's Messages database, for the two things
// the Spectrum stream doesn't give us: a reliable sender, and chat history.

const CHAT_DB = join(homedir(), "Library/Messages/chat.db");
let raw: DatabaseSync | undefined;
const chatDb = () => (raw ??= new DatabaseSync(CHAT_DB, { readOnly: true }));

/**
 * Who sent a message, by its Spectrum id ("<guid>" or "<guid>:text:0").
 * The live stream sometimes reports no sender for a message whose row is
 * still being written, so retry briefly before giving up.
 */
export async function lookupSender(messageId: string): Promise<string | undefined> {
  const guid = messageId.split(":")[0]!;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = chatDb()
      .prepare("SELECT h.id AS sender FROM message m JOIN handle h ON h.ROWID = m.handle_id WHERE m.guid = ?")
      .get(guid) as { sender: string } | undefined;
    if (row?.sender) return row.sender;
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
}

export interface HistoryRow {
  guid: string;
  sender: string; // phone/email, or "me" for the Mac owner's own messages
  text: string;
  ts: number;
}

/** Every text message in a chat, oldest first, decoded by imessage-kit. */
export async function readChatHistory(chatId: string, onPage?: (n: number) => void): Promise<HistoryRow[]> {
  const sdk = new IMessageSDK();
  const out: HistoryRow[] = [];
  try {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const page = await sdk.getMessages({ chatId, excludeReactions: true, limit: PAGE, offset });
      for (const m of page) {
        const text = m.text?.replace(/￼/g, "").trim();
        if (!text) continue;
        out.push({ guid: m.id, sender: m.isFromMe ? "me" : (m.participant ?? "unknown"), text, ts: m.createdAt.getTime() });
      }
      onPage?.(out.length);
      if (page.length < PAGE) break;
    }
  } finally {
    await sdk.close();
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** A group chat's display name, if it has one. */
export function chatName(chatId: string): string | null {
  const row = chatDb().prepare("SELECT display_name AS n FROM chat WHERE guid = ?").get(chatId) as { n: string | null } | undefined;
  return row?.n || null;
}
