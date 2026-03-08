#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Streamy — Kiosk Mode Setup (Raspberry Pi)
#
# Hides boot messages, login prompts, and console text so the
# display only ever shows Streamy's idle screen or video output.
# Run after install.sh has been completed.
# ─────────────────────────────────────────────────────────────
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}🖥️  Streamy Kiosk Setup${NC}"
echo ""

if [ "$EUID" -eq 0 ]; then
  echo -e "${RED}Please run as your normal user (not root).${NC}"
  exit 1
fi

KIOSK_USER=$(whoami)

# ─── Suppress boot messages ──────────────────────────────────
echo -e "${CYAN}Suppressing boot messages...${NC}"

CMDLINE=$(find /boot -name cmdline.txt -print -quit 2>/dev/null)
if [ -n "$CMDLINE" ]; then
  if ! grep -q 'quiet' "$CMDLINE" 2>/dev/null; then
    sudo sed -i 's/$/ quiet loglevel=0 logo.nologo vt.global_cursor_default=0/' "$CMDLINE"
    echo -e "${GREEN}✓ Boot messages suppressed${NC}"
  else
    echo -e "${GREEN}✓ Already configured${NC}"
  fi

  if ! grep -q 'consoleblank=0' "$CMDLINE" 2>/dev/null; then
    sudo sed -i 's/$/ consoleblank=0/' "$CMDLINE"
  fi
fi

# ─── Hide login prompt ────────────────────────────────────────
echo -e "${CYAN}Hiding login prompt...${NC}"

echo -ne '\033[?25l\033[2J\033[H\033[0;30m\033[40m' | sudo tee /etc/issue > /dev/null
echo -e "${GREEN}✓ Login prompt hidden${NC}"

# ─── Auto-login to console ────────────────────────────────────
echo -e "${CYAN}Configuring auto-login...${NC}"

sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf > /dev/null <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF

echo -e "${GREEN}✓ Auto-login configured for $KIOSK_USER on tty1${NC}"

# ─── Clear screen on login ────────────────────────────────────
echo -e "${CYAN}Setting up screen blanking on login...${NC}"

CLEAR_CMD='if [ "$(tty)" = "/dev/tty1" ]; then echo -ne "\033[?25l\033[2J\033[H\033[0;30m\033[40m"; fi'
if ! grep -q 'dev/tty1.*033' /home/$KIOSK_USER/.bash_profile 2>/dev/null; then
  # Remove old unconditional version if present
  sed -i '/033\[?25l.*033\[40m/d' /home/$KIOSK_USER/.bash_profile 2>/dev/null
  echo "$CLEAR_CMD" >> /home/$KIOSK_USER/.bash_profile
  echo -e "${GREEN}✓ Screen clear on login added (tty1 only)${NC}"
else
  echo -e "${GREEN}✓ Already configured${NC}"
fi

# ─── Disable screen blanking (DPMS) ──────────────────────────
if ! grep -q 'xset.*dpms' /home/$KIOSK_USER/.xprofile 2>/dev/null; then
  echo "xset s off -dpms 2>/dev/null" >> /home/$KIOSK_USER/.xprofile
fi

# ─── HDMI force hotplug ───────────────────────────────────────
echo -e "${CYAN}Configuring HDMI output...${NC}"

CONFIG_TXT=$(find /boot -name config.txt -print -quit 2>/dev/null)
if [ -n "$CONFIG_TXT" ]; then
  if ! grep -q 'hdmi_force_hotplug=1' "$CONFIG_TXT" 2>/dev/null; then
    echo "hdmi_force_hotplug=1" | sudo tee -a "$CONFIG_TXT" > /dev/null
    echo -e "${GREEN}✓ HDMI force hotplug enabled${NC}"
  else
    echo -e "${GREEN}✓ HDMI already configured${NC}"
  fi
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Kiosk setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  On next boot, the Pi will:"
echo -e "    1. Boot silently (no kernel messages)"
echo -e "    2. Auto-login as ${CYAN}$KIOSK_USER${NC} with blank screen"
echo -e "    3. Start Streamy via systemd"
echo -e "    4. Display QR code / video on the connected screen"
echo ""
echo -e "  ${YELLOW}Reboot to apply: sudo reboot${NC}"
echo ""
