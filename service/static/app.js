const state = {
  pins: [],
  busy: 0,
};

const endpointPresets = [
  { label: "Discovery", method: "GET", path: "/api" },
  { label: "Health", method: "GET", path: "/api/health" },
  { label: "Help", method: "GET", path: "/api/help" },
  { label: "Config", method: "GET", path: "/api/config" },
  { label: "Status", method: "GET", path: "/api/status" },
  { label: "Pins", method: "GET", path: "/api/pins" },
  { label: "Pin Status", method: "GET", path: "/api/pins/{pin}" },
  { label: "All On", method: "POST", path: "/api/pins/on" },
  { label: "All Off", method: "POST", path: "/api/pins/off" },
  { label: "Pin On", method: "POST", path: "/api/pins/{pin}/on", body: "{\"seconds\": {seconds}}" },
  { label: "Pin Off", method: "POST", path: "/api/pins/{pin}/off" },
  { label: "Toggle", method: "POST", path: "/api/pins/{pin}/toggle" },
  { label: "Cycle", method: "POST", path: "/api/pins/{pin}/cycle", body: "{\"seconds\": {seconds}}" },
  { label: "Log", method: "GET", path: "/api/log" },
  { label: "Log Limit", method: "GET", path: "/api/log?limit={limit}" },
  { label: "Log Pin", method: "GET", path: "/api/log?pin={pin}" },
  { label: "Clear Log", method: "DELETE", path: "/api/log" },
  { label: "Events", method: "GET", path: "/api/events" },
  { label: "Reset", method: "POST", path: "/api/reset" },
  { label: "Raw", method: "POST", path: "/api/raw", body: "{\"command\": \"status\"}" },
];

const $ = (id) => document.getElementById(id);

function secondsLabel(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function endpointPath(path) {
  const pin = $("presetPin").value.trim() || "d4";
  const seconds = $("presetSeconds").value.trim() || "2";
  const limit = $("presetLimit").value.trim() || "20";
  return path
    .replaceAll("{pin}", encodeURIComponent(pin))
    .replaceAll("{seconds}", encodeURIComponent(seconds))
    .replaceAll("{limit}", encodeURIComponent(limit));
}

function endpointBody(body) {
  if (!body) return "";
  const seconds = $("presetSeconds").value.trim() || "2";
  return body.replaceAll("{seconds}", seconds);
}

function setBusy(isBusy) {
  state.busy += isBusy ? 1 : -1;
  state.busy = Math.max(0, state.busy);
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = state.busy > 0;
  });
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("visible"), 2200);
}

function writeOutput(target, payload) {
  target.textContent = JSON.stringify(payload, null, 2);
}

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body && method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const contentType = response.headers.get("Content-Type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { ok: response.ok, raw: await response.text() };

  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function run(method, path, body, output = $("restOutput")) {
  setBusy(true);
  try {
    const payload = await request(method, path, body);
    writeOutput(output, payload);
    return payload;
  } catch (error) {
    writeOutput(output, error.payload || { ok: false, error: error.message });
    toast(error.message);
    throw error;
  } finally {
    setBusy(false);
  }
}

function renderHealth(health) {
  $("metricApi").textContent = health.ok ? "Online" : "Down";
  $("metricPort").textContent = health.port || "-";
  $("metricBaud").textContent = health.baud || "-";
  $("metricConnected").textContent = secondsLabel(health.device_connected_s);
  $("serviceLine").textContent = `${health.port || "serial"} at ${health.baud || "-"} baud`;
}

function pendingLabel(pending) {
  if (!pending) return "-";
  if (pending.raw) return pending.raw;
  const action = pending.action === "auto_off" ? "auto-off" : "cycle on";
  return `${action} in ${secondsLabel(pending.seconds_remaining)}`;
}

function renderPins(pins) {
  state.pins = pins || [];
  const body = $("portsBody");
  body.innerHTML = "";

  if (!state.pins.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No ports reported</td></tr>';
    return;
  }

  for (const pin of state.pins) {
    const row = document.createElement("tr");
    const stateClass = pin.state === "ON" ? "on" : "off";
    row.innerHTML = `
      <td><strong>${pin.pin}</strong></td>
      <td><span class="status-pill ${stateClass}">${pin.state}</span></td>
      <td>${secondsLabel(pin.seconds_in_state)}</td>
      <td class="${pin.pending ? "pending" : ""}">${pendingLabel(pin.pending)}</td>
      <td>
        <div class="port-actions">
          <button type="button" data-action="on" data-pin="${pin.pin}">On</button>
          <button type="button" data-action="off" data-pin="${pin.pin}">Off</button>
          <button type="button" data-action="toggle" data-pin="${pin.pin}">Toggle</button>
          <button type="button" data-action="cycle" data-pin="${pin.pin}">Cycle</button>
          <button type="button" data-action="log" data-pin="${pin.pin}">Dump Log</button>
        </div>
      </td>
    `;
    body.appendChild(row);
  }

  syncPinChoices();
}

function syncPinChoices() {
  const pins = state.pins.map((pin) => pin.pin.toLowerCase());
  for (const select of [$("logPin"), $("presetPin")]) {
    const current = select.value;
    const leading = select.id === "logPin" ? '<option value="">All ports</option>' : "";
    select.innerHTML = leading + pins.map((pin) => `<option value="${pin}">${pin}</option>`).join("");
    if (pins.includes(current) || (select.id === "logPin" && current === "")) {
      select.value = current;
    }
  }
}

function renderLog(payload) {
  const node = $("logEntries");
  const entries = payload.entries || [];
  node.innerHTML = "";
  if (!entries.length) {
    node.innerHTML = '<div class="empty">No log entries</div>';
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.innerHTML = `
      <span>${entry.t_ms}ms</span>
      <strong>${entry.pin}</strong>
      <span>${entry.event}</span>
      <span>prev ${secondsLabel(entry.prev_duration_s)}</span>
    `;
    node.appendChild(item);
  }
}

async function refreshHealth() {
  const health = await run("GET", "/api/health");
  renderHealth(health);
  return health;
}

async function refreshStatus() {
  const status = await run("GET", "/api/status");
  renderPins(status.pins);
  return status;
}

async function refreshLog() {
  const pin = $("logPin").value;
  const limit = $("logLimit").value.trim();
  const path = pin
    ? `/api/log?pin=${encodeURIComponent(pin)}`
    : `/api/log?limit=${encodeURIComponent(limit || "20")}`;
  const log = await run("GET", path);
  renderLog(log);
  return log;
}

async function refreshAll() {
  await refreshHealth();
  await refreshStatus();
  await refreshLog();
}

function optionalSeconds(id) {
  const value = $(id).value.trim();
  if (!value) return null;
  return Number.parseInt(value, 10);
}

async function pinAction(pin, action) {
  if (action === "log") {
    $("logPin").value = pin.toLowerCase();
    await refreshLog();
    return;
  }

  let body = null;
  if (action === "cycle") {
    body = { seconds: optionalSeconds("cycleSeconds") || 2 };
  }
  if (action === "on") {
    const seconds = optionalSeconds("onSeconds");
    if (seconds) body = { seconds };
  }

  await run("POST", `/api/pins/${pin.toLowerCase()}/${action}`, body);
  await refreshStatus();
  await refreshLog();
  toast(`${pin} ${action}`);
}

function renderPresets() {
  const root = $("endpointPresets");
  root.innerHTML = "";
  for (const preset of endpointPresets) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<span>${preset.label}</span><code>${preset.method} ${preset.path}</code>`;
    button.addEventListener("click", () => {
      $("restMethod").value = preset.method;
      $("restPath").value = endpointPath(preset.path);
      $("restBody").value = endpointBody(preset.body);
      writeOutput($("restOutput"), {
        selected: preset.label,
        method: $("restMethod").value,
        path: $("restPath").value,
        body: $("restBody").value || null,
      });
      toast(`${preset.label} loaded`);
    });
    root.appendChild(button);
  }
}

async function sendRest() {
  const method = $("restMethod").value;
  const path = $("restPath").value.trim();
  const rawBody = $("restBody").value.trim();
  let body = rawBody;

  if (!path.startsWith("/")) {
    toast("Path must start with /");
    return;
  }

  if (rawBody && method !== "GET") {
    try {
      JSON.parse(rawBody);
    } catch (error) {
      toast("JSON body is invalid");
      writeOutput($("restOutput"), { ok: false, error: error.message });
      return;
    }
  }

  if (!rawBody || method === "GET") {
    body = null;
  }

  await run(method, path, body);
}

async function sendRaw() {
  const command = $("rawCommand").value.trim();
  if (!command) {
    toast("Raw command is empty");
    return;
  }
  await run("POST", "/api/raw", { command }, $("rawOutput"));
}

function bindEvents() {
  const safe = (fn) => (...args) => Promise.resolve(fn(...args)).catch(() => {});

  $("refreshAll").addEventListener("click", safe(refreshAll));
  $("refreshStatus").addEventListener("click", safe(refreshStatus));
  $("portsRefresh").addEventListener("click", safe(refreshStatus));
  $("refreshLog").addEventListener("click", safe(refreshLog));
  $("clearLog").addEventListener("click", safe(async () => {
    if (!window.confirm("Clear the event log?")) return;
    await run("DELETE", "/api/log");
    await refreshLog();
  }));
  $("sendRest").addEventListener("click", safe(sendRest));
  $("sendRaw").addEventListener("click", safe(sendRaw));

  $("portsBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    safe(pinAction)(button.dataset.pin, button.dataset.action);
  });

  $("allOn").addEventListener("click", safe(async () => {
    if (!window.confirm("Turn every port on?")) return;
    await run("POST", "/api/pins/on");
    await refreshStatus();
    await refreshLog();
  }));

  $("allOff").addEventListener("click", safe(async () => {
    if (!window.confirm("Turn every port off?")) return;
    await run("POST", "/api/pins/off");
    await refreshStatus();
    await refreshLog();
  }));

  $("resetAll").addEventListener("click", safe(async () => {
    if (!window.confirm("Reset every port and cancel timers?")) return;
    await run("POST", "/api/reset");
    await refreshStatus();
    await refreshLog();
  }));

  $("rawCommand").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      safe(sendRaw)();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  renderPresets();
  refreshAll().catch(() => {});
});
