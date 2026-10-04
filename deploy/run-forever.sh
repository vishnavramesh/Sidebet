#!/bin/zsh
# Keep the bot running without a login item: stops the Mac from sleeping and
# restarts the bot 5 seconds after it exits (crash, or a deliberate restart).
#   zsh /Users/Shared/groupmarkets/deploy/run-forever.sh
# To restart just the bot (this loop brings it back):
#   pkill -f "tsx/dist/cli.mjs"
cd "${0:A:h:h}"
mkdir -p logs
# The bot's command goes through env vars so this loop's own command line
# never matches "tsx/dist/cli.mjs", and the pkill above only hits the bot.
export BOT_NODE="$(readlink -f /opt/homebrew/bin/node)" BOT_ENTRY=node_modules/tsx/dist/cli.mjs
exec caffeinate -dims zsh -c '
  while true; do
    echo "--- start $(date)" >> logs/bot.log
    "$BOT_NODE" "$BOT_ENTRY" --env-file-if-exists=.env src/index.ts >> logs/bot.log 2>&1
    echo "--- exited $? at $(date), restarting in 5s" >> logs/bot.log
    sleep 5
  done'
