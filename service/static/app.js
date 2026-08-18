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
  { label: "Aliases", method: "GET", path: "/api/aliases" },
  { label: "Alias Status", method: "GET", path: "/api/aliases/{pin}" },
  { label: "Set Alias", method: "POST", path: "/api/aliases/{pin}", body: "{\"alias\": \"{alias}\"}" },
  { label: "Clear Alias", method: "DELETE", path: "/api/aliases/{pin}" },
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
  { label: "Service Restart", method: "POST", path: "/api/service/restart" },
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
  const alias = $("presetAlias").value.trim() || "drone_203";
  return body
    .replaceAll("{seconds}", seconds)
    .replaceAll("{alias}", alias.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    const alias = pin.alias || "";
    const aliasLabel = alias ? `<span class="alias-label">${alias}</span>` : '<span class="alias-empty">No alias</span>';
    row.innerHTML = `
      <td>
        <div class="port-name">
          <strong>${pin.pin}</strong>
          ${aliasLabel}
        </div>
      </td>
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
          <button type="button" data-action="alias" data-pin="${pin.pin}">Alias</button>
        </div>
        <div class="alias-editor" data-alias-editor="${pin.pin}" hidden>
          <input class="alias-input" type="text" maxlength="20" spellcheck="false" autocomplete="off" value="${alias}" placeholder="drone_203">
          <button type="button" data-action="save-alias" data-pin="${pin.pin}">Save</button>
          <button type="button" data-action="clear-alias" data-pin="${pin.pin}">Clear</button>
          <button type="button" data-action="cancel-alias" data-pin="${pin.pin}">Cancel</button>
        </div>
      </td>
    `;
    body.appendChild(row);
  }

  syncPinChoices();
}

function syncPinChoices() {
  const choices = state.pins.map((pin) => ({
    value: pin.alias || pin.pin.toLowerCase(),
    label: pin.alias ? `${pin.alias} (${pin.pin})` : pin.pin.toLowerCase(),
  }));
  const values = choices.map((choice) => choice.value);
  for (const select of [$("logPin"), $("presetPin")]) {
    const current = select.value;
    const leading = select.id === "logPin" ? '<option value="">All ports</option>' : "";
    select.innerHTML = leading + choices
      .map((choice) => `<option value="${choice.value}">${choice.label}</option>`)
      .join("");
    if (values.includes(current) || (select.id === "logPin" && current === "")) {
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
    const pinLabel = entry.alias ? `${entry.alias} (${entry.pin})` : entry.pin;
    item.innerHTML = `
      <span>${entry.t_ms}ms</span>
      <strong>${pinLabel}</strong>
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

function aliasEditor(pin) {
  return document.querySelector(`[data-alias-editor="${pin}"]`);
}

function startAliasEdit(pin) {
  const editor = aliasEditor(pin);
  if (!editor) return;
  editor.hidden = false;
  const input = editor.querySelector(".alias-input");
  input.focus();
  input.select();
}

function cancelAliasEdit(pin) {
  const editor = aliasEditor(pin);
  if (editor) editor.hidden = true;
}

async function saveAlias(pin, alias) {
  const trimmed = alias.trim();
  if (trimmed) {
    await run("POST", `/api/aliases/${pin.toLowerCase()}`, { alias: trimmed });
  } else {
    await run("DELETE", `/api/aliases/${pin.toLowerCase()}`);
  }
  await refreshStatus();
  await refreshLog();
  toast(trimmed ? `${pin} alias saved` : `${pin} alias cleared`);
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

async function waitForService() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const health = await request("GET", "/api/health");
      renderHealth(health);
      return health;
    } catch (error) {
      await sleep(1000);
    }
  }
  throw new Error("service did not come back within 20 seconds");
}

async function restartService() {
  if (!window.confirm("Restart the usbpower API service?")) return;

  setBusy(true);
  try {
    const payload = await request("POST", "/api/service/restart");
    writeOutput($("restOutput"), payload);
    $("metricApi").textContent = "Restarting";
    toast("Service restart requested");
    await sleep(1200);
    await waitForService();
    await refreshAll();
    toast("Service is back online");
  } catch (error) {
    writeOutput($("restOutput"), error.payload || { ok: false, error: error.message });
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  const safe = (fn) => (...args) => Promise.resolve(fn(...args)).catch(() => {});

  $("refreshAll").addEventListener("click", safe(refreshAll));
  $("refreshStatus").addEventListener("click", safe(refreshStatus));
  $("restartService").addEventListener("click", safe(restartService));
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
    const { action, pin } = button.dataset;
    if (action === "alias") {
      startAliasEdit(pin);
      return;
    }
    if (action === "save-alias") {
      const input = aliasEditor(pin)?.querySelector(".alias-input");
      safe(saveAlias)(pin, input?.value || "");
      return;
    }
    if (action === "clear-alias") {
      safe(saveAlias)(pin, "");
      return;
    }
    if (action === "cancel-alias") {
      cancelAliasEdit(pin);
      return;
    }
    safe(pinAction)(pin, action);
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
