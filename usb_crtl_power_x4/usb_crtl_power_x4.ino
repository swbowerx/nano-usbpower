/*
  usb_crtl_power_x4.ino

  Arduino Nano (ATmega328P) USB-serial relay / digital-IO power controller.
  Talk to it over the USB serial port (default 115200 8N1, newline-terminated
  commands) to switch relay/digital pins on and off, run timed pulses and
  power-cycles, check status, and review a rolling log of every on/off event.

  --------------------------------- COMMANDS ---------------------------------
    help | ?                    list commands
    config                      show current configuration + free RAM
    pins                        list managed pins and their live state
    status [pin|all]            status of one pin, or all pins (default: all)
    on <pin> [tsec]             turn pin ON; if tsec given, auto-OFF after
                                 tsec seconds
    off <pin>                   turn pin OFF, cancels any pending timer
    set on|off                  turn ALL managed pins ON or OFF
    set <pin> on|off            turn one pin ON or OFF (no timer)
    toggle <pin>                flip a pin's current state
    cycle <pin> [tsec]          power-cycle: pin OFF for tsec seconds
                                 (default CYCLE_DEFAULT_SEC below), then ON
    dump                        dump the entire event log
    dump all                    same as `dump`
    dump <N>                    dump the last N log entries (any pin)
    dump <pin>                  dump all log entries for one pin (e.g. dump d1)
    log clear                   erase the event log
    reset                       turn all managed pins OFF, cancel all timers

  Pin tokens: "d4" / "D4" / "4" (digital), or "a0".."a5" (analog pin used as
  digital I/O). Only pins listed in PIN_LIST[] below are controllable.
  Note: on a Nano, A6/A7 are analog-input only and cannot be used here; D0/D1
  are the USB serial lines and are never managed.

  ---------------------------------- LOGGING ----------------------------------
  Every ON/OFF transition (manual, timed, cycle, or toggle) is appended to a
  fixed-size ring buffer of LOG_SIZE entries (default 100). Each entry is 8
  bytes (4-byte millis timestamp, pin, ON/OFF flag, 2-byte duration-in-previous-
  state in seconds), so LOG_SIZE=100 costs ~800 bytes of the Nano's 2048-byte
  SRAM -- comfortable with the default 4 managed pins. If you extend PIN_LIST
  to many more pins, or add other RAM-hungry code, lower LOG_SIZE below and
  recheck the compiler's "Global variables use NN bytes" line (keep it well
  under 2048 to leave headroom for the call stack).

  The log lives in RAM only and is lost on reset/power-cycle by design (a
  100-entry, 8-byte-per-write log would burn through the AVR's ~100k-cycle
  EEPROM endurance quickly if every relay toggle also hit EEPROM). If you need
  persistence, add an explicit EEPROM save/load command rather than writing
  on every event.
  ------------------------------------------------------------------------------
*/

#include <Arduino.h>
#include <ctype.h>
#include <string.h>
#include <stdlib.h>

// =========================== CONFIG ===========================
#define BAUD_RATE           115200
#define LOG_SIZE            100     // ring buffer entries (8 bytes each, see header)
#define CYCLE_DEFAULT_SEC   5       // default off-time for `cycle` with no arg
#define RELAY_ACTIVE_LOW    true    // true: LOW=relay ON (most relay modules), false: HIGH=ON
#define CMD_BUF_SIZE        48

// Managed digital pins. Default = 4-channel relay board (D4-D7), matching
// this sketch's name. Extend to any subset of D2..D13 / A0..A5 as needed --
// e.g. const uint8_t PIN_LIST[] = {2,3,4,5,6,7,8,9,10,11,12,13};
const uint8_t PIN_LIST[] = {4, 5, 6, 7};
const uint8_t PIN_COUNT = sizeof(PIN_LIST) / sizeof(PIN_LIST[0]);
// ================================================================

// ----- per-pin runtime state -----
enum PinAction : uint8_t { ACTION_NONE = 0, ACTION_AUTO_OFF = 1, ACTION_CYCLE_ON = 2 };

bool          pinState[PIN_COUNT];       // true = ON
unsigned long pinStateSince[PIN_COUNT];  // millis() when it entered current state
uint8_t       pinAction[PIN_COUNT];      // pending scheduled action, if any
unsigned long pinActionAt[PIN_COUNT];    // millis() at which the pending action fires

// ----- event log (ring buffer) -----
struct LogEntry {
  uint32_t t;      // millis() at the transition
  uint8_t  pin;    // physical pin number
  uint8_t  event;  // 0 = OFF, 1 = ON
  uint16_t dur;    // seconds spent in the PREVIOUS state (0 if unknown)
};
LogEntry logBuf[LOG_SIZE];
uint16_t logHead = 0;   // next write index
uint16_t logCount = 0;  // valid entries currently stored (<= LOG_SIZE)

char cmdBuf[CMD_BUF_SIZE];
uint8_t cmdLen = 0;

// =========================== helpers ===========================

bool eq(const char *a, const char *b) {
  return a != nullptr && strcasecmp(a, b) == 0;
}

int8_t idxOf(uint8_t pin) {
  for (uint8_t i = 0; i < PIN_COUNT; i++) if (PIN_LIST[i] == pin) return i;
  return -1;
}

// Accepts "d4"/"D4", "4", or "a0".."a5". Returns the physical pin number if
// it is in PIN_LIST[], otherwise -1.
int16_t parsePin(const char *tok) {
  if (!tok || !*tok) return -1;
  const char *p = tok;
  bool analog = false;
  if (*p == 'd' || *p == 'D') {
    p++;
  } else if (*p == 'a' || *p == 'A') {
    p++;
    analog = true;
  }
  if (!*p) return -1;
  for (const char *c = p; *c; c++) if (!isdigit((unsigned char)*c)) return -1;
  int n = atoi(p);
  uint8_t pin = analog ? (A0 + n) : (uint8_t)n;
  return (idxOf(pin) >= 0) ? (int16_t)pin : (int16_t)-1;
}

void printErr(const __FlashStringHelper *msg) {
  Serial.print(F("ERR: "));
  Serial.println(msg);
}

int freeRam() {
  extern int __heap_start, *__brkval;
  int v;
  return (int)&v - (__brkval == 0 ? (int)&__heap_start : (int)__brkval);
}

// =========================== logging ===========================

void logAdd(uint8_t pin, bool on, unsigned long durSec) {
  if (durSec > 65535UL) durSec = 65535UL;
  LogEntry &e = logBuf[logHead];
  e.t = millis();
  e.pin = pin;
  e.event = on ? 1 : 0;
  e.dur = (uint16_t)durSec;
  logHead = (logHead + 1) % LOG_SIZE;
  if (logCount < LOG_SIZE) logCount++;
}

// filterPin < 0 => all pins. maxCount == 0 => no limit (dump everything stored).
void dumpLog(int16_t filterPin, uint16_t maxCount) {
  uint16_t n = logCount;
  uint16_t start = (logHead + LOG_SIZE - logCount) % LOG_SIZE; // oldest stored entry
  if (maxCount > 0 && maxCount < logCount) {
    n = maxCount;
    start = (logHead + LOG_SIZE - maxCount) % LOG_SIZE;
  }
  Serial.println(F("t_ms\tpin\tevent\tprev_dur_s"));
  uint16_t printed = 0;
  for (uint16_t i = 0, idx = start; i < n; i++, idx = (idx + 1) % LOG_SIZE) {
    LogEntry &e = logBuf[idx];
    if (filterPin >= 0 && e.pin != (uint8_t)filterPin) continue;
    Serial.print(e.t);
    Serial.print(F("\tD"));
    Serial.print(e.pin);
    Serial.print('\t');
    Serial.print(e.event ? F("ON") : F("OFF"));
    Serial.print('\t');
    Serial.println(e.dur);
    printed++;
  }
  Serial.print(F("("));
  Serial.print(printed);
  Serial.print('/');
  Serial.print(logCount);
  Serial.println(F(" entries shown)"));
}

// =========================== pin control ===========================

void writeRelay(uint8_t pin, bool on) {
  bool level = on ? !RELAY_ACTIVE_LOW : RELAY_ACTIVE_LOW; // true=HIGH
  digitalWrite(pin, level ? HIGH : LOW);
}

void setPin(uint8_t idx, bool on, bool doLog) {
  uint8_t pin = PIN_LIST[idx];
  bool changed = (pinState[idx] != on);
  unsigned long now = millis();
  unsigned long durSec = (now - pinStateSince[idx]) / 1000UL;

  writeRelay(pin, on);

  if (changed) {
    if (doLog) logAdd(pin, on, durSec);
    pinState[idx] = on;
    pinStateSince[idx] = now;
    Serial.print(F("D"));
    Serial.print(pin);
    Serial.print(F(" -> "));
    Serial.println(on ? F("ON") : F("OFF"));
  }
}

// =========================== status / info ===========================

void printPinStatus(uint8_t idx) {
  uint8_t pin = PIN_LIST[idx];
  Serial.print(F("D"));
  Serial.print(pin);
  Serial.print(F(": "));
  Serial.print(pinState[idx] ? F("ON") : F("OFF"));
  Serial.print(F(" for "));
  Serial.print((millis() - pinStateSince[idx]) / 1000UL);
  Serial.print(F("s"));

  if (pinAction[idx] == ACTION_AUTO_OFF) {
    long remain = (long)(pinActionAt[idx] - millis()) / 1000L;
    Serial.print(F(" [auto-OFF in "));
    Serial.print(remain < 0 ? 0 : remain);
    Serial.print(F("s]"));
  } else if (pinAction[idx] == ACTION_CYCLE_ON) {
    long remain = (long)(pinActionAt[idx] - millis()) / 1000L;
    Serial.print(F(" [cycle: ON in "));
    Serial.print(remain < 0 ? 0 : remain);
    Serial.print(F("s]"));
  }
  Serial.println();
}

void printStatusAll() {
  for (uint8_t i = 0; i < PIN_COUNT; i++) printPinStatus(i);
}

void printPins() {
  Serial.print(F("managed pins ("));
  Serial.print(PIN_COUNT);
  Serial.println(F("):"));
  for (uint8_t i = 0; i < PIN_COUNT; i++) {
    Serial.print(F("  D"));
    Serial.print(PIN_LIST[i]);
    Serial.print(F(" = "));
    Serial.println(pinState[i] ? F("ON") : F("OFF"));
  }
}

void printConfig() {
  Serial.print(F("baud="));
  Serial.println(BAUD_RATE);
  Serial.print(F("log_size="));
  Serial.print(LOG_SIZE);
  Serial.print(F(" (used "));
  Serial.print(logCount);
  Serial.println(F(")"));
  Serial.print(F("cycle_default_sec="));
  Serial.println(CYCLE_DEFAULT_SEC);
  Serial.print(F("relay_active_low="));
  Serial.println(RELAY_ACTIVE_LOW ? F("true") : F("false"));
  Serial.print(F("free_ram_bytes="));
  Serial.println(freeRam());
}

void printHelp() {
  Serial.println(F("commands:"));
  Serial.println(F("  help | ?                 this help"));
  Serial.println(F("  config                   show config + free RAM"));
  Serial.println(F("  pins                     list managed pins/state"));
  Serial.println(F("  status [pin|all]         pin status (default: all)"));
  Serial.println(F("  on <pin> [tsec]          pin ON, optional auto-OFF after tsec"));
  Serial.println(F("  off <pin>                pin OFF, cancels pending timer"));
  Serial.println(F("  set on|off               ALL pins ON/OFF"));
  Serial.println(F("  set <pin> on|off         one pin ON/OFF"));
  Serial.println(F("  toggle <pin>             flip pin state"));
  Serial.println(F("  cycle <pin> [tsec]       OFF for tsec (default 5s), then ON"));
  Serial.println(F("  dump [pin|N|all]         dump log (all / last N / one pin)"));
  Serial.println(F("  log clear                erase log"));
  Serial.println(F("  reset                    all pins OFF, cancel timers"));
  Serial.println(F("pin tokens: d4 / D4 / 4 / a0..a5"));
}

// =========================== command handlers ===========================

void cmdOn(char *pinTok, char *tsecTok) {
  int16_t pin = parsePin(pinTok);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  uint8_t idx = idxOf(pin);
  setPin(idx, true, true);
  if (tsecTok) {
    unsigned long tsec = strtoul(tsecTok, nullptr, 10);
    if (tsec > 0) {
      pinAction[idx] = ACTION_AUTO_OFF;
      pinActionAt[idx] = millis() + tsec * 1000UL;
      Serial.print(F("  auto-OFF in "));
      Serial.print(tsec);
      Serial.println(F("s"));
      return;
    }
  }
  pinAction[idx] = ACTION_NONE;
}

void cmdOff(char *pinTok) {
  int16_t pin = parsePin(pinTok);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  uint8_t idx = idxOf(pin);
  pinAction[idx] = ACTION_NONE;
  setPin(idx, false, true);
}

void cmdToggle(char *pinTok) {
  int16_t pin = parsePin(pinTok);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  uint8_t idx = idxOf(pin);
  pinAction[idx] = ACTION_NONE;
  setPin(idx, !pinState[idx], true);
}

void cmdCycle(char *pinTok, char *tsecTok) {
  int16_t pin = parsePin(pinTok);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  uint8_t idx = idxOf(pin);
  unsigned long tsec = tsecTok ? strtoul(tsecTok, nullptr, 10) : CYCLE_DEFAULT_SEC;
  if (tsec == 0) tsec = CYCLE_DEFAULT_SEC;
  setPin(idx, false, true);
  pinAction[idx] = ACTION_CYCLE_ON;
  pinActionAt[idx] = millis() + tsec * 1000UL;
  Serial.print(F("  cycle: ON in "));
  Serial.print(tsec);
  Serial.println(F("s"));
}

void cmdSetAll(bool on) {
  for (uint8_t i = 0; i < PIN_COUNT; i++) {
    pinAction[i] = ACTION_NONE;
    setPin(i, on, true);
  }
}

void cmdSet(char *a) {
  if (!a) { printErr(F("usage: set on|off | set <pin> on|off")); return; }
  if (eq(a, "on") || eq(a, "off")) { cmdSetAll(eq(a, "on")); return; }
  int16_t pin = parsePin(a);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  char *b = strtok(nullptr, " ");
  if (!b || (!eq(b, "on") && !eq(b, "off"))) { printErr(F("usage: set <pin> on|off")); return; }
  uint8_t idx = idxOf(pin);
  pinAction[idx] = ACTION_NONE;
  setPin(idx, eq(b, "on"), true);
}

void cmdStatus(char *a) {
  if (!a || eq(a, "all")) { printStatusAll(); return; }
  int16_t pin = parsePin(a);
  if (pin < 0) { printErr(F("unknown pin")); return; }
  printPinStatus(idxOf(pin));
}

void cmdDump(char *a) {
  if (!a || eq(a, "all")) { dumpLog(-1, 0); return; }
  bool numeric = true;
  for (char *c = a; *c; c++) if (!isdigit((unsigned char)*c)) { numeric = false; break; }
  if (numeric) { dumpLog(-1, (uint16_t)atoi(a)); return; }
  int16_t pin = parsePin(a);
  if (pin < 0) { printErr(F("unknown pin or count")); return; }
  dumpLog(pin, 0);
}

void cmdLog(char *sub) {
  if (sub && eq(sub, "clear")) {
    logCount = 0;
    logHead = 0;
    Serial.println(F("log cleared"));
  } else {
    printErr(F("usage: log clear"));
  }
}

void cmdReset() {
  for (uint8_t i = 0; i < PIN_COUNT; i++) {
    pinAction[i] = ACTION_NONE;
    setPin(i, false, true);
  }
  Serial.println(F("reset: all pins OFF"));
}

void processCommand(char *line) {
  char *cmd = strtok(line, " ");
  if (!cmd) return;

  if (eq(cmd, "help") || eq(cmd, "?")) {
    printHelp();
  } else if (eq(cmd, "config")) {
    printConfig();
  } else if (eq(cmd, "pins")) {
    printPins();
  } else if (eq(cmd, "status")) {
    cmdStatus(strtok(nullptr, " "));
  } else if (eq(cmd, "on")) {
    char *p = strtok(nullptr, " ");
    char *t = strtok(nullptr, " ");
    cmdOn(p, t);
  } else if (eq(cmd, "off")) {
    cmdOff(strtok(nullptr, " "));
  } else if (eq(cmd, "set")) {
    cmdSet(strtok(nullptr, " "));
  } else if (eq(cmd, "toggle")) {
    cmdToggle(strtok(nullptr, " "));
  } else if (eq(cmd, "cycle")) {
    char *p = strtok(nullptr, " ");
    char *t = strtok(nullptr, " ");
    cmdCycle(p, t);
  } else if (eq(cmd, "dump")) {
    cmdDump(strtok(nullptr, " "));
  } else if (eq(cmd, "log")) {
    cmdLog(strtok(nullptr, " "));
  } else if (eq(cmd, "reset")) {
    cmdReset();
  } else {
    printErr(F("unknown command, try 'help'"));
  }
}

// =========================== setup / loop ===========================

void setup() {
  Serial.begin(BAUD_RATE);

  unsigned long now = millis();
  for (uint8_t i = 0; i < PIN_COUNT; i++) {
    uint8_t pin = PIN_LIST[i];
    // Drive the OFF level before switching to OUTPUT to avoid a relay glitch.
    bool offLevel = RELAY_ACTIVE_LOW; // OFF = HIGH when active-low
    digitalWrite(pin, offLevel ? HIGH : LOW);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, offLevel ? HIGH : LOW);
    pinState[i] = false;
    pinStateSince[i] = now;
    pinAction[i] = ACTION_NONE;
    pinActionAt[i] = 0;
  }

  Serial.println(F("usb_crtl_power_x4 ready. type 'help' for commands."));
  printPins();
}

void loop() {
  // ---- serial command reader ----
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) processCommand(cmdBuf);
      cmdLen = 0;
    } else if (cmdLen < CMD_BUF_SIZE - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdLen = 0;
      printErr(F("line too long"));
    }
  }

  // ---- scheduled action timers (auto-off, cycle-resume) ----
  unsigned long now = millis();
  for (uint8_t i = 0; i < PIN_COUNT; i++) {
    if (pinAction[i] == ACTION_NONE) continue;
    if ((long)(now - pinActionAt[i]) < 0) continue;
    if (pinAction[i] == ACTION_AUTO_OFF) {
      pinAction[i] = ACTION_NONE;
      setPin(i, false, true);
    } else if (pinAction[i] == ACTION_CYCLE_ON) {
      pinAction[i] = ACTION_NONE;
      setPin(i, true, true);
    }
  }
}
