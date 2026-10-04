# 🎲 Sidebet

A prediction-market bot for iMessage group chats, built on [Spectrum](https://photon.codes/docs/spectrum-ts/providers/imessage). Friends open yes/no markets on anything ("Will Jake be late?"), bet against each other with play money (or real dollars with `MONEY_MODE=real`), and get a chart of the odds and the pot. In real-money mode the bot never holds money: when a market settles it works out who pays whom, DMs the losers how to pay (Apple Cash, or one-tap Venmo / Cash App links), and keeps reminding them until the winner confirms. Public events can be **mirrored from Kalshi or Polymarket**, so the group sees real-world odds and the market **settles automatically** when the real one does.

With an Anthropic key set, the bot also reads the chat and notices when someone makes a bettable claim, then offers to turn it into a market.

```
Sam:   lions win sunday easy
Bot:   👀 That sounds like a bet: "Will the Lions win their game on Sunday?"
       Reply !new to open it.
       📈 Kalshi has a market on this: YES 64% (!mirror kalshi:KXNFLGAME-...)
Vish:  !mirror kalshi:KXNFLGAME-...
Bot:   #4 Will the Lions win … Kalshi says YES 64%. Settles on its own.
Sam:   !yes 4 20
Priya: !no 4 10
        … Sunday night, resolver sees Kalshi settle …
Bot:   #4 resolved YES  ·  Priya → Sam $10   [settle-up card]
Bot → Priya (DM): You owe Sam $10 (IOU 7). Apple Cash: … Then reply !paid 7
```

## Run it

Needs Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # optional
npm run terminal          # REPL, no iMessage needed (use this for dev and demos)
npm start                 # real iMessage
npm run smoke             # end-to-end test of the command layer
npm run scan -- "<chat id>"   # read a group's history first, so opening odds know the group
```

**iMessage modes**

| Mode | When | Setup |
|---|---|---|
| Local (`local_imessage`) | no `SPECTRUM_PROJECT_ID` | Runs against this Mac's Messages.app. Grant your terminal **Full Disk Access** (System Settings → Privacy & Security). The bot replies as whatever Apple ID Messages is signed into. The owner can play too: a second watcher picks up your own `!` commands in allowed chats (as `OWNER_NAME`). Payment DMs to yourself are skipped. On macOS 15 a small patch (`patches/`, applied on install) is needed because imessage-kit 3.0.0 expects the macOS 26 schema. |
| Cloud (`imessage`) | `SPECTRUM_PROJECT_ID` + `SECRET` set | A managed Spectrum line gets its own number. Add it to the group chat. |

## Odds and live charts

- **Opening odds.** Before going live in a group, run `npm run scan -- "<chat id>"`. It copies the chat's history (with names from Contacts) into the bot's database and, with an API key, has Claude write a short summary of the group. When a market opens, Claude reads that history and sets a starting probability and posts the case for it: a one-line summary plus up to three points from the chat for YES and for NO (`!why <id>` shows it again). The guess counts as `PRIOR_WEIGHT` dollars of imaginary money, so real bets move the odds from there. Payouts only ever use real money.
- **Kalshi first.** Every `!new` checks Kalshi for the same question. A match becomes a mirror: it opens at Kalshi's price, its chart shows Kalshi's line, and it settles when Kalshi does.
- **Live updates.** iMessage can't embed a live widget, so the bot re-posts the chart instead: 15 seconds after a burst of bets, and whenever a mirrored Kalshi market moves `KALSHI_MOVE_POINTS` or more.
- **Payout odds.** Replies and charts show what $1 returns on each side at the current pot ("YES pays 1.4x").

## How it sounds

Replies are short and neutral, like a bot. Every bot message is set in Unicode small caps ʟɪᴋᴇ ᴛʜɪꜱ (`BOT_FONT`) so it's obvious which messages are the bot, since in local mode it sends from a real person's account and can't use iMessage effects. Links stay plain, and commands typed or pasted in any font still work.

## Commands

| | |
|---|---|
| `!new <question>` | open a yes/no market. If Kalshi has the same question it mirrors it (and settles with it); otherwise Claude sets opening odds from the scanned chat history. `!new` alone adopts the bot's last suggestion |
| `!yes 5` | bet on the newest market |
| 👍 / 👎 on a market message | bet `TAPBACK_AMOUNT` YES / NO (local mode) |
| `!closes <id> 2h` | stop betting at a time (`30m`, `8pm`, `tomorrow 9am`, `fri 8pm`); also `!new <question> \| 2h`. Last call 15 min before, then reminders to resolve |
| `!bal`, `!daily` | play-money balance, +100 coins a day |
| `!demo [eth]` | with `DEMO=on`: mirror the hourly Kalshi BTC (or ETH) market nearest 50/50, so it settles live |
| `!yes <id> <amt>` / `!no <id> <amt>` | bet dollars: `5`, `$5`, `2.50` (capped by `MAX_BET`) |
| `!why <id>` | the case for and against the opening odds |
| `!m <id>` | chart: odds over time, pot, YES/NO split, who's in, real-market line if linked |
| `!markets` | chart of all open markets |
| `!resolve <id> yes\|no` | creator settles a manual market |
| `!close <id>`, `!cancel <id>` | stop betting / void every bet |
| `!lb`, `!name <nick>` | all-time winnings, display name |
| `!kalshi <q>`, `!poly <q>` | search real markets |
| `!mirror kalshi:<TICKER>` / `poly:<id>` | open a group market that tracks and auto-settles with the real one |
| `!link <id> kalshi:<TICKER>` | attach a real market to an existing group market |

**Paying up** (work in the group or in a DM with the bot)

| | |
|---|---|
| `!owe` | what you owe and are owed |
| `!paid [iou]` | you sent it; the winner gets asked to confirm |
| `!got [iou]` / `!nope [iou]` | winner confirms, or says it never arrived (reminders resume) |
| `!forgive <iou>` | winner lets it go |
| `!venmo <name>`, `!cashapp <tag>` | people who owe you get a prefilled pay link |

Payouts are **parimutuel**: the winning side splits the whole pot in proportion to their stakes, and the bot turns that into the fewest payments (biggest loser pays biggest winner first). If nobody took the winning side it's a wash.

**Why not Apple Cash directly?** Apple has no API for sending or requesting Apple Cash, so the bot can't move money. It tells people exactly who to pay and how much, then reminds them: privately after `NAG_FIRST_HOURS`, then every 6, 12 and 24 hours with escalating messages, and once a day in the group after `NAG_PUBLIC_AFTER` reminders. Nothing between `QUIET_START` and `QUIET_END`.

## Layout

```
src/index.ts             Spectrum setup, message loop, provider selection
src/commands.ts          command parser and replies (pure, testable)
src/markets.ts           bets, parimutuel settlement, IOUs (SQLite)
src/charts.ts            SVG → PNG market, board and settle-up cards
src/nagger.ts            payment DMs and escalating reminders
src/money.ts             dollar parsing and formatting (cents internally)
src/detect.ts            Claude bet detection with structured output
src/resolver.ts          polls linked markets and auto-settles them
src/external/            Kalshi + Polymarket adapters (ExternalSource interface)
scripts/smoke.ts         end-to-end test
```

Adding another venue (Manifold, PredictIt, sports scores API…) means implementing `ExternalSource` (`search`, `get`) and adding it to `sources`.

## Stretch goals

- **Apple Cash requests:** if Apple ever ships an API, replace the reminder DMs with a real payment request.
- **Real Kalshi trading:** let users link a Kalshi API key (RSA-signed requests) and place a real order alongside their group bet. This needs per-user secret storage and a DM-only setup flow, so keys never touch the group chat.
- Spectrum Cloud extras: tapback reactions to bet (👍 = YES, 👎 = NO), iMessage polls, and typing indicators.
- Disputes: let the group vote to override the creator's resolution.
- Market close times, with a reminder to the creator.
