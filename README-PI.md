# 📺 Streamy — Raspberry Pi Display Setup

Connect any Raspberry Pi to a TV or monitor via HDMI and have it automatically
display music videos (or a colour visualisation) from your Streamy jukebox.

---

## How it works

```
┌─────────────────────────┐        RTSP stream        ┌──────────────────────┐
│  Streamy Server         │  ─────────────────────►  │  Raspberry Pi        │
│  (Ubuntu PC / NUC)      │  rtsp://IP:8554/live      │  + HDMI Display      │
│                         │                           │                      │
│  • Plays audio          │                           │  • Displays video    │
│  • Streams video via    │                           │  • mpv / VLC /       │
│    mediamtx + FFmpeg    │                           │    omxplayer         │
└─────────────────────────┘                           └──────────────────────┘
```

- **Music video available?** → streams the YouTube video at 720p
- **No video?** → streams a smooth plasma colour animation with track info overlay
- Stream URL updates automatically when songs change — the Pi just plays whatever is live

---

## Step 1 — Install a player on the Pi

### Option A: mpv (recommended, works on Pi 3/4/5)

```bash
sudo apt update && sudo apt install -y mpv
```

### Option B: VLC

```bash
sudo apt update && sudo apt install -y vlc
```

### Option C: omxplayer (Pi 2/3, Raspbian Buster only)

```bash
sudo apt update && sudo apt install -y omxplayer
```

---

## Step 2 — Find your Streamy server IP

On the Streamy server:
```bash
hostname -I | awk '{print $1}'
# e.g. 192.168.1.42
```

Or check the **Display Stream** panel in the Streamy web UI — the full RTSP URL is shown there.

---

## Step 3 — Play the stream

Replace `192.168.1.42` with your Streamy server's IP:

### mpv (best quality, hardware acceleration on Pi 4/5)

```bash
# Play fullscreen, loop forever, no local audio (audio plays on Streamy server)
mpv "rtsp://192.168.1.42:8554/live" \
    --fs \
    --no-audio \
    --loop \
    --rtsp-transport=tcp \
    --cache=no \
    --demuxer-lavf-o=stimeout=5000000
```

### VLC

```bash
cvlc "rtsp://192.168.1.42:8554/live" \
    --fullscreen \
    --no-audio \
    --loop \
    --network-caching=500 \
    --rtsp-tcp
```

### omxplayer (Pi 2/3)

```bash
omxplayer --live --no-osd "rtsp://192.168.1.42:8554/live"
```

---

## Step 4 — Auto-start on Pi boot

### Using a systemd service (recommended)

Create `/etc/systemd/system/streamy-display.service`:

```ini
[Unit]
Description=Streamy Display Player
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/mpv "rtsp://192.168.1.42:8554/live" \
    --fs --no-audio --loop --rtsp-transport=tcp \
    --cache=no --demuxer-lavf-o=stimeout=5000000
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable streamy-display.service
sudo systemctl start streamy-display.service
```

### Using autostart (LXDE / Raspberry Pi OS Desktop)

Add to `/home/pi/.config/autostart/streamy.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Streamy Display
Exec=mpv "rtsp://192.168.1.42:8554/live" --fs --no-audio --loop --rtsp-transport=tcp
X-GNOME-Autostart-enabled=true
```

### Using /etc/rc.local (headless Lite)

Add before `exit 0` in `/etc/rc.local`:

```bash
sleep 10 && mpv "rtsp://192.168.1.42:8554/live" --fs --no-audio --loop --rtsp-transport=tcp &
```

---

## Tips & Troubleshooting

### Stream not connecting?
- Make sure port 8554 is not blocked by a firewall: `sudo ufw allow 8554`
- Test connectivity: `nc -zv 192.168.1.42 8554`
- Check Streamy health: `curl http://192.168.1.42:3000/api/health`

### Video lagging or buffering?
- Use `--rtsp-transport=tcp` (already included above)
- Reduce bitrate on the server by setting `RTSP_BITRATE=1M` in `.env`
- On Pi 3, use `--hwdec=mmal` with mpv for hardware decode

### Hide cursor on Pi desktop?

```bash
sudo apt install -y unclutter
unclutter -idle 0.1 -root &
```

### Black screen between songs?
- This is normal — there's a 1–2 s gap while the stream restarts
- The idle visualisation will show as soon as playback starts

### Use the Pi's audio output instead of Streamy server?
- Remove `--no-audio` from the mpv/VLC command
- The RTSP stream includes a silent audio track for sync purposes; real audio
  plays separately through the browser/Streamy interface

---

## Environment Variables (on Streamy server)

| Variable        | Default | Description                              |
|-----------------|---------|------------------------------------------|
| `RTSP_ENABLED`  | `true`  | Set `false` to disable RTSP completely   |
| `RTSP_PORT`     | `8554`  | RTSP server port                         |
| `RTSP_WIDTH`    | `1280`  | Stream width in pixels                   |
| `RTSP_HEIGHT`   | `720`   | Stream height in pixels                  |
| `RTSP_BITRATE`  | `2M`    | Video bitrate (e.g. `1M`, `4M`)          |

Set these in a `.env` file or pass them to `npm start`:

```bash
RTSP_BITRATE=1M RTSP_HEIGHT=720 npm start
```

---

*The RTSP stream is generated by [mediamtx](https://github.com/bluenviron/mediamtx) + FFmpeg on the Streamy server. The Raspberry Pi just plays whatever is currently live on the stream.*
