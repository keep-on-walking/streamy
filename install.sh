#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Streamy — Jukebox Installer
# Installs all dependencies, configures platform, and sets up
# systemd service for automatic startup.
# ─────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="streamy"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_FILE="${SCRIPT_DIR}/streamy-config.json"

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
PURPLE='\033[0;35m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}🎵  Streamy Installer${NC}"
echo -e "${PURPLE}────────────────────${NC}"
echo ""

# ─── Must run as current user (not root) ──────────────────────
if [ "$EUID" -eq 0 ]; then
  echo -e "${RED}Please run as your normal user (not root).${NC}"
  echo "The installer will use sudo where needed."
  exit 1
fi

INSTALL_USER=$(whoami)
INSTALL_HOME=$(eval echo ~$INSTALL_USER)

# ─── Platform selection ───────────────────────────────────────
echo -e "${CYAN}What platform are you installing on?${NC}"
echo ""
echo "  1) Linux PC (desktop/laptop with Intel/AMD GPU)"
echo "  2) Raspberry Pi 5"
echo ""
read -p "Enter choice [1/2]: " PLATFORM_CHOICE

case "$PLATFORM_CHOICE" in
  2)
    PLATFORM="pi5"
    MAX_HEIGHT=1080
    echo ""
    echo -e "${CYAN}Pi 5 display output mode:${NC}"
    echo ""
    echo "  1) DRM (kiosk mode — no desktop, mpv renders directly to screen)"
    echo "  2) X11 (with desktop environment — LXDE, Openbox, etc.)"
    echo ""
    read -p "Enter choice [1/2]: " PI_DISPLAY
    if [ "$PI_DISPLAY" = "2" ]; then
      MPV_VO="gpu"
      MPV_HWDEC="drm-copy"
      MPV_EXTRA='["--gpu-context=x11egl", "--ao=alsa"]'
      NEEDS_DISPLAY=true
    else
      MPV_VO="drm"
      MPV_HWDEC="drm-copy"
      MPV_EXTRA='["--ao=alsa"]'
      NEEDS_DISPLAY=false
    fi
    ;;
  *)
    PLATFORM="pc"
    MAX_HEIGHT=1080
    MPV_VO=""
    MPV_HWDEC="auto-safe"
    MPV_EXTRA='["--gpu-context=wayland"]'
    NEEDS_DISPLAY=true
    ;;
esac

echo ""
echo -e "${GREEN}✓ Platform: ${PLATFORM}${NC}"
echo -e "${GREEN}✓ Max video: ${MAX_HEIGHT}p${NC}"
echo ""

# ─── Install system dependencies ──────────────────────────────
echo -e "${CYAN}Installing system dependencies...${NC}"

sudo apt update -qq

# Node.js
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Installing Node.js...${NC}"
  if [ "$PLATFORM" = "pi5" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
  else
    sudo apt install -y nodejs npm
  fi
else
  echo -e "${GREEN}✓ Node.js $(node --version) already installed${NC}"
fi

# mpv
if ! command -v mpv &>/dev/null; then
  echo -e "${YELLOW}Installing mpv...${NC}"
  sudo apt install -y mpv
else
  echo -e "${GREEN}✓ mpv already installed${NC}"
fi

# ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo -e "${YELLOW}Installing ffmpeg...${NC}"
  sudo apt install -y ffmpeg
else
  echo -e "${GREEN}✓ ffmpeg already installed${NC}"
fi

# yt-dlp
if ! command -v yt-dlp &>/dev/null; then
  echo -e "${YELLOW}Installing yt-dlp...${NC}"
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp
  sudo chmod a+rx /usr/bin/yt-dlp
else
  echo -e "${GREEN}✓ yt-dlp $(yt-dlp --version) already installed${NC}"
  # Update to latest
  echo -e "${YELLOW}Checking for yt-dlp updates...${NC}"
  sudo yt-dlp -U 2>&1 | tail -1
fi

# Deno (JavaScript runtime required by yt-dlp for YouTube format extraction)
if ! command -v deno &>/dev/null; then
  echo -e "${YELLOW}Installing Deno (required by yt-dlp)...${NC}"
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="$INSTALL_HOME/.deno"
  export PATH="$DENO_INSTALL/bin:$PATH"
  if command -v deno &>/dev/null; then
    echo -e "${GREEN}✓ Deno $(deno --version | head -1) installed${NC}"
  else
    echo -e "${YELLOW}⚠ Deno install may need a shell restart${NC}"
  fi
else
  echo -e "${GREEN}✓ Deno $(deno --version | head -1) already installed${NC}"
fi

# socat (for debugging)
if ! command -v socat &>/dev/null; then
  sudo apt install -y socat
fi

# fbi (framebuffer image viewer, for DRM loading screen)
if [ "$PLATFORM" = "pi5" ] && [ "$NEEDS_DISPLAY" = false ]; then
  if ! command -v fbi &>/dev/null; then
    echo -e "${YELLOW}Installing fbi (framebuffer tools)...${NC}"
    sudo apt install -y fbi
  else
    echo -e "${GREEN}✓ fbi already installed${NC}"
  fi
fi

# ─── PC: force 1080p@60Hz display output ──────────────────────
if [ "$PLATFORM" = "pc" ]; then
  echo ""
  echo -e "${CYAN}Configuring display output for PC...${NC}"

  # Install gnome-randr for Wayland display control
  if ! pip3 show gnome-randr &>/dev/null 2>&1; then
    echo -e "${YELLOW}Installing gnome-randr...${NC}"
    pip3 install gnome-randr --break-system-packages 2>/dev/null || true
  fi

  # Create display setup script
  DISPLAY_SCRIPT="$INSTALL_HOME/.config/streamy-display.sh"
  mkdir -p "$INSTALL_HOME/.config"
  cat > "$DISPLAY_SCRIPT" <<'DISPEOF'
#!/bin/bash
# Streamy — Force 1080p@60Hz on connected display
# Runs at login via autostart to ensure consistent playback performance

sleep 3  # Wait for display to be fully initialised

# Try gnome-randr first (Wayland)
if command -v gnome-randr &>/dev/null; then
  # Find connected output and set 1920x1080@60
  gnome-randr modify --mode 1920x1080@60.000 2>/dev/null && exit 0
fi

# Fallback: xrandr (X11)
if command -v xrandr &>/dev/null; then
  OUTPUT=$(xrandr | grep " connected" | awk '{print $1}' | head -1)
  if [ -n "$OUTPUT" ]; then
    xrandr --output "$OUTPUT" --mode 1920x1080 --rate 60 2>/dev/null && exit 0
    # If 60Hz mode not available, add it as a custom mode
    xrandr --newmode "1920x1080_60" 173.00 1920 2048 2248 2576 1080 1083 1088 1120 -hsync +vsync 2>/dev/null
    xrandr --addmode "$OUTPUT" "1920x1080_60" 2>/dev/null
    xrandr --output "$OUTPUT" --mode "1920x1080_60" 2>/dev/null
  fi
fi
DISPEOF
  chmod +x "$DISPLAY_SCRIPT"
  echo -e "${GREEN}✓ Display setup script created${NC}"

  # Create GNOME autostart entry
  AUTOSTART_DIR="$INSTALL_HOME/.config/autostart"
  mkdir -p "$AUTOSTART_DIR"
  cat > "$AUTOSTART_DIR/streamy-display.desktop" <<AUTOEOF
[Desktop Entry]
Type=Application
Name=Streamy Display Setup
Exec=$DISPLAY_SCRIPT
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=Force 1080p@60Hz for Streamy playback
AUTOEOF
  echo -e "${GREEN}✓ Display autostart configured (1080p@60Hz on login)${NC}"
fi

echo ""

# ─── Install Node.js dependencies ─────────────────────────────
echo -e "${CYAN}Installing Node.js packages...${NC}"
cd "$SCRIPT_DIR"
npm install --production
echo ""

# ─── Write platform config ────────────────────────────────────
if [ -f "$CONFIG_FILE" ]; then
  echo -e "${YELLOW}Existing config found — updating platform settings only...${NC}"
  # Use node to merge platform config into existing
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
    cfg.platform = {
      type: '$PLATFORM',
      maxHeight: $MAX_HEIGHT,
      mpvVO: '$MPV_VO',
      mpvHwdec: '$MPV_HWDEC',
      mpvExtraArgs: $MPV_EXTRA,
    };
    if (!cfg.display) cfg.display = { mode: 'video', width: 1920, height: 1080 };
    if (!cfg.lyrics) cfg.lyrics = { showOnScreen: true };
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
    console.log('✓ Platform config updated');
  "
else
  echo -e "${CYAN}Creating config...${NC}"
  cat > "$CONFIG_FILE" <<JSONEOF
{
  "youtube": {
    "authMethod": "none",
    "browser": "firefox",
    "loggedIn": false,
    "accountName": "",
    "lastChecked": null
  },
  "platform": {
    "type": "$PLATFORM",
    "maxHeight": $MAX_HEIGHT,
    "mpvVO": "$MPV_VO",
    "mpvHwdec": "$MPV_HWDEC",
    "mpvExtraArgs": $MPV_EXTRA
  },
  "display": {
    "mode": "video",
    "width": 1920,
    "height": 1080
  },
  "playback": {
    "defaultVolume": 80
  },
  "lyrics": {
    "showOnScreen": true
  }
}
JSONEOF
  echo -e "${GREEN}✓ Config created${NC}"
fi

echo ""

# ─── Detect display environment ───────────────────────────────
ENV_LINES="Environment=NODE_ENV=production\nEnvironment=PORT=3000"

# Add deno to PATH for yt-dlp JS challenge solving
DENO_PATH="$INSTALL_HOME/.deno/bin"
if [ -d "$DENO_PATH" ]; then
  ENV_LINES="${ENV_LINES}\nEnvironment=PATH=${DENO_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo -e "${GREEN}✓ Deno added to service PATH${NC}"
fi

if [ "$NEEDS_DISPLAY" = true ]; then
  echo -e "${CYAN}Detecting display environment...${NC}"

  # Try to find DISPLAY and WAYLAND_DISPLAY from current session
  if [ -n "$DISPLAY" ]; then
    ENV_LINES="${ENV_LINES}\nEnvironment=DISPLAY=$DISPLAY"
    echo -e "${GREEN}✓ DISPLAY=$DISPLAY${NC}"
  elif [ -f "/tmp/.X11-unix/X0" ] || [ -S "/tmp/.X11-unix/X0" ]; then
    ENV_LINES="${ENV_LINES}\nEnvironment=DISPLAY=:0"
    echo -e "${GREEN}✓ DISPLAY=:0 (detected X11)${NC}"
  fi

  if [ -S "/run/user/$(id -u)/wayland-0" ]; then
    ENV_LINES="${ENV_LINES}\nEnvironment=WAYLAND_DISPLAY=wayland-0\nEnvironment=XDG_RUNTIME_DIR=/run/user/$(id -u)"
    echo -e "${GREEN}✓ Wayland session detected${NC}"
  fi
fi

echo ""

# ─── DRM mode: allow passwordless chvt for display blanking ───
if [ "$PLATFORM" = "pi5" ] && [ "$NEEDS_DISPLAY" = false ]; then
  echo -e "${CYAN}Configuring display blanking permissions...${NC}"
  echo "$INSTALL_USER ALL=(ALL) NOPASSWD: /usr/bin/chvt, /usr/bin/tee" | sudo tee /etc/sudoers.d/streamy-chvt > /dev/null
  sudo chmod 440 /etc/sudoers.d/streamy-chvt
  echo -e "${GREEN}✓ Passwordless chvt/tee enabled${NC}"
fi

echo ""

# ─── Create systemd service ───────────────────────────────────
echo -e "${CYAN}Setting up systemd service...${NC}"

sudo tee "$SERVICE_FILE" > /dev/null <<SERVICEEOF
[Unit]
Description=Streamy Music Player
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INSTALL_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/node ${SCRIPT_DIR}/src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
$(echo -e "$ENV_LINES")

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
echo -e "${GREEN}✓ Service created${NC}"

# ─── Enable and start ─────────────────────────────────────────
echo ""
read -p "Start Streamy now and enable on boot? [Y/n]: " START_NOW
if [ "${START_NOW,,}" != "n" ]; then
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2

  # Check if it started
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    IP=$(hostname -I | awk '{print $1}')
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  🎵  Streamy is running!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  Master:  ${CYAN}http://${IP}:3000${NC}"
    echo -e "  Remote:  ${CYAN}http://${IP}:3000/remote${NC}"
    echo ""
    echo -e "  Platform: ${PURPLE}${PLATFORM}${NC} (max ${MAX_HEIGHT}p)"
    echo ""
    echo -e "  ${YELLOW}Commands:${NC}"
    echo -e "    sudo systemctl stop streamy     # Stop"
    echo -e "    sudo systemctl start streamy    # Start"
    echo -e "    sudo systemctl restart streamy  # Restart"
    echo -e "    sudo journalctl -u streamy -f   # View logs"
    echo ""
    if [ "$PLATFORM" = "pc" ]; then
      echo -e "  ${YELLOW}Note:${NC} Display will be set to 1080p@60Hz on next login."
      echo -e "  To apply now without rebooting, run:"
      echo -e "    $INSTALL_HOME/.config/streamy-display.sh"
      echo ""
    fi
  else
    echo -e "${RED}Service failed to start. Check logs:${NC}"
    echo "  sudo journalctl -u streamy -n 20 --no-pager"
  fi
else
  echo -e "${YELLOW}Skipped. Start manually with: sudo systemctl start streamy${NC}"
fi

echo -e "${GREEN}Done!${NC}"
echo ""
