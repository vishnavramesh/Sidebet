#!/bin/zsh
# Run ONCE from inside the "Group Markets" macOS user, in Terminal:
#   zsh /Users/Shared/groupmarkets/deploy/setup-bot-user.sh
# Installs a login item that runs the bot whenever this user is logged in and
# restarts it if it exits.
set -euo pipefail
APP=/Users/Shared/groupmarkets
NODE="$(readlink -f /opt/homebrew/bin/node)"   # the real binary, so Full Disk Access sticks
PLIST="$HOME/Library/LaunchAgents/com.groupmarkets.bot.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$APP/logs"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.groupmarkets.bot</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$APP/node_modules/tsx/dist/cli.mjs</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$APP/logs/bot.log</string>
  <key>StandardErrorPath</key><string>$APP/logs/bot.log</string>
</dict></plist>
PL

open -g -a Messages
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. The bot is starting; log: $APP/logs/bot.log"
echo
echo "If the log says it can't read the Messages database, give Full Disk Access to:"
echo "  $NODE"
echo "(System Settings → Privacy & Security → Full Disk Access → + → Cmd+Shift+G, paste the path)"
