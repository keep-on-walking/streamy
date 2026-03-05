#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Streamy — Kiosk Mode Setup (Raspberry Pi)
#
# Configures auto-login and launches Streamy's mpv output
# directly to the framebuffer without a desktop environment.
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

# ─── Disable screen blanking ──────────────────────────────────
echo -e "${CYAN}Disabling screen blanking...${NC}"

# Console blanking
if ! grep -q 'consoleblank=0' /boot/firmware/cmdline.txt 2>/dev/null && \
   ! grep -q 'consoleblank=0' /boot/cmdline.txt 2>/dev/null; then
  CMDLINE=$(find /boot -name cmdline.txt -print -quit 2>/dev/null)
  if [ -n "$CMDLINE" ]; then
    sudo sed -i 's/$/ consoleblank=0/' "$CMDLINE"
    echo -e "${GREEN}✓ Console blanking disabled${NC}"
  fi
fi

# DPMS off
if ! grep -q 'xset.*dpms' /home/$KIOSK_USER/.xprofile 2>/dev/null; then
  echo "xset s off -dpms" >> /home/$KIOSK_USER/.xprofile
  echo -e "${GREEN}✓ DPMS blanking disabled${NC}"
fi

# ─── Auto-login to console ────────────────────────────────────
echo -e "${CYAN}Configuring auto-login...${NC}"

sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf > /dev/null <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF

echo -e "${GREEN}✓ Auto-login configured for $KIOSK_USER on tty1${NC}"

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
echo -e "    1. Auto-login as ${CYAN}$KIOSK_USER${NC}"
echo -e "    2. Start Streamy via systemd"
echo -e "    3. Display QR code / video on the connected screen"
echo ""
echo -e "  ${YELLOW}Reboot to apply: sudo reboot${NC}"
echo ""
