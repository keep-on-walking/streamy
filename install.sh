#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  Streamy — One-Command Installer
#  Usage:
#    bash install.sh              (from within the streamy directory)
#    curl -fsSL http://YOUR_IP/install.sh | bash   (remote self-install)
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; CYAN='\033[36m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
fail() { echo -e "  ${RED}✖${RESET}  $*"; exit 1; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

# ─── Detect environment ───────────────────────────────────────────────────────
ARCH=$(uname -m)
OS=$(uname -s)
DISTRO=""
[ -f /etc/os-release ] && . /etc/os-release && DISTRO="${ID:-}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   🎵  Streamy Installer               ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
info "Platform: ${OS} ${ARCH} ${DISTRO:+(${DISTRO})}"
info "Install dir: ${INSTALL_DIR}"

# ─── Check OS ─────────────────────────────────────────────────────────────────
if [ "$OS" != "Linux" ]; then
  fail "This installer supports Linux only. For macOS/Windows use Docker: docker compose up"
fi

# ─── Require root for package installs ────────────────────────────────────────
SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo &>/dev/null && SUDO="sudo" || fail "Run as root or install sudo"
fi

apt_install() {
  $SUDO apt-get install -y -qq "$@" 2>/dev/null
}

# ─── 1. System packages (curl, tar, python3) ──────────────────────────────────
step "1/7  Checking system packages"
$SUDO apt-get update -qq 2>/dev/null
apt_install curl tar python3 python3-pip xz-utils 2>/dev/null || true
ok "System packages ready"

# ─── 2. Node.js 20 ────────────────────────────────────────────────────────────
step "2/7  Node.js"
if command -v node &>/dev/null && node -e "process.exit(+process.version.slice(1)<18)" 2>/dev/null; then
  ok "Node.js $(node -v) already installed"
else
  info "Installing Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - 2>/dev/null
  apt_install nodejs
  ok "Node.js $(node -v) installed"
fi

# ─── 3. FFmpeg ────────────────────────────────────────────────────────────────
step "3/7  FFmpeg"
if command -v ffmpeg &>/dev/null; then
  ok "FFmpeg already installed ($(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3))"
else
  info "Installing FFmpeg…"
  apt_install ffmpeg
  ok "FFmpeg installed"
fi

# ─── 4. yt-dlp ────────────────────────────────────────────────────────────────
step "4/7  yt-dlp"
if command -v yt-dlp &>/dev/null; then
  info "Updating yt-dlp ($(yt-dlp --version))…"
  $SUDO yt-dlp -U 2>/dev/null || true
  ok "yt-dlp up to date ($(yt-dlp --version))"
else
  info "Installing yt-dlp…"
  $SUDO curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
       -o /usr/local/bin/yt-dlp
  $SUDO chmod a+rx /usr/local/bin/yt-dlp
  ok "yt-dlp $(yt-dlp --version) installed"
fi

# ─── 5. mediamtx (RTSP server) ────────────────────────────────────────────────
step "5/7  mediamtx (RTSP server)"
MEDIAMTX_VERSION="1.9.1"
BIN_DIR="${INSTALL_DIR}/bin"
mkdir -p "${BIN_DIR}"

if command -v mediamtx &>/dev/null; then
  ok "mediamtx found in PATH"
elif [ -x "${BIN_DIR}/mediamtx" ]; then
  ok "mediamtx already in ${BIN_DIR}"
else
  # Choose the right binary for this architecture
  case "${ARCH}" in
    x86_64)         MTXARCH="amd64"      ;;
    aarch64|arm64)  MTXARCH="arm64v8"    ;;
    armv7l|armv6l)  MTXARCH="armv7"      ;;
    *)              MTXARCH="amd64"      ;;
  esac

  MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${MTXARCH}.tar.gz"
  info "Downloading mediamtx v${MEDIAMTX_VERSION} for ${MTXARCH}…"
  curl -fsSL "${MTX_URL}" -o /tmp/mediamtx.tar.gz
  tar -xzf /tmp/mediamtx.tar.gz -C "${BIN_DIR}" mediamtx 2>/dev/null \
    || tar -xzf /tmp/mediamtx.tar.gz -C "${BIN_DIR}"
  chmod +x "${BIN_DIR}/mediamtx"
  rm -f /tmp/mediamtx.tar.gz
  ok "mediamtx v${MEDIAMTX_VERSION} installed to ${BIN_DIR}"
fi

# ─── 6. npm dependencies ──────────────────────────────────────────────────────
step "6/7  npm dependencies"
cd "${INSTALL_DIR}"
npm install --silent
ok "npm packages installed"

# ─── 7. Optional: unclutter (hide cursor in kiosk mode) ──────────────────────
step "7/7  Optional tools"
if command -v unclutter &>/dev/null; then
  ok "unclutter already installed"
else
  info "Installing unclutter (hides mouse cursor in kiosk mode)…"
  apt_install unclutter 2>/dev/null && ok "unclutter installed" || warn "unclutter unavailable (optional)"
fi

# ─── Detect local IP ──────────────────────────────────────────────────────────
LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')

# ─── systemd service (optional) ───────────────────────────────────────────────
echo ""
read -r -p "  Set up systemd service to auto-start on boot? [y/N] " SETUP_SERVICE
if [[ "${SETUP_SERVICE:-n}" =~ ^[Yy]$ ]]; then
  SERVICE_FILE="/etc/systemd/system/streamy.service"
  $SUDO tee "${SERVICE_FILE}" > /dev/null <<EOF
[Unit]
Description=Streamy Music Player
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable streamy.service
  $SUDO systemctl restart streamy.service
  ok "systemd service installed and started"
  echo ""
  info "Manage with: sudo systemctl {start|stop|restart|status} streamy"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║   ✅  Installation complete!                  ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Start Streamy:${RESET}"
echo -e "    npm start"
echo ""
echo -e "  ${BOLD}Kiosk mode (fullscreen):${RESET}"
echo -e "    bash kiosk.sh"
echo ""
echo -e "  ${BOLD}Web interface:${RESET}"
echo -e "    http://localhost:3000"
[ -n "${LOCAL_IP:-}" ] && echo -e "    http://${LOCAL_IP}:3000  ← share this with phones/remotes"
echo ""
echo -e "  ${BOLD}RTSP stream (for Raspberry Pi display):${RESET}"
[ -n "${LOCAL_IP:-}" ] && echo -e "    rtsp://${LOCAL_IP}:8554/live"
echo ""
echo -e "  ${BOLD}On Raspberry Pi, play the stream:${RESET}"
[ -n "${LOCAL_IP:-}" ] && echo -e "    mpv rtsp://${LOCAL_IP}:8554/live --fs --no-audio"
[ -n "${LOCAL_IP:-}" ] && echo -e "    cvlc rtsp://${LOCAL_IP}:8554/live --fullscreen --no-audio"
echo ""
