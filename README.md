# 🎵 Streamy

> Touch-friendly jukebox music player that streams from YouTube Music.
> Built for Linux/Ubuntu touchscreen displays, accessible from any device on your local network.

---

## ✨ Features

- **YouTube Music streaming** via `yt-dlp` — no API key needed
- **Touch-first UI** — 48px+ tap targets, large search box, card-based layout
- **Jukebox behavior** — default action is "Add to Queue"; "Play Now" always available
- **Queue management** — drag to reorder, remove tracks, clear all
- **Synchronized lyrics** — via LRCLIB (free), falls back to lyrics.ovh
- **Auto-hiding collapsible sidebar** with full playback controls
- **Real-time sync via WebSocket** — use your phone as a remote
- **Kiosk mode** — one command to go fullscreen
- **Dark sidebar / light content area** — clean Zeyox Studio-inspired aesthetic

---

## 🚀 Quick Start

```bash
# 1. Clone or copy this folder onto your Ubuntu machine
cd streamy

# 2. Run the setup script (installs Node.js, yt-dlp, ffmpeg, npm packages)
chmod +x setup.sh kiosk.sh
./setup.sh

# 3. Start the server
npm start

# 4. Open in browser
# Local:   http://localhost:3000
# Network: http://YOUR_LOCAL_IP:3000
```

---

## 📱 Phone as Remote

Once running, open `http://YOUR_LOCAL_IP:3000` on any device on your network.
Changes sync in real-time via WebSocket — add songs from your phone, they appear in the queue on the main display instantly.

Find your local IP:
```bash
hostname -I | awk '{print $1}'
# or
ip addr show | grep 'inet ' | grep -v 127.0.0.1
```

---

## 🖥️ Kiosk Mode (Touchscreen Display)

```bash
# Start server + open Chromium fullscreen
./kiosk.sh
```

**Optional: hide cursor (for touch-only displays)**
```bash
sudo apt install unclutter
```

---

## 🔄 Autostart on Boot (systemd)

```bash
# Copy files to /opt/streamy
sudo cp -r . /opt/streamy

# Install and enable the service
sudo cp streamy.service /etc/systemd/system/streamy@.service
sudo systemctl daemon-reload
sudo systemctl enable streamy@YOUR_USERNAME
sudo systemctl start streamy@YOUR_USERNAME

# Check status
sudo systemctl status streamy@YOUR_USERNAME
```

---

## 🏗️ Architecture

```
streamy/
├── src/
│   └── server.js          # Express + WebSocket backend
├── public/
│   └── index.html         # Full SPA frontend (vanilla JS)
├── package.json
├── setup.sh               # One-time install script
├── kiosk.sh               # Kiosk mode launcher
└── streamy.service        # systemd unit file
```

### Backend (`src/server.js`)

| Endpoint | Description |
|---|---|
| `GET /api/search?q=&type=` | Search YouTube (via yt-dlp) |
| `GET /api/stream/:videoId` | Stream audio (piped from yt-dlp) |
| `GET /api/lyrics?title=&artist=` | Fetch lyrics (LRCLIB → lyrics.ovh) |
| `GET /api/info/:videoId` | Get track metadata |
| `GET /api/queue` | Current queue + state |
| `POST /api/queue/add` | Add track to queue |
| `POST /api/queue/playnow` | Jump a track to front of queue |
| `DELETE /api/queue/:index` | Remove from queue |
| `GET /api/health` | Health check |
| `WS /` | Real-time state sync |

### WebSocket Actions (client → server)

```js
{ action: 'play' }
{ action: 'pause' }
{ action: 'next' }
{ action: 'prev' }
{ action: 'setVolume', payload: { volume: 80 } }
{ action: 'seek', payload: { position: 42.5 } }
{ action: 'toggleShuffle' }
{ action: 'cycleRepeat' }   // none → one → all → none
{ action: 'removeFromQueue', payload: { index: 2 } }
{ action: 'reorderQueue', payload: { from: 1, to: 3 } }
{ action: 'playNow', payload: { track: {...} } }
{ action: 'clearQueue' }
```

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |

---

## 🔧 Dependencies

- **Node.js 18+** — runtime
- **yt-dlp** — YouTube audio download/stream
- **ffmpeg** — audio format conversion
- **express** — HTTP server
- **ws** — WebSocket server
- **node-cache** — in-memory caching for search results
- **axios** — HTTP client for lyrics APIs

---

## 📝 Notes

- **No YouTube Music account required** for basic search/playback
- Lyrics are sourced from [LRCLIB](https://lrclib.net) (free, no auth) with fallback to [lyrics.ovh](https://api.lyrics.ovh)
- `yt-dlp` should be kept updated (`sudo yt-dlp -U`) as YouTube changes frequently
- Audio streams directly from YouTube — no local storage of music files
- For best performance on a Raspberry Pi or low-power device, set `NODE_ENV=production`

---

## 🎨 UI Design

Inspired by the **Zeyox Studio dashboard** aesthetic:
- Dark sidebar (`#0f0f14`) with lime-green accent (`#c8ff57`)
- Light content area (`#f4f3ef`) with white cards
- Syne (display) + DM Sans (body) typography
- Rounded cards, generous padding, smooth transitions
- Touch-optimized: all interactive elements ≥ 48px

---

*Built with ❤️ for the living room jukebox experience.*
