#!/usr/bin/env python3
"""
usbpower_api.py -- REST API front end for the usb_crtl_power_x4 Arduino sketch.

Translates HTTP requests into the sketch's UART command language and returns
the device's replies as JSON. Uses only the Python standard library plus
pyserial, so there is nothing to install beyond python3-serial.

The serial port is a single exclusive resource: while this service is running
it holds /dev/ttyACM0 open, and a terminal program (picocom, GTKTerm, the
Arduino Serial Monitor) cannot use the port at the same time. Stop the service
before opening a terminal, and stop it before flashing new firmware.

Binds to 127.0.0.1 by default. This service switches physical relays that may
be controlling mains-voltage loads -- do not expose it to an untrusted network
without putting authentication and TLS in front of it.
"""

import argparse
import errno
import json
import re
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import serial

# ----------------------------------------------------------------------------
# Serial layer
# ----------------------------------------------------------------------------

# The sketch does not emit a prompt or any end-of-response sentinel, so a reply
# is identified by "the device sent something, then went quiet". These control
# that heuristic.
# Exit code for unrecoverable configuration errors (port in use, no permission
# to bind). The systemd unit lists this in RestartPreventExitStatus so the
# service fails once with a clear message instead of restarting forever.
EXIT_CONFIG = 78           # EX_CONFIG, by convention

FIRST_BYTE_TIMEOUT = 2.0   # how long to wait for a reply to start arriving
QUIET_GAP = 0.30           # silence this long after data == reply is complete
MAX_REPLY_TIME = 6.0       # hard ceiling on collecting one reply

# Lines the device emits on its own (timer expiry, cycle resume) rather than as
# a direct answer to a command. Captured into the async event log.
ASYNC_PATTERNS = (
    re.compile(r"^D(\d+) -> (ON|OFF)$"),
)


class DeviceError(Exception):
    """Raised when the device cannot be reached or does not answer."""


class Device:
    """Owns the serial port and serialises command/response round trips."""

    def __init__(self, port, baud=115200, boot_wait=2.5, retries=1):
        self.port_name = port
        self.baud = baud
        self.retries = retries
        self._lock = threading.Lock()
        self._rx = deque()          # complete lines not yet consumed
        self._rx_event = threading.Event()
        self._partial = b""
        self.events = deque(maxlen=200)   # unsolicited device output
        self.connected_at = None

        self._serial = serial.Serial(port, baud, timeout=0.1)
        # Opening the port toggles DTR, which resets the board. Wait for the
        # sketch to boot, then discard its banner.
        time.sleep(boot_wait)
        try:
            self._serial.reset_input_buffer()
        except Exception:
            pass
        self.connected_at = time.time()

        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- background reader ---------------------------------------------------

    def _read_loop(self):
        while True:
            try:
                chunk = self._serial.read(256)
            except Exception:
                time.sleep(0.5)
                continue
            if not chunk:
                continue
            self._partial += chunk
            while b"\n" in self._partial:
                raw, self._partial = self._partial.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").strip("\r\n ")
                if line:
                    self._rx.append((time.time(), line))
                    self._rx_event.set()

    def _drain(self):
        """Discard buffered lines, recording any that look like async events."""
        while self._rx:
            _, line = self._rx.popleft()
            for pat in ASYNC_PATTERNS:
                if pat.match(line):
                    self.events.append({"t": time.time(), "line": line})
                    break
        self._rx_event.clear()

    # -- command execution ---------------------------------------------------

    def _collect(self):
        lines = []
        started = time.time()
        # Wait for the reply to begin.
        while not self._rx and (time.time() - started) < FIRST_BYTE_TIMEOUT:
            self._rx_event.wait(0.05)
            self._rx_event.clear()
        # Collect until the device goes quiet.
        last = time.time()
        while (time.time() - started) < MAX_REPLY_TIME:
            if self._rx:
                _, line = self._rx.popleft()
                lines.append(line)
                last = time.time()
            else:
                if lines and (time.time() - last) > QUIET_GAP:
                    break
                if not lines and (time.time() - started) > FIRST_BYTE_TIMEOUT:
                    break
                time.sleep(0.02)
        return lines

    def send(self, command):
        """Send one command line, return the device's reply as a list of lines.

        Retries once on an empty reply. Empty replies are rare but do happen
        when the board sits behind a chain of USB hubs whose links autosuspend
        (see udev/README.md); the device itself does not miss the command.
        """
        command = command.strip()
        if not command:
            raise DeviceError("empty command")
        if "\n" in command or "\r" in command:
            raise DeviceError("command must be a single line")

        with self._lock:
            attempts = self.retries + 1
            for attempt in range(attempts):
                self._drain()
                try:
                    self._serial.write((command + "\n").encode())
                    self._serial.flush()
                except Exception as exc:
                    raise DeviceError(f"serial write failed: {exc}") from exc
                lines = self._collect()
                if lines:
                    return lines
            raise DeviceError(
                f"no reply from device after {attempts} attempt(s)")

    def recent_events(self, limit=50):
        return list(self.events)[-limit:]


# ----------------------------------------------------------------------------
# Reply parsing
# ----------------------------------------------------------------------------

RE_STATUS = re.compile(
    r"^D(\d+):\s+(ON|OFF)\s+for\s+(\d+)s\s*(?:\[(.+)\])?$")
RE_CHANGE = re.compile(r"^D(\d+)\s+->\s+(ON|OFF)$")
RE_NOOP = re.compile(r"^D(\d+)\s+already\s+(ON|OFF)$")
RE_PENDING = re.compile(r"^(auto-OFF|cycle: ON) in (\d+)s$")
RE_DUMP_COUNT = re.compile(r"^\((\d+)/(\d+) entries shown\)$")


def parse_pin_states(lines):
    """Extract structured pin state from `status` output."""
    pins = []
    for line in lines:
        m = RE_STATUS.match(line)
        if not m:
            continue
        pin, state, secs, pending = m.groups()
        entry = {
            "pin": f"D{pin}",
            "number": int(pin),
            "state": state,
            "seconds_in_state": int(secs),
            "pending": None,
        }
        if pending:
            pm = RE_PENDING.match(pending.strip())
            if pm:
                entry["pending"] = {
                    "action": "auto_off" if pm.group(1).startswith("auto")
                              else "cycle_on",
                    "seconds_remaining": int(pm.group(2)),
                }
            else:
                entry["pending"] = {"raw": pending.strip()}
        pins.append(entry)
    return pins


def parse_changes(lines):
    """Extract state transitions and no-ops from on/off/set/toggle output."""
    changes = []
    for line in lines:
        m = RE_CHANGE.match(line)
        if m:
            changes.append({"pin": f"D{m.group(1)}", "state": m.group(2),
                            "changed": True})
            continue
        m = RE_NOOP.match(line)
        if m:
            changes.append({"pin": f"D{m.group(1)}", "state": m.group(2),
                            "changed": False})
    return changes


def parse_log(lines):
    """Extract log records from `dump` output."""
    entries = []
    shown = total = None
    for line in lines:
        m = RE_DUMP_COUNT.match(line.strip())
        if m:
            shown, total = int(m.group(1)), int(m.group(2))
            continue
        parts = line.split("\t")
        if len(parts) == 4 and parts[0].isdigit():
            pin = parts[1].lstrip("Dd")
            entries.append({
                "t_ms": int(parts[0]),
                "pin": f"D{pin}",
                "event": parts[2],
                "prev_duration_s": int(parts[3]) if parts[3].isdigit() else None,
            })
    return entries, shown, total


def parse_config(lines):
    cfg = {}
    for line in lines:
        if "=" in line:
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip()
            if v.isdigit():
                cfg[k] = int(v)
            elif v.lower() in ("true", "false"):
                cfg[k] = v.lower() == "true"
            else:
                cfg[k] = v
    return cfg


def is_error(lines):
    return any(l.startswith("ERR:") for l in lines)


# ----------------------------------------------------------------------------
# Pin token validation
# ----------------------------------------------------------------------------

RE_PIN_TOKEN = re.compile(r"^[dDaA]?\d{1,2}$")


def normalise_pin(token):
    """Validate a pin token before it reaches the device."""
    if not token or not RE_PIN_TOKEN.match(token):
        raise ValueError(f"invalid pin token: {token!r}")
    return token.lower()


def positive_int(value, name, maximum=65535):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be an integer")
    if n < 1 or n > maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return n


# ----------------------------------------------------------------------------
# HTTP layer
# ----------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "usbpower-api/1.0"
    device = None       # injected by main()
    started_at = None

    # -- helpers -------------------------------------------------------------

    def _json(self, status, payload):
        body = json.dumps(payload, indent=2).encode() + b"\n"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON body: {exc}")
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def _run(self, command, parser=None):
        """Execute a device command and emit a JSON response."""
        try:
            lines = self.device.send(command)
        except DeviceError as exc:
            return self._json(503, {"ok": False, "command": command,
                                    "error": str(exc)})
        payload = {"ok": not is_error(lines), "command": command,
                   "raw": lines}
        if is_error(lines):
            payload["error"] = next(l for l in lines if l.startswith("ERR:"))
            return self._json(400, payload)
        if parser:
            payload.update(parser(lines))
        return self._json(200, payload)

    def log_message(self, fmt, *args):   # quieter default logging
        print(f"{self.address_string()} {fmt % args}", flush=True)

    # -- routing -------------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = parse_qs(url.query)

        if path in ("/", "/api"):
            return self._json(200, {
                "service": "usbpower-api",
                "endpoints": ENDPOINTS,
            })

        if path == "/api/health":
            return self._json(200, {
                "ok": True,
                "port": self.device.port_name,
                "baud": self.device.baud,
                "uptime_s": round(time.time() - self.started_at, 1),
                "device_connected_s": round(
                    time.time() - self.device.connected_at, 1),
            })

        if path == "/api/help":
            return self._run("help")

        if path == "/api/config":
            return self._run("config", lambda l: {"config": parse_config(l)})

        if path == "/api/pins":
            return self._run("status", lambda l: {"pins": parse_pin_states(l)})

        if path == "/api/status":
            return self._run("status", lambda l: {"pins": parse_pin_states(l)})

        if path == "/api/events":
            limit = int(query.get("limit", [50])[0])
            return self._json(200, {"ok": True,
                                    "events": self.device.recent_events(limit)})

        m = re.match(r"^/api/pins/([^/]+)$", path)
        if m:
            try:
                pin = normalise_pin(m.group(1))
            except ValueError as exc:
                return self._json(400, {"ok": False, "error": str(exc)})
            return self._run(f"status {pin}",
                             lambda l: {"pins": parse_pin_states(l)})

        if path == "/api/log":
            pin = query.get("pin", [None])[0]
            limit = query.get("limit", [None])[0]
            if pin:
                try:
                    cmd = f"dump {normalise_pin(pin)}"
                except ValueError as exc:
                    return self._json(400, {"ok": False, "error": str(exc)})
            elif limit:
                try:
                    cmd = f"dump {positive_int(limit, 'limit')}"
                except ValueError as exc:
                    return self._json(400, {"ok": False, "error": str(exc)})
            else:
                cmd = "dump"

            def parse(lines):
                entries, shown, total = parse_log(lines)
                return {"entries": entries, "shown": shown, "total": total}
            return self._run(cmd, parse)

        return self._json(404, {"ok": False, "error": f"no route for {path}"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            body = self._body_json()
        except ValueError as exc:
            return self._json(400, {"ok": False, "error": str(exc)})

        if path == "/api/reset":
            return self._run("reset", lambda l: {"changes": parse_changes(l)})

        if path == "/api/raw":
            command = body.get("command")
            if not isinstance(command, str) or not command.strip():
                return self._json(400, {
                    "ok": False,
                    "error": "body must be {\"command\": \"<device command>\"}"})
            return self._run(command.strip())

        # All pins at once: /api/pins/on | /api/pins/off
        m = re.match(r"^/api/pins/(on|off)$", path)
        if m:
            return self._run(f"set {m.group(1)}",
                             lambda l: {"changes": parse_changes(l)})

        # Single pin: /api/pins/<pin>/<action>
        m = re.match(r"^/api/pins/([^/]+)/(on|off|toggle|cycle)$", path)
        if m:
            try:
                pin = normalise_pin(m.group(1))
            except ValueError as exc:
                return self._json(400, {"ok": False, "error": str(exc)})
            action = m.group(2)
            seconds = body.get("seconds")

            if action == "on":
                cmd = f"on {pin}"
                if seconds is not None:
                    try:
                        cmd += f" {positive_int(seconds, 'seconds')}"
                    except ValueError as exc:
                        return self._json(400, {"ok": False, "error": str(exc)})
            elif action == "cycle":
                cmd = f"cycle {pin}"
                if seconds is not None:
                    try:
                        cmd += f" {positive_int(seconds, 'seconds')}"
                    except ValueError as exc:
                        return self._json(400, {"ok": False, "error": str(exc)})
            else:
                if seconds is not None:
                    return self._json(400, {
                        "ok": False,
                        "error": f"'{action}' does not take a seconds value"})
                cmd = f"{action} {pin}"

            return self._run(cmd, lambda l: {"changes": parse_changes(l)})

        return self._json(404, {"ok": False, "error": f"no route for {path}"})

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/api/log":
            return self._run("log clear")
        return self._json(404, {"ok": False, "error": f"no route for {path}"})


ENDPOINTS = [
    "GET    /api/health              service and link health",
    "GET    /api/help                device's own command help text",
    "GET    /api/config              device configuration + free RAM",
    "GET    /api/status              state of all pins",
    "GET    /api/pins                state of all pins",
    "GET    /api/pins/<pin>          state of one pin",
    "POST   /api/pins/on             all pins ON",
    "POST   /api/pins/off            all pins OFF",
    "POST   /api/pins/<pin>/on       pin ON      body: {\"seconds\": N} auto-off",
    "POST   /api/pins/<pin>/off      pin OFF",
    "POST   /api/pins/<pin>/toggle   flip pin",
    "POST   /api/pins/<pin>/cycle    power-cycle body: {\"seconds\": N} off time",
    "GET    /api/log                 event log; ?limit=N or ?pin=d4",
    "DELETE /api/log                 clear event log",
    "GET    /api/events              unsolicited device events (timers firing)",
    "POST   /api/reset               all pins OFF, cancel timers",
    "POST   /api/raw                 body: {\"command\": \"...\"} passthrough",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default="/dev/ttyACM0",
                    help="serial device (default: /dev/ttyACM0)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default: 127.0.0.1; see security note)")
    ap.add_argument("--listen-port", type=int, default=9090,
                    help="HTTP port (default: 9090)")
    ap.add_argument("--boot-wait", type=float, default=2.5,
                    help="seconds to wait for the sketch to boot after the "
                         "port is opened (opening resets the board)")
    args = ap.parse_args()

    # Claim the HTTP port BEFORE touching the serial port. Opening the serial
    # port toggles DTR and resets the board, so if the HTTP port is taken we
    # must fail before doing that -- otherwise a port conflict plus systemd's
    # restart loop would reset the Arduino every few seconds indefinitely.
    try:
        httpd = ThreadingHTTPServer((args.host, args.listen_port), Handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(f"ERROR: {args.host}:{args.listen_port} is already in use by "
                  f"another program.\n"
                  f"       Pick a free port with --listen-port, e.g. 8081, or stop\n"
                  f"       whatever is holding it:  ss -tlnp | grep :{args.listen_port}",
                  flush=True)
            # Distinct exit code so systemd can decline to restart: this is a
            # configuration problem, and retrying will never fix it.
            raise SystemExit(EXIT_CONFIG)
        if exc.errno in (errno.EACCES, errno.EPERM):
            print(f"ERROR: not allowed to bind {args.host}:{args.listen_port}.\n"
                  f"       Ports below 1024 need root or CAP_NET_BIND_SERVICE.",
                  flush=True)
            raise SystemExit(EXIT_CONFIG)
        raise

    print(f"opening {args.port} @ {args.baud} ...", flush=True)
    try:
        device = Device(args.port, args.baud, boot_wait=args.boot_wait)
    except serial.SerialException as exc:
        # Transient (board unplugged): worth retrying, so use a normal failure
        # exit code and let systemd's Restart=on-failure handle it.
        print(f"ERROR: cannot open {args.port}: {exc}", flush=True)
        httpd.server_close()
        raise SystemExit(1)

    Handler.device = device
    Handler.started_at = time.time()

    print(f"usbpower-api listening on http://{args.host}:{args.listen_port}",
          flush=True)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: bound to a non-loopback address with no authentication; "
              "this service switches physical relays.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)


if __name__ == "__main__":
    main()
