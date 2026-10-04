// End-to-end check of the command layer without iMessage. Run: npm run smoke
// Set SMOKE_OUT=<dir> to also save the chart images it renders.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCommand, type Reply } from "../src/commands.ts";
import { db } from "../src/db.ts";
import { leaderboard, openDebtsFor } from "../src/markets.ts";

const space = "smoke-chat";
const VISH = "+15551110001";
const SAM = "+15551110002";
const PRIYA = "+15551110003";
const out = process.env.SMOKE_OUT;
if (out) mkdirSync(out, { recursive: true });
let shots = 0;

const run = async (userId: string, text: string, isDm = false): Promise<Reply> => {
  const r = await handleCommand({ spaceId: isDm ? `iMessage;-;${userId}` : space, userId, text, isDm });
  console.log(`\n> ${userId.slice(-4)}${isDm ? " (dm)" : ""}: ${text}\n${r?.text}`);
  for (const dm of r?.dms ?? []) console.log(`  [dm → ${dm.to.slice(-4)}] ${dm.text.replace(/\n/g, "\n  ")}`);
  if (r?.image && out) writeFileSync(join(out, `${++shots}-${text.replace(/\W+/g, "_")}.png`), r.image);
  return r ?? { text: "" };
};
const say = async (u: string, t: string) => (await run(u, t)).text;

await say(VISH, "!name Vish");
await say(SAM, "!name Sam");
await say(PRIYA, "!name Priya");
await say(VISH, "!venmo @vish-r");

assert.match(await say(VISH, "!new Will Jake be late to dinner"), /#1 Will Jake/);
await say(VISH, "!yes 1 20");
await say(SAM, "!no 1 $30");
await say(PRIYA, "!yes 1 10");
await say(SAM, "!no 1 $2.50");
assert.match(await say(SAM, "!yes 1 99999"), /Max is \$50/);
// "!yes 5" goes to the newest open market and asks for a live chart.
assert.match(await say(SAM, "!why 1"), /Opening odds 50%/);
const quick = await run(PRIYA, "!yes 1");
assert.equal(quick.betOn?.id, 1);
// Opening odds act as $20 of imaginary money at 50%: real money moves them, not slams them.
assert.match((await run(VISH, "!m 1")).text, /YES 4\d%/);
assert.match(await say(SAM, "!yes 1 lots"), /Invalid amount/);
assert.match(await say(SAM, "!resolve 1 yes"), /Only Vish/);

const card = await run(VISH, "!m 1");
assert.ok(card.image && card.image.length > 1000, "market chart rendered");
const board = await run(VISH, "!markets");
assert.ok(board.image, "board chart rendered");

// Pot $62.50, YES pool $30. Vish (20) gets 41.66, Priya (10) gets 20.83.
// Sam staked 32.50 and loses it all; one payment per winner.
const settle = await run(VISH, "!resolve 1 yes");
assert.match(settle.text, /resolved YES/);
assert.ok(settle.image, "settle card rendered");
const debts = openDebtsFor(SAM);
assert.equal(debts.length, 2);
assert.equal(debts.reduce((s, d) => s + d.amount, 0), 3250); // Sam's full stake
assert.ok(settle.dms?.some((d) => d.to === SAM && /venmo\.com\/vish-r\?txn=pay/.test(d.text)), "Sam gets a Venmo link to Vish");
assert.match(await say(VISH, "!yes 1 10"), /resolved/);

// Payment flow, from DMs.
const toVish = debts.find((d) => d.creditor === VISH)!;
const toPriya = debts.find((d) => d.creditor === PRIYA)!;
assert.match((await run(VISH, `!paid ${toVish.id}`, true)).text, /isn't yours/);
const paid = await run(SAM, `!paid ${toVish.id}`, true);
assert.ok(paid.dms?.some((d) => d.to === VISH && /!got/.test(d.text)));
assert.match((await run(VISH, "!nope", true)).text, /Reminders resumed/);
await run(SAM, `!paid ${toVish.id}`, true);
assert.match((await run(VISH, "!got", true)).text, /closed/);
assert.match((await run(PRIYA, `!forgive ${toPriya.id}`, true)).text, /forgiven/);
assert.equal(openDebtsFor(SAM).length, 0);
assert.match((await run(SAM, "!new sneaky", true)).text, /works in the group chat/);

const lb = leaderboard(space);
assert.equal(lb[0]!.user_id, VISH);
await say(SAM, "!lb");

// Wash: nobody took the winning side.
await say(PRIYA, "!new Does it snow tomorrow?");
await say(SAM, "!no 2 5");
assert.match(await say(PRIYA, "!resolve 2 yes"), /wash/);

// Cancel voids bets, nobody owes anything.
await say(PRIYA, "!new Rain on Friday?");
await say(SAM, "!no 3 5");
await say(PRIYA, "!cancel 3");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM debts WHERE market_id = 3").get() as { n: number }).n, 0);

// Live external lookups (network).
const k = await say(VISH, "!kalshi fed rate");
assert.match(k, /Kalshi/);
const ticker = k.match(/!mirror (kalshi:\S+)/)?.[1];
if (ticker) {
  assert.match(await say(VISH, `!mirror ${ticker}`), /Settles automatically/);
  await say(VISH, "!yes 4 8");
  await say(SAM, "!no 4 3");
  await run(VISH, "!m 4");
}
assert.match(await say(VISH, "!poly bitcoin"), /Polymarket/);

assert.equal(await handleCommand({ spaceId: space, userId: "x", text: "!lol" }), null);
console.log("\n✅ smoke test passed");
