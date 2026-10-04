// Move everything the bot knows about a chat from one chat id to another:
// markets, wallets, names, history, dossier, profiles, IOUs. Needed when the
// bot moves to its own Apple ID, which sees each group under a new id.
//
//   npm run remap -- "<old chat id>" "<new chat id>"
import { db } from "../src/db.ts";
import "../src/history.ts"; // make sure history/profile tables exist

const [from, to] = process.argv.slice(2);
if (!from || !to || from === to) {
  console.error('Usage: npm run remap -- "<old chat id>" "<new chat id>"');
  process.exit(1);
}

const tables = ["markets", "users", "wallets", "debts", "history", "scanned_chats", "chat_profiles"];
db.exec("BEGIN");
try {
  for (const t of tables) {
    // OR REPLACE: if the new id already has a row with the same key (e.g. the
    // bot already saw a message there), keep the remapped, richer one.
    const { changes } = db.prepare(`UPDATE OR REPLACE ${t} SET space_id = ? WHERE space_id = ?`).run(to, from);
    console.log(`${t.padEnd(14)} ${changes}`);
  }
  db.exec("COMMIT");
  console.log(`Moved ${from} → ${to}. Update ALLOWED_CHATS in .env too.`);
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
