# USB hub autosuspend fix

## The problem

If the Arduino is connected through one or more external USB hubs (a dock,
a hub-heavy laptop port, a cheap USB hub chain), you may see the serial
connection go intermittently silent: a command gets sent, `write()`
succeeds, but no reply ever comes back -- for one command, sometimes
several in a row -- and then communication resumes normally on its own.

This was diagnosed on this project by proving the Arduino's own internal
state (uptime counters, pin state) stayed perfectly continuous across every
one of these gaps -- the firmware never crashed, reset, or dropped a
command. The dropouts are a **host-side USB link power management** issue:
Linux's runtime power management can autosuspend a hub's uplink after a
very short idle period (as little as 0ms delay on some hub chips), and
waking it back up for the next transfer takes long enough -- or
occasionally fumbles the first transaction -- that the round trip is lost.

You can check whether a given USB hub has autosuspend enabled with:

```
cat /sys/bus/usb/devices/<bus-port-path>/power/control
```

`auto` means autosuspend is enabled for that hub; `on` means it's disabled
(always full power). Use `lsusb -t` to see the tree of hubs a device is
connected through, and `readlink -f /sys/class/tty/ttyACM0/device` (adjust
for your port) to find the exact `/sys/bus/usb/devices/...` path for the
Arduino, then walk up its parent hub directories.

## The fix

`99-usb-hub-autosuspend-off.rules` tells udev to set `power/control=on`
(i.e. disable autosuspend) for every USB device that identifies as a hub
(USB device class `0x09`), the moment it's plugged in or the system boots.
It matches on device *class*, not a specific vendor/product ID, so it
applies to whatever hub hardware is actually in the path on a given
machine -- you don't need to look up or edit any IDs.

## Install

```
sudo cp udev/99-usb-hub-autosuspend-off.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

The `trigger` re-runs the rule against already-connected devices; a reboot
also works. To verify it took effect, re-run the `cat .../power/control`
check above on your hub(s) -- it should now read `on`.

## Scope: what this does and doesn't affect

- **Only affects USB hubs**, identified by device class, never the Arduino
  itself or any other non-hub peripheral. The Arduino (and anything else)
  keeps whatever autosuspend behavior it already had.
- **Only affects devices actually routed through an external hub.** If the
  Arduino (or anything else) is plugged directly into a port that goes
  straight to the motherboard's own root USB controller, there is no hub
  device in that path for this rule to match, so nothing changes for it --
  and it was never affected by this dropout issue in the first place, since
  there's no intermediate hub link to suspend/resume.
- **Other devices sharing the same physical hub are affected, in a good
  way.** Disabling a hub's own autosuspend keeps its uplink to the host
  always active, which removes the same resume-latency source for every
  other device plugged into that hub too (a keyboard, webcam, other USB
  peripherals) -- it does not force autosuspend off on those *other
  devices'* own power settings, only on the hub link they share.
- **Power cost is negligible.** A hub controller chip draws on the order of
  low tens of milliwatts continuously instead of idling down; for a
  desktop or a laptop that's plugged in while doing serial work with an
  Arduino, this is not meaningful. If you're running on battery and want
  autosuspend back, remove the rule file and re-run the two `udevadm`
  commands above, or just `sudo tee /sys/bus/usb/devices/<hub>/power/control <<< auto`
  per hub for a temporary, non-persistent revert.

## Uninstall

```
sudo rm /etc/udev/rules.d/99-usb-hub-autosuspend-off.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```
