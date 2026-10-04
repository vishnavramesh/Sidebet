# Group Markets: pitch and demo notes

## One line

Friends already argue about who'll be late, whether the camping trip happens, and who wins Sunday. Group Markets turns those arguments into prediction markets inside the iMessage group chat, with odds set from the chat's own history and real-world bets mirrored live from Kalshi.

## Lead with the hook, not the command list

The moment that sells it: someone types a casual claim and the bot jumps in.

```
Sam:   lions win sunday easy
Bot:   Possible market: "Will the Lions win on Sunday?"  Reply !new to open it.
Sam:   !new
Bot:   Mirroring Kalshi: Detroit wins (YES 64%). Settles when Kalshi does.
       [chart card]
Priya: 👎            ← tapback = bet NO
Bot:   Bet placed: Priya · 100 coins NO on #4
```

Then show a friend-group market, where the AI reads the chat to set the odds and explains itself:

```
Vish:  !new Will the camping trip happen before Thanksgiving?
Bot:   Reading chat history to set odds for #7…
Bot:   Opening odds 15%. Planned for August, stalled without a date, and the semester started.
       For YES: + Harish has a tent and Nishant has sleeping bags (Aug 3) …
       For NO:  - No camping messages since early August …
```

## Demo script (5 minutes)

1. **Setup (before judging):** `MONEY_MODE=play`, `DEMO=on`, judges added to a fresh group chat, `ALLOWED_CHATS` set to it, `npm run scan -- "<chat id>"` on a chat with some history.
2. **Hook:** a teammate types a bettable claim and the bot suggests a market. Open it with `!new`.
3. **Judges play:** they 👍 / 👎 the market message. No commands to learn.
4. **AI odds:** open a market about someone in the room. Show the For/Against case.
5. **Live settle:** `!demo` early in the session. It mirrors the hourly Kalshi Bitcoin market nearest 50/50. It locks at the top of the hour and settles on its own a few minutes later, in front of the judges. (If timing is off, say so: it's the real market, it settles when Kalshi does.)
6. **Close:** `!lb` for the leaderboard.

**Backup:** `npm run terminal` runs the same bot as a local chat REPL with charts, no iMessage needed.

## Questions judges will ask

**"Isn't this gambling?"** Demo and default mode are play money only: 1,000 coins each, +100 a day, no cash in or out. The stakes are social. (A separate real-money mode only tracks IOUs between friends and never holds or moves money.)

**"Why iMessage?"** That's where these bets already happen. No app to download, no account, no invite link. You add the bot to a chat that already exists.

**"What if Apple or Spectrum changes something?"** Messaging sits behind one provider interface (Spectrum supports iMessage locally and in the cloud), and real-market data sits behind `ExternalSource` (Kalshi and Polymarket today). Porting to Discord or WhatsApp means a new provider, not a rewrite.

**"Why not reply from a proper bot number?"** Locally the bot sends through a Mac's Messages app, so its messages use a distinct font. Photon's cloud lines give it its own number, but group chats need their Business plan ($250/line/month). The free tier is DMs only.

## Compared with blendit (github.com/pinturi29/blendit)

Prabhath's blendit is a group trip planner: an Expo / React Native app on Supabase. Friends paste TikToks and Reels into a trip and vote each clip up or down. A worker downloads the video, samples frames, and has Claude pull out every real place shown; clips the group voted up become the itinerary.

| | Group Markets | blendit |
|---|---|---|
| Problem | Settling group arguments and predictions | Agreeing on what to do on a group trip |
| Where it lives | Inside an existing iMessage group | Standalone mobile app (sign-up, invites by email) |
| Group signal | Money (or coins) on YES/NO: confidence-weighted | Up/down votes: one person, one vote |
| AI's job | Read chat history to set odds and argue both sides; spot bets in conversation | Watch short videos and extract places; build an itinerary |
| Real-world data | Kalshi / Polymarket odds, auto-settlement | Google Places / OpenStreetMap geocoding |
| Stack | Node + SQLite, one process on a Mac | Expo + Supabase (Postgres, RLS, Storage) + a queue worker |
| Size | ~2.6k lines of TypeScript | ~9.3k lines of TypeScript |
| Demo friction | Judges join a chat and tap 👍 | Judges install Expo Go and sign up |

**Where blendit is stronger:** a polished, designed mobile UI; real multi-user auth and permissions; a robust job queue; a harder AI task (video understanding).

**Where Group Markets is stronger:** zero onboarding, a live "wow" moment in a chat, real-world data that settles itself, and AI output the group can argue with.

**They fit together.** Both turn messy group opinions into a decision. A natural bridge is markets on blendit trips ("Will we actually book Miami?" or "Will Ajay make the 7am hike?"), opened from the trip's group chat with the itinerary as context for the odds.
