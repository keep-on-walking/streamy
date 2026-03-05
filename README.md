# 🎵 Streamy

A touch-friendly jukebox music player with YouTube search, local mpv display output, and remote control from any device on the network.

## How It Works

Streamy runs on a host machine (Linux PC or Raspberry Pi 5) connected to a display and amplifier. All playback happens locally via **mpv** — the connected screen shows music videos, visualizations, or a QR code idle screen. Any device on the network (phone, tablet, laptop) can control playback through a web browser.

```
┌──────────────┐         ┌──────────────────────┐
│  Phone/iPad  │◄──WiFi──►│   Streamy Host        │
│  (Remote UI) │  WebSocket│   (OptiPlex / Pi 5)   │
└──────────────┘         │                      │
                         │  Node.js + Express    │
                         │  yt-dlp + mpv         │
                         │       │               │
                         │       ▼               │
                         │  ┌──────────┐         │
                         │  │ HDMI Out │──► TV/Display
                         │  │ Audio Out│──► Amplifier
                         │  └──────────┘         │
                         └──────────────────────┘
```

## Features

- **YouTube search** with music-focused filtering (no kids' videos, compilations, or non-music content)
- **Music video playback** on the connected display via mpv
- **Seamless track transitions** — no desktop flash between tracks
- **Three display modes**: video, waveform visualization, karaoke (subtitles)
- **QR code idle screen** — guests scan to open the remote control
- **Queue management** — add, reorder, remove, shuffle, repeat
- **Synced lyrics** with auto-sync detection and manual offset adjustment
- **YouTube account connection** — browser cookies or cookie file for liked songs and age-restricted content
- **PWA support** — add to home screen on iPhone/Android for an app-like experience
- **Hardware-accelerated** video decoding on both PC and Pi 5

## Quick Install

```bash
git clone https://github.com/keep-on-walking/streamy.git
cd streamy
chmod +x install.sh
./install.sh
```

The installer will:
1. Ask if you're on a **Linux PC** or **Raspberry Pi 5**
2. For Pi 5, ask whether to use **DRM kiosk mode** or **X11 desktop mode**
3. Install all dependencies (Node.js, mpv, ffmpeg, yt-dlp)
4. Configure platform-specific mpv settings
5. Create and start a systemd service

## Accessing Streamy

After install, the terminal shows the URLs:

- **Master controller**: `http://<host-ip>:3000` — full settings, queue management, playback controls
- **Remote**: `http://<host-ip>:3000/remote` — search + queue only (designed for guests)

The QR code on the connected display also points to the remote URL.

## Web Interfaces

### Master Controller (`/`)
Full dashboard with sidebar navigation: Discover, Search, Queue, Liked Songs, Lyrics, Display settings, and system Settings. Includes playback controls, volume, shuffle/repeat, and diagnostics.

### Remote (`/remote`)
Streamlined mobile interface with three tabs: Discover (mood buttons + top tracks grid), Search, and Queue. Designed for guest access — no settings, just search and add music.

## Display Modes

Switch between modes in the Display panel or via the sidebar:

- **Video** — plays the YouTube music video fullscreen
- **Visualization** — audio waveform visualization (cline style, purple/green)
- **Karaoke** — visualization with synced lyrics as subtitles

## Settings

### YouTube Account
Connect your YouTube account for liked songs, personalized recommendations, and age-restricted content. Supports browser cookie extraction and cookie file upload.

### Lyrics
- **Show on Display** — toggle synced lyrics as subtitles on the TV output
- **Sync Offset** — adjust timing if lyrics are out of sync with the video
- **Auto-sync** — automatically detects silent video intros and adjusts offset

### Playback
- Default volume on startup
- Volume control

## Platform Configuration

The installer writes platform-specific mpv settings to `streamy-config.json`:

| Setting | Linux PC | Pi 5 (DRM) | Pi 5 (X11) |
|---------|----------|------------|------------|
| Max video | 4K (2160p) | 1080p | 1080p |
| Video output | auto | `--vo=drm` | `--vo=gpu` |
| Hardware decode | `auto-safe` | `drm-copy` | `drm-copy` |
| Extra args | — | — | `--gpu-context=x11egl` |

To change platform after install, run `./install.sh` again — it preserves existing config (YouTube auth, preferences) and only updates platform settings.

## Managing the Service

```bash
sudo systemctl start streamy      # Start
sudo systemctl stop streamy       # Stop
sudo systemctl restart streamy    # Restart
sudo systemctl enable streamy     # Enable on boot
sudo systemctl disable streamy    # Disable on boot
sudo journalctl -u streamy -f     # View live logs
```

## Troubleshooting

### No video on display
The systemd service needs display environment variables. The installer auto-detects these, but if it misses them, add manually:
```bash
sudo systemctl edit streamy
```
Add under `[Service]`:
```
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/run/user/1000
```

### Player freezes
Check mpv state:
```bash
echo '{"command":["get_property","pause"]}' | socat - /tmp/streamy-mpv.sock
echo '{"command":["get_property","eof-reached"]}' | socat - /tmp/streamy-mpv.sock
```
Install socat if missing: `sudo apt install socat`

### Search returns non-music results
Streamy filters results by duration (60s–600s) and blocks known non-music channels. Searches pull 50 results from YouTube and rank by music signals (verified channels, VEVO, "Official" in title). Results will improve when YouTube account is connected.

### yt-dlp errors
Update to latest version:
```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp
sudo chmod a+rx /usr/bin/yt-dlp
```

## Dependencies

- **Node.js** (v18+) — application server
- **mpv** — video/audio playback
- **ffmpeg** — audio analysis, idle screen generation, visualization
- **yt-dlp** — YouTube search and stream extraction
- **qrcode** (npm) — QR code generation for idle screen

## File Structure

```
streamy/
├── install.sh              # Interactive installer
├── kiosk.sh                # Pi kiosk mode setup (optional)
├── package.json
├── src/
│   ├── server.js           # Express + WebSocket server
│   ├── player.js           # mpv playback engine with IPC
│   └── settings.js         # Config & YouTube auth
└── public/
    ├── index.html           # Master controller UI
    ├── remote.html          # Mobile remote UI
    ├── manifest.json        # PWA manifest (master)
    ├── manifest-remote.json # PWA manifest (remote)
    ├── icon-192.png         # App icon
    └── icon-512.png         # App icon (large)
```

## License

MIT
