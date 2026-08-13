#!/usr/bin/env bash
#
# Remove the usbpower REST API service.
#
#   sudo ./service/uninstall.sh
#
set -euo pipefail

UNIT_NAME=usbpower-api.service
UNIT_PATH=/etc/systemd/system/$UNIT_NAME
INSTALL_DIR=/opt/usbpower-api

if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (use sudo)." >&2
    exit 1
fi

if systemctl list-unit-files | grep -q "^$UNIT_NAME"; then
    echo "==> Stopping and disabling $UNIT_NAME"
    systemctl disable --now "$UNIT_NAME" || true
fi

rm -f "$UNIT_PATH"
rm -rf "$INSTALL_DIR"
systemctl daemon-reload

echo "usbpower-api removed."
echo "Note: '$SUDO_USER' was left in the 'dialout' group; remove manually with"
echo "      sudo gpasswd -d $SUDO_USER dialout"
