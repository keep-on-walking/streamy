#!/bin/bash
# ─── Streamy Kiosk Launcher ─────────────────────────────────────────────────
# Starts the Streamy server AND opens Chromium in kiosk mode
# Run from within the streamy directory

PORT=${PORT:-3000}

echo "🎵 Starting Streamy in kiosk mode on port $PORT..."

# Start server in background
npm start &
SERVER_PID=$!

# Wait for server to be ready
echo "⏳ Waiting for server..."
until curl -s "http://localhost:$PORT/api/health" > /dev/null 2>&1; do
  sleep 0.5
done
echo "✅ Server ready"

# Hide cursor (optional, for touchscreen kiosk)
if command -v unclutter &> /dev/null; then
  unclutter -idle 1 &
fi

# Disable screen blanking/screensaver
xset s off
xset -dpms
xset s noblank

# Launch Chromium in kiosk mode
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-translate \
  --disable-features=TranslateUI \
  --app="http://localhost:$PORT" \
  --start-fullscreen \
  --touch-events=enabled \
  --enable-features=OverlayScrollbar \
  2>/dev/null

# Cleanup on exit
kill $SERVER_PID 2>/dev/null
