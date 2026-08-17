#!/usr/bin/env bash
#
# Install the usbpower REST API as a systemd service.
#
#   sudo ./service/install.sh [--port /dev/ttyACM0] [--listen-port 9090]
#                             [--host 0.0.0.0] [--user <name>]
#
# Uninstall with ./service/uninstall.sh
#
set -euo pipefail

INSTALL_DIR=/opt/usbpower-api
UNIT_NAME=usbpower-api.service
UNIT_PATH=/etc/systemd/system/$UNIT_NAME

# Default to the stable udev symlink, not a bare /dev/ttyACM0. ttyACM numbers
# are assigned in plug order and are shared with other USB-CDC hardware such
# as Pixhawk flight controllers -- see udev/99-usbpower-symlink.rules.
SERIAL_PORT=/dev/usbpower
LISTEN_PORT=9090
BIND_HOST=0.0.0.0
RUN_USER="${SUDO_USER:-$USER}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)        SERIAL_PORT="$2"; shift 2 ;;
        --listen-port) LISTEN_PORT="$2"; shift 2 ;;
        --host)        BIND_HOST="$2";   shift 2 ;;
        --user)        RUN_USER="$2";    shift 2 ;;
        -h|--help)     sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (use sudo)." >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking prerequisites"
if ! command -v python3 >/dev/null; then
    echo "python3 not found; install it first." >&2
    exit 1
fi
if ! python3 -c "import serial" 2>/dev/null; then
    echo "pyserial not found. Install it with one of:" >&2
    echo "    sudo apt install python3-serial" >&2
    echo "    sudo pip3 install pyserial" >&2
    exit 1
fi

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    echo "user '$RUN_USER' does not exist" >&2
    exit 1
fi

echo "==> Ensuring '$RUN_USER' can access the serial port"
if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx dialout; then
    echo "    adding '$RUN_USER' to the 'dialout' group"
    usermod -aG dialout "$RUN_USER"
    echo "    NOTE: '$RUN_USER' must log out and back in for this to apply to"
    echo "          their interactive shells (the service itself is fine)."
fi

if [[ ! -e "$SERIAL_PORT" ]]; then
    echo "    WARNING: $SERIAL_PORT does not exist right now."
    if [[ "$SERIAL_PORT" == /dev/usbpower ]]; then
        echo "             Install the stable-name rule first:"
        echo "                 sudo cp udev/99-usbpower-symlink.rules /etc/udev/rules.d/"
        echo "                 sudo udevadm control --reload-rules && sudo udevadm trigger"
        echo "             (edit the rule's serial number to match your board)"
    fi
    echo "             The service will retry until the board appears."
fi

# Warn loudly about pointing the service at a shared, order-dependent name.
if [[ "$SERIAL_PORT" =~ ^/dev/tty(ACM|USB)[0-9]+$ ]]; then
    echo
    echo "    WARNING: $SERIAL_PORT is assigned in plug order and is shared with"
    echo "             other USB serial hardware -- Pixhawk/PX4 flight"
    echo "             controllers, 3D printers, USB-serial adapters. If another"
    echo "             device claims this name, THIS SERVICE WILL OPEN IT, hold"
    echo "             it exclusively, and write relay commands into it."
    echo "             Prefer a stable name: see udev/99-usbpower-symlink.rules"
    echo
fi

echo "==> Installing to $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$SRC_DIR/usbpower_api.py" "$INSTALL_DIR/usbpower_api.py"
if [[ -d "$SRC_DIR/static" ]]; then
    install -d -m 0755 "$INSTALL_DIR/static"
    while IFS= read -r -d '' asset; do
        rel="${asset#$SRC_DIR/static/}"
        install -d -m 0755 "$INSTALL_DIR/static/$(dirname "$rel")"
        install -m 0644 "$asset" "$INSTALL_DIR/static/$rel"
    done < <(find "$SRC_DIR/static" -type f -print0)
fi

echo "==> Writing $UNIT_PATH"
# systemd tracks .device units by real kernel devnode, not by udev symlink.
# Only add an ordering dependency when the configured port is a real node.
if [[ "$SERIAL_PORT" =~ ^/dev/tty(ACM|USB)[0-9]+$ ]]; then
    DEVICE_UNIT="$(systemd-escape --path "$SERIAL_PORT").device"
    DEVICE_DEPS="After=$DEVICE_UNIT\nWants=$DEVICE_UNIT"
else
    DEVICE_DEPS="# (no .device dependency: '$SERIAL_PORT' is a symlink or custom path)"
fi

sed -e "s|USBPOWER_USER|$RUN_USER|" \
    -e "s|--port /dev/usbpower|--port $SERIAL_PORT|" \
    -e "s|--host 0.0.0.0|--host $BIND_HOST|" \
    -e "s|--listen-port 9090|--listen-port $LISTEN_PORT|" \
    -e "s|# USBPOWER_DEVICE_DEPS|$DEVICE_DEPS|" \
    "$SRC_DIR/$UNIT_NAME" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

echo "==> Enabling and starting the service"
systemctl daemon-reload
systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"

DISPLAY_HOST="$BIND_HOST"
if [[ "$BIND_HOST" == "0.0.0.0" || "$BIND_HOST" == "::" ]]; then
    DISPLAY_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
    DISPLAY_HOST="${DISPLAY_HOST:-$(hostname -f 2>/dev/null || hostname)}"
fi

sleep 4
if systemctl is-active --quiet "$UNIT_NAME"; then
    echo
    echo "usbpower-api is running."
    echo "  serial port : $SERIAL_PORT"
    echo "  bind        : $BIND_HOST:$LISTEN_PORT"
    echo "  dashboard   : http://$DISPLAY_HOST:$LISTEN_PORT/"
    echo "  API         : http://$DISPLAY_HOST:$LISTEN_PORT/api"
    echo
    echo "Try it:"
    echo "  curl -s http://$DISPLAY_HOST:$LISTEN_PORT/api/status | jq"
    echo
    echo "Run the full example walkthrough:"
    echo "  ./examples/api_demo.sh http://$DISPLAY_HOST:$LISTEN_PORT"
else
    echo
    echo "Service failed to start. Recent logs:" >&2
    journalctl -u "$UNIT_NAME" -n 30 --no-pager >&2
    exit 1
fi

if [[ "$BIND_HOST" != "127.0.0.1" && "$BIND_HOST" != "localhost" ]]; then
    echo
    echo "WARNING: bound to $BIND_HOST, which is reachable off this machine."
    echo "         The API has no authentication and switches physical relays."
    echo "         Put it behind a reverse proxy with TLS + auth, or firewall it."
fi
