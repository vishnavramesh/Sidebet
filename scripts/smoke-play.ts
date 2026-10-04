// Play-money mode: coin wallets, settlement moves coins, nothing is owed.
import assert from "node:assert/strict";
import { plainText } from "../src/voice.ts";
import { handleCommand } from "../src/commands.ts";
import { startCloser } from "../src/closer.ts";
import { db } from "../src/db.ts";
import { balance, openDebtsFor } from "../src/markets.ts";

const space = "smoke-play";
const [A, B, C] = ["+15552220001", "+15552220002", "+15552220003"];
const say = async (u: string, t: string) => {
  const r = await handleCommand({ spaceId: space, userId: u, text: t });
  console.log(`> ${u.slice(-4)}: ${t}\n${r?.text}\n`);
  return plainText(r?.text ?? "");
};

assert.match(await say(A, "!bal"), /1,000 coins/);
await say(A, "!new Will it snow?");
await say(A, "!yes 1 200");
await say(B, "!no 1 300");
await say(C, "!yes 1 100");
assert.match(await say(B, "!no 1 99999"), /only have 700 coins/);
assert.equal(balance(space, B), 70000);
assert.match(await say(A, "!resolve 1 yes"), /RESOLVED YES/);
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

// The look: flags, the odds bar, reactions, and a nudge when one side is empty.
await say(A, "!new Will Jake be late?"); // #4
await say(A, "!new Will Sam cook?"); // #5, now the newest
const first = await say(A, "!yes 5 50");
assert.match(first, /^\.\.\.0001 · YES 50 · first in\n━+\nWill Sam cook\?\n#5 · 50 pot · 1 in\n\nYES \d+%/);
assert.match(first, /\n[▰▱]{10}  \d+% chance\n/);
assert.match(first, /\n50 on NO → 100 back\n   \(no one's on NO yet\)/);
assert.match(first, /\n!yes 5 50   !no 5 50$/);
const no = await say(B, "!no 5 100");
assert.match(no, /^\.\.\.0002 · NO 100/);
assert.match(no, /since open/);
assert.doesNotMatch(no, /no one's on/);
// "!yes 4" with #4 open but not newest: ask instead of guessing.
const ask = await say(C, "!yes 4");
assert.match(ask, /#4 or 4 coins\?/);
assert.match(ask, /!yes 5 4 → 4 coins on #5 \(newest\)/);
// Bare "!yes" bets the default on the newest market.
assert.match(await say(C, "!yes"), /^\.\.\.0003 · YES 100/);
// Big bets get called out.
assert.match(await say(B, "!no 5 all"), /· .* all in/);
// Commands with missing pieces say exactly what to type.
assert.match(await say(A, "!resolve"), /!resolve 5 yes · !resolve 5 no/);
assert.match(await say(A, "!resolve 5"), /How did #5 go\? !resolve 5 yes or !resolve 5 no/);
assert.match(await say(A, "!close"), /Which market\? e\.g\. !close 5/);
assert.match(await say(B, "!resolve 5 no"), /Only .* can do that on #5/);

// The 5am mistake: "!close yes" settles the creator's newest market instead of erroring.
await say(C, "!new Solo bet?"); // #6, only C bets
await say(C, "!yes 6 50");
const solo = await say(C, "!close yes");
assert.match(solo, /RESOLVED YES/);
assert.match(solo, /Only .*0003 bet, so there was nobody to win from/);
assert.match(solo, /got 50 back/);
// Lock shows what each outcome means; settling shows results, transfers, balances.
const D = "+15552220004";
await say(A, "!new Will Ajay learn to swim?"); // #7
await say(A, "!yes 7 30");
await say(D, "!no 7 20");
await say(C, "!no 7 10");
const locked = await say(A, "!close 7");
assert.match(locked, /🔒 #7 locked/);
assert.match(locked, /If YES\n💰 .*0001  \+30  \(30 → 60\)/);
assert.match(locked, /If NO\n💰 .*0004  \+20  \(20 → 40\)/);
const done = await say(A, "!resolve yes 7");
assert.match(done, /Results\n💰 .*0001  \+30  \(30 → 60\) · now [\d,]+\n💸 .*0003  −10 · now [\d,]+\n💸 .*0004  −20 · now 980/);
assert.match(done, /Who paid who\n.*0004 → .*0001  20\n.*0003 → .*0001  10/);

console.log("✅ play-money smoke test passed");
