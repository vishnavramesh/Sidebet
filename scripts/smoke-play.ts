// Play-money mode: coin wallets, settlement moves coins, nothing is owed.
import assert from "node:assert/strict";
import { handleCommand } from "../src/commands.ts";
import { startCloser } from "../src/closer.ts";
import { db } from "../src/db.ts";
import { balance, openDebtsFor } from "../src/markets.ts";

const space = "smoke-play";
const [A, B, C] = ["+15552220001", "+15552220002", "+15552220003"];
const say = async (u: string, t: string) => {
  const r = await handleCommand({ spaceId: space, userId: u, text: t });
  console.log(`> ${u.slice(-4)}: ${t}\n${r?.text}\n`);
  return r?.text ?? "";
};

assert.match(await say(A, "!bal"), /1,000 coins/);
await say(A, "!new Will it snow?");
await say(A, "!yes 1 200");
await say(B, "!no 1 300");
await say(C, "!yes 1 100");
assert.match(await say(B, "!no 1 99999"), /only have 700 coins/);
assert.equal(balance(space, B), 70000);
assert.match(await say(A, "!resolve 1 yes"), /resolved YES/);
// Pot 600, YES pool 300: A (200) gets 400, C (100) gets 200, B loses 300.
assert.equal(balance(space, A), 120000);
assert.equal(balance(space, C), 110000);
assert.equal(balance(space, B), 70000);
assert.equal(openDebtsFor(B).length, 0);
assert.match(await say(B, "!owe"), /nothing is owed/);
assert.match(await say(B, "!daily"), /\+100 coins/);
assert.match(await say(B, "!daily"), /already claimed/);
await say(C, "!new Rain Friday?");
await say(B, "!no 2 all");
assert.equal(balance(space, B), 0);
await say(C, "!cancel 2");
assert.equal(balance(space, B), 80000);
assert.match(await say(A, "!lb"), /1\. .*1,200 coins/);
// Close times: "| 2h" on !new, !closes, then the closer's last call, lock and reminder.
assert.match(await say(A, "!new Pizza tonight? | 2h"), /closes in 2h/);
assert.match(await say(A, "!closes 3 garbage"), /Usage: !closes/);
assert.match(await say(A, "!closes 3 30m"), /closes in 30 min/);
const posted: string[] = [];
const fake = async (_s: string, r: { text: string }) => void posted.push(r.text);
db.exec("UPDATE markets SET closes_at = " + (Date.now() + 5 * 60_000) + " WHERE id = 3");
let stop = startCloser(fake, 1e9);
await new Promise((r) => setTimeout(r, 50));
stop();
assert.ok(posted.some((t) => /Last call: #3 closes in 5 min/.test(t)), "last call");
db.exec("UPDATE markets SET closes_at = " + (Date.now() - 1000) + " WHERE id = 3");
stop = startCloser(fake, 1e9);
await new Promise((r) => setTimeout(r, 50));
stop();
assert.ok(posted.some((t) => /#3 is closed/.test(t)), "locked");
assert.match(await say(B, "!yes 3 10"), /#3 is closed/);
db.exec("UPDATE markets SET reminded_at = 0 WHERE id = 3");
stop = startCloser(fake, 1e9);
await new Promise((r) => setTimeout(r, 50));
stop();
assert.ok(posted.some((t) => /#3 is closed but not resolved/.test(t)), "resolve reminder");
console.log(posted.join("\n---\n"));

console.log("✅ play-money smoke test passed");
