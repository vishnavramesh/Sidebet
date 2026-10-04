#!/bin/zsh
# Run from YOUR account. Copies the bot to /Users/Shared/groupmarkets, where the
# "Group Markets" macOS user runs it. Safe to re-run: code is replaced, the bot's
# own .env and database there are kept unless you pass --with-db.
set -euo pipefail
SRC="${0:A:h:h}"
DEST=/Users/Shared/groupmarkets
mkdir -p "$DEST/logs"
rsync -a --delete --exclude .git --exclude 'markets.db*' --exclude .env --exclude /logs --exclude /.restart "$SRC/" "$DEST/"

if [[ "${1:-}" == "--with-db" ]]; then
  # A proper SQLite backup, so writes still in the WAL aren't lost.
  sqlite3 "$SRC/markets.db" ".backup '$DEST/markets.db'"
  echo "copied database"
fi

if [[ ! -f "$DEST/.env" ]]; then
  # Same settings as yours, switched to the dedicated bot account.
  grep -vE '^(BOT_ACCOUNT|OWNER_HANDLES|LOG_UNKNOWN_CHATS|RESTART_FILE|DB_PATH)=' "$SRC/.env" > "$DEST/.env"
  cat >> "$DEST/.env" <<ENV

# Dedicated bot account (written by deploy/sync.sh)
BOT_ACCOUNT=dedicated
OWNER_HANDLES=${OWNER_HANDLES:?set OWNER_HANDLES to your phone,email}
LOG_UNKNOWN_CHATS=on
RESTART_FILE=$DEST/.restart
DB_PATH=$DEST/markets.db
ENV
  echo "wrote $DEST/.env"
fi

# Both macOS users are in the "staff" group: let the bot user read and write.
chgrp -R staff "$DEST"
chmod -R g+rwX,o-rwx "$DEST"   # bot user (staff) can read/write; nobody else
echo "synced to $DEST"
