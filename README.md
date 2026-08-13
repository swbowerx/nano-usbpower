# nano-usbpower

USB-serial control of a 4-channel relay board from an Arduino. Plug the board
into a USB port, open a serial terminal, and switch each relay on/off, run
timed pulses, power-cycle a load, and review a rolling log of every switching
event -- all from a simple text prompt.

![Arduino Uno wired to a 4-channel relay module](arduinopower.png)

## Hardware

| Part | Notes |
| --- | --- |
| **Arduino Uno R3** | ATmega328P. Genuine Uno enumerates as `/dev/ttyACM0` (native USB via ATmega16u2). An Arduino Nano v3 also works -- clones with a CH340 chip come up as `/dev/ttyUSB0` instead. |
| **SunFounder Lab 4 Relay Module, 5V 4 Channels** | Compatible with Arduino R3 / 1280 / Arm / PIC / AVR / STM32. Songle SRD-05VDC-SL-C relays, 10A 250VAC / 10A 30VDC contacts, opto-isolated, **active-low** inputs. Sold by the SunFounder Store. |

The sketch is written for this relay module's active-low inputs
(`RELAY_ACTIVE_LOW` in the config block); set it to `false` for an active-high
board.

## Wiring

Default pin mapping (`PIN_LIST[]` in the sketch):

| Arduino | Relay module |
| --- | --- |
| D4 | IN1 |
| D5 | IN2 |
| D6 | IN3 |
| D7 | IN4 |
| 5V | VCC |
| GND | GND |

Change `PIN_LIST[]` to use any subset of D2--D13 or A0--A5. D0/D1 are the USB
serial lines and are never managed.

**JD-VCC jumper:** these modules ship with a jumper tying the relay coil
supply (`JD-VCC`) to the logic supply (`VCC`). That's fine for bench testing,
but switching a coil draws a current spike on the shared 5V rail. If you see
serial corruption that correlates with relay switching, pull the jumper and
feed `JD-VCC` from its own 5V supply, keeping GND common between the two.

## Build and flash

Using [arduino-cli](https://arduino.github.io/arduino-cli/):

```sh
# Arduino Uno
arduino-cli compile --fqbn arduino:avr:uno usb_crtl_power_x4
arduino-cli upload -p /dev/ttyACM0 --fqbn arduino:avr:uno usb_crtl_power_x4

# Arduino Nano v3 (older bootloader; drop ':cpu=atmega328old' for newer ones)
arduino-cli compile --fqbn arduino:avr:nano:cpu=atmega328old usb_crtl_power_x4
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:nano:cpu=atmega328old usb_crtl_power_x4
```

Close any serial terminal before uploading -- `avrdude` needs exclusive access
to the port to reset the board into its bootloader.

## Connecting

115200 baud, 8N1. For example:

```sh
picocom -b 115200 --omap crlf /dev/ttyACM0
```

The firmware accepts **CR, LF, or CRLF** as a line terminator, so it works with
any terminal regardless of its line-ending convention. (`--omap crlf` above is
only there so picocom echoes your own typing readably; picocom sends a bare CR
by default, which the firmware handles fine.)

If a partial or garbled line ever gets stuck waiting for a terminator, press
**Ctrl-C** (or Ctrl-U) to clear the line buffer. A stuck line also clears
itself after 3 seconds of silence (`LINE_IDLE_TIMEOUT_MS`).

## Commands

```
help | ?              list commands
config                show current configuration + free RAM
pins                  list managed pins and their live state
status [pin|all]      status of one pin, or all pins (default: all)
on <pin> [tsec]       turn pin ON; if tsec given, auto-OFF after tsec seconds
off <pin>             turn pin OFF, cancels any pending timer
set on|off            turn ALL managed pins ON or OFF
set <pin> on|off      turn one pin ON or OFF (no timer)
toggle <pin>          flip a pin's current state
cycle <pin> [tsec]    power-cycle: pin OFF for tsec seconds, then ON
dump                  dump the entire event log
dump <N>              dump the last N log entries
dump <pin>            dump all log entries for one pin
log clear             erase the event log
reset                 turn all managed pins OFF, cancel all timers
```

Pin tokens: `d4`, `D4`, `4`, or `a0`..`a5`.

Examples:

```
on d4              # relay 1 on
on d4 30           # relay 1 on, auto-off after 30s
cycle d5 10        # relay 2 off for 10s, then back on
status             # state and uptime of every relay
dump 20            # last 20 switching events
```

Every ON/OFF transition is recorded in a 100-entry ring buffer (timestamp,
pin, event, duration in the previous state). The log lives in RAM and is
cleared on reset; adjust `LOG_SIZE` in the config block to trade log depth
against the ATmega328P's 2 KB of SRAM.

## Troubleshooting

Intermittent silence -- a command sends but no reply comes back, then
communication resumes on its own -- is usually **USB hub autosuspend**, not
the firmware. See [`udev/README.md`](udev/README.md) for the diagnosis and a
persistent fix. Boards plugged directly into a motherboard port are not
affected.
