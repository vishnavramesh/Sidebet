# 🎲 Group Markets

A prediction-market bot for iMessage group chats, built on [Spectrum](https://photon.codes/docs/spectrum-ts/providers/imessage). Friends open yes/no markets on anything ("Will Jake be late?"), bet play-money 🪙 against each other, and settle up. Public events can be **mirrored from Kalshi or Polymarket**, so the group sees real-world odds and the market **settles automatically** when the real one does.

With an Anthropic key set, the bot also reads the chat and notices when someone makes a bettable claim, then offers to turn it into a market.

```
Sam:   lions win sunday easy
Bot:   👀 That sounds like a bet: "Will the Lions win their game on Sunday?"
       Reply !new to open it.
       📈 Kalshi has a market on this: YES 64% (!mirror kalshi:KXNFLGAME-...)
Vish:  !mirror kalshi:KXNFLGAME-...
Bot:   📊 Market #4 open … Kalshi says YES 64%. Beat the market.
Sam:   !yes 4 300
Priya: !no 4 200
        … Sunday night, resolver sees Kalshi settle …
Bot:   ✅ #4 resolved YES … 🤑 Sam +200  💀 Priya -200
```

## Run it

Needs Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # optional
npm run terminal          # REPL, no iMessage needed (use this for dev and demos)
npm start                 # real iMessage
npm run smoke             # end-to-end test of the command layer
```

**iMessage modes**

| Mode | When | Setup |
|---|---|---|
| Local (`local_imessage`) | no `SPECTRUM_PROJECT_ID` | Runs against this Mac's Messages.app. Grant your terminal **Full Disk Access** (System Settings → Privacy & Security). The bot replies as *you*. |
| Cloud (`imessage`) | `SPECTRUM_PROJECT_ID` + `SECRET` set | A managed Spectrum line gets its own number. Add it to the group chat. |

## Commands

| | |
|---|---|
| `!new <question>` | open a yes/no market (`!new` alone adopts the bot's last suggestion) |
| `!yes <id> <amt>` / `!no <id> <amt>` | bet (`all` works as the amount) |
| `!markets`, `!m <id>` | list markets / show details plus live external odds |
| `!resolve <id> yes\|no` | creator settles a manual market |
| `!close <id>`, `!cancel <id>` | stop betting / refund everyone |
| `!bal`, `!daily`, `!lb`, `!name <nick>` | wallet, +100 per day, leaderboard, display name |
| `!kalshi <q>`, `!poly <q>` | search real markets |
| `!mirror kalshi:<TICKER>` / `poly:<id>` | open a group market that tracks and auto-settles with the real one |
| `!link <id> kalshi:<TICKER>` | attach a real market to an existing group market |

Each chat has its own wallets (1000 🪙 to start). Payouts are **parimutuel**: the winning side splits the whole pot in proportion to their stakes. If nobody took the winning side, everyone is refunded.

## Layout

```
src/index.ts             Spectrum setup, message loop, provider selection
src/commands.ts          command parser and replies (pure, testable)
src/markets.ts           wallets, bets, parimutuel settlement (SQLite)
src/detect.ts            Claude bet detection with structured output
src/resolver.ts          polls linked markets and auto-settles them
src/external/            Kalshi + Polymarket adapters (ExternalSource interface)
scripts/smoke.ts         end-to-end test
```

Adding another venue (Manifold, PredictIt, sports scores API…) means implementing `ExternalSource` (`search`, `get`) and adding it to `sources`.

## Stretch goals

- **Real Kalshi trading:** let users link a Kalshi API key (RSA-signed requests) and place a real order alongside their group bet. This needs per-user secret storage and a DM-only setup flow, so keys never touch the group chat.
- Spectrum Cloud extras: tapback reactions to bet (👍 = YES, 👎 = NO), iMessage polls, and typing indicators.
- Disputes: let the group vote to override the creator's resolution.
- Market close times, with a reminder to the creator.
