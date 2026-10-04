// Read a group chat's full history into the bot's database before the bot
// goes live there. Starting odds for new markets are based on it.
//
//   npm run scan -- "iMessage;+;chat908484642365582787" ["<another chat id>" ...]
//
// Find chat ids with `npm run discover`. With ANTHROPIC_API_KEY set, Claude
// also reads each chat once and writes a short summary of the group.
import { chatName } from "../src/chatdb.ts";
import { contactName, importChat, importContacts, setLore, transcript } from "../src/history.ts";
import { buildLore, oracleEnabled } from "../src/oracle.ts";

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length) {
  console.error('Usage: npm run scan -- "iMessage;+;chat123..." [more chat ids]');
  process.exit(1);
}

console.log(`Contacts: ${importContacts()} phone numbers and emails loaded for names.`);

for (const id of ids) {
  const name = chatName(id);
  process.stdout.write(`\nScanning ${name ?? id} … `);
  const rows = await importChat(id, name, (n) => process.stdout.write(`\rScanning ${name ?? id} … ${n} messages`));
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

  if (oracleEnabled && !process.argv.includes("--no-lore")) {
    process.stdout.write("  Claude is reading the whole chat … ");
    const lore = await buildLore(name ?? id, transcript(600_000, Date.now() + 1, id));
    if (lore) {
      setLore(id, lore);
      console.log(`done.\n\n${lore.replace(/^/gm, "  ")}`);
    } else console.log("skipped (see warning above).");
  }
}

if (!oracleEnabled) {
  console.log("\nNo ANTHROPIC_API_KEY in .env, so no summary and new markets open at 50%. Add a key and re-run to fix both.");
}
