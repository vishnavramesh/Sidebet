// End-to-end check of the command layer without iMessage. Run: npm run smoke
import assert from "node:assert/strict";
import { handleCommand } from "../src/commands.ts";
import { getBalance } from "../src/markets.ts";

const space = "smoke-chat";
const say = async (userId: string, text: string) => {
  const out = await handleCommand({ spaceId: space, userId, text });
  console.log(`\n> ${userId}: ${text}\n${out}`);
  return out ?? "";
};

await say("+15551110001", "!name Vish");
await say("+15551110002", "!name Sam");
await say("+15551110003", "!name Priya");

assert.match(await say("+15551110001", "!new Will Jake be late to dinner"), /Market #1 open/);
await say("+15551110001", "!yes 1 200");
await say("+15551110002", "!no 1 300");
await say("+15551110003", "!yes 1 100");
assert.match(await say("+15551110002", "!yes 1 99999"), /only have/);
assert.match(await say("+15551110002", "!resolve 1 yes"), /Only Vish/);
await say("+15551110001", "!markets");
const settle = await say("+15551110001", "!resolve 1 yes");
assert.match(settle, /resolved YES/);

// Pot 600, YES pool 300: Vish (200) gets 400, Priya (100) gets 200, Sam loses 300.
assert.equal(getBalance(space, "+15551110001"), 1200);
assert.equal(getBalance(space, "+15551110003"), 1100);
assert.equal(getBalance(space, "+15551110002"), 700);
assert.match(await say("+15551110001", "!yes 1 10"), /resolved/);

await say("+15551110002", "!lb");
assert.match(await say("+15551110002", "!daily"), /\+100/);
assert.match(await say("+15551110002", "!daily"), /Already/);

// Cancel refunds.
await say("+15551110003", "!new Does it snow tomorrow?");
await say("+15551110002", "!no 2 50");
await say("+15551110003", "!cancel 2");
assert.equal(getBalance(space, "+15551110002"), 800);

// Live external lookups (network).
const k = await say("+15551110001", "!kalshi fed rate");
assert.match(k, /Kalshi/);
const ticker = k.match(/!mirror (kalshi:\S+)/)?.[1];
if (ticker) {
  assert.match(await say("+15551110001", `!mirror ${ticker}`), /Settles automatically/);
  await say("+15551110001", "!m 3");
}
const p = await say("+15551110001", "!poly bitcoin");
assert.match(p, /Polymarket/);

assert.equal(await handleCommand({ spaceId: space, userId: "x", text: "!lol" }), null);
console.log("\n✅ smoke test passed");
