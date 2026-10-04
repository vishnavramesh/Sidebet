// Read a group chat's full history into the bot's database before the bot
// goes live there. Starting odds for new markets are based on it.
//
//   npm run scan -- "iMessage;+;chat908484642365582787" ["<another chat id>" ...]
//   npm run scan -- "Walnut" --as "iMessage;+;chat688376712438141541"
//
// A chat can be given by id or by its group name. --as files the history under
// a different chat id: run the scan from the account that has the history
// (yours) and point it at the bot account's id for the same group.
//
// Find chat ids with `npm run discover`. With ANTHROPIC_API_KEY set, Claude
// also reads each chat once and writes the dossier that markets use for odds
// (--no-ai to skip). Re-run it every week or so to fold in new messages.
import { chatName, findChatsByName } from "../src/chatdb.ts";
import {
  contactName,
  importChat,
  importContacts,
  personEvidence,
  personName,
  saveProfile,
  chatPeople,
  scannedChats,
  setDigest,
  staleProfiles,
  storedProfiles,
  transcript,
} from "../src/history.ts";
import { buildDigest, buildProfile, oracleEnabled } from "../src/oracle.ts";

const argv = process.argv.slice(2);
const asIdx = argv.indexOf("--as");
const target = asIdx >= 0 ? argv[asIdx + 1] : undefined;
if (asIdx >= 0 && !target) {
  console.error('--as needs the bot account\'s chat id, e.g. --as "iMessage;+;chat688376712438141541"');
  process.exit(1);
}
const args = argv.filter((a, i) => !a.startsWith("--") && (asIdx < 0 || i !== asIdx + 1));
// Group names → this account's chat ids.
const ids = args.map((a) => {
  if (/^(iMessage|SMS|RCS|any);/.test(a)) return a;
  const found = findChatsByName(a);
  if (found.length === 1) return found[0]!.guid;
  console.error(found.length ? `More than one group is named "${a}": ${found.map((f) => f.guid).join(", ")}. Use the id.` : `No group chat named "${a}" on this account.`);
  process.exit(1);
});
if (target && ids.length !== 1) {
  console.error("--as works with exactly one chat.");
  process.exit(1);
}
if (!ids.length && !process.argv.includes("--profiles")) {
  console.error('Usage: npm run scan -- "iMessage;+;chat123..." [more chat ids]   (or --profiles to only refresh profiles)');
  process.exit(1);
}

console.log(`Contacts: ${importContacts()} phone numbers and emails loaded for names.`);

for (const source of ids) {
  const id = target ?? source; // where the bot will find it
  const name = chatName(source);
  process.stdout.write(`\nScanning ${name ?? source}${target ? ` (as ${target})` : ""} … `);
  const rows = await importChat(id, name, (n) => process.stdout.write(`\rScanning ${name ?? source} … ${n} messages`), source);
  if (!rows.length) {
    console.log("no messages found. Check the chat id with `npm run discover`.");
    continue;
  }
  const people = new Map<string, number>();
  for (const r of rows) people.set(r.sender, (people.get(r.sender) ?? 0) + 1);
  console.log(`\n  ${rows.length} messages, ${new Date(rows[0]!.ts).toDateString()} → ${new Date(rows.at(-1)!.ts).toDateString()}`);
  for (const [who, n] of [...people].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(contactName(who) ?? who).padEnd(28)} ${n}`);
  }

  if (oracleEnabled && !process.argv.includes("--no-ai")) {
    // One full read: the dossier every market uses afterwards instead of the raw chat.
    process.stdout.write("  Claude is reading the whole chat to write the dossier … ");
    const digest = await buildDigest(name ?? id, transcript(600_000, Date.now() + 1, id));
    if (digest) {
      setDigest(id, digest);
      console.log(`done (${digest.split(/\s+/).length} words).\n\n${digest.split("\n").slice(0, 14).join("\n").replace(/^/gm, "  ")}\n  …`);
    } else console.log("skipped (see warning above).");
  }
}

// Personality profiles: one per person PER CHAT, built only from that chat.
// Cached, and only rebuilt once someone has sent PROFILE_REFRESH new messages
// there. With --profiles and no chat ids, refreshes every scanned chat.
if (oracleEnabled && !process.argv.includes("--no-ai")) {
  const chats = target ? [target] : ids.length ? ids : scannedChats().map((c) => c.space_id);
  for (const chatId of chats) {
    const todo = process.argv.includes("--refresh-profiles") ? chatPeople(chatId) : staleProfiles(chatId);
    const label = scannedChats().find((c) => c.space_id === chatId)?.name ?? chatId;
    console.log(`\nProfiles in ${label}: ${todo.length} to build (${storedProfiles(chatId).length} cached).`);
    for (const p of todo) {
      const name = personName(p.handle);
      process.stdout.write(`  ${name.padEnd(28)} `);
      const profile = await buildProfile(name, personEvidence(chatId, p.handle));
      if (profile) {
        saveProfile(chatId, p.handle, name, profile, p.n);
        console.log(profile.vibe);
      } else console.log("skipped (see warning above)");
    }
  }
}

if (!oracleEnabled) {
  console.log("\nNo ANTHROPIC_API_KEY in .env, so no dossier and new markets open at 50%. Add a key and re-run to fix both.");
}
