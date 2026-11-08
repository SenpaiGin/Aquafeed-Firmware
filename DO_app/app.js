import { BLE9100_CHARACTERISTIC, BLE9100_SERVICE, decodeFrame, hexBytes } from "./protocol.js";

const KEYS = {
  readings: "aquafeed.do.readings.v1",
  settings: "aquafeed.do.settings.v1",
  calibrations: "aquafeed.do.calibrations.v1",
};
const DEFAULT_SETTINGS = { temperatureUnit: "C", minimumMgL: "", maximumMgL: "", autoSaveSeconds: "off" };
const MAX_READINGS = 5000;

const $ = (id) => document.getElementById(id);
const state = {
  device: null,
  characteristic: null,
  latest: null,
  lastFrameError: "",
  trend: [],
  frozen: null,
  isFrozen: false,
  doUnit: "mg",
  readings: loadJson(KEYS.readings, []),
  calibrations: loadJson(KEYS.calibrations, []),
  settings: { ...DEFAULT_SETTINGS, ...loadJson(KEYS.settings, {}) },
  lastValidAt: 0,
  lastAutoSaveAt: 0,
  readTimer: null,
  refreshTimer: null,
  readInFlight: false,
  readErrorLogged: false,
  frameCount: 0,
  toastTimer: null,
};

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function storeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("Browser storage is full. Export records and remove older entries.");
  }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function addPacketLog(message) {
  const list = $("packet-log");
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, document.createTextNode(message));
  list.prepend(item);
  while (list.children.length > 80) list.lastElementChild.remove();
}

function setConnectionState(label, kind = "") {
  const pill = $("connection-state");
  pill.classList.toggle("connected", kind === "connected");
  pill.classList.toggle("error", kind === "error");
  pill.lastElementChild.textContent = label;
}

function displayedReading() {
  return state.isFrozen ? state.frozen : state.latest;
}

function renderReading() {
  const sample = displayedReading();
  const valueRow = document.querySelector(".value-row");
  const quality = $("reading-quality");
  const now = Date.now();
  const secondsSinceValid = state.lastValidAt ? Math.max(0, Math.floor((now - state.lastValidAt) / 1000)) : null;
  const isStale = Boolean(sample) && (!state.lastValidAt || secondsSinceValid > 8);
  const minimum = Number.parseFloat(state.settings.minimumMgL);
  const maximum = Number.parseFloat(state.settings.maximumMgL);
  const below = sample && Number.isFinite(minimum) && sample.dissolvedOxygenMgL < minimum;
  const above = sample && Number.isFinite(maximum) && sample.dissolvedOxygenMgL > maximum;
  const outOfRange = Boolean(below || above);

  valueRow.classList.toggle("alert", outOfRange);
  if (!sample) {
    $("reading-value").textContent = "—";
    $("reading-unit").textContent = state.doUnit === "mg" ? "mg/L" : "%";
    $("reading-label").textContent = "Dissolved oxygen";
    $("temperature-value").textContent = "—";
    $("saturation-value").textContent = "—";
    $("orp-value").textContent = "—";
    $("battery-value").textContent = "—";
    $("reading-time").textContent = "No reading yet";
    quality.className = `quality-label ${state.lastFrameError ? "warning" : ""}`;
    quality.lastElementChild.textContent = state.lastFrameError ? "Frame not decoded · check diagnostics" : "Waiting for a valid frame";
  } else {
    const celsius = sample.temperatureC;
    const displayedTemperature = state.settings.temperatureUnit === "F" ? (celsius * 9 / 5) + 32 : celsius;
    const primary = state.doUnit === "mg" ? sample.dissolvedOxygenMgL : sample.saturationPercent;
    $("reading-value").textContent = state.doUnit === "mg" ? primary.toFixed(2) : primary.toFixed(1);
    $("reading-unit").textContent = state.doUnit === "mg" ? "mg/L" : "%";
    $("reading-label").textContent = state.doUnit === "mg" ? "Dissolved oxygen" : "Oxygen saturation";
    $("temperature-value").textContent = displayedTemperature.toFixed(1);
    $("temperature-unit").textContent = state.settings.temperatureUnit === "F" ? "°F" : "°C";
    $("saturation-value").textContent = sample.saturationPercent.toFixed(1);
    $("orp-value").textContent = String(sample.orpMv);
    $("battery-value").textContent = `${Math.min(100, Math.max(0, sample.batteryPercent)).toFixed(0)}`;
    $("reading-time").textContent = `Received ${new Date(sample.receivedAt).toLocaleTimeString()}`;
    quality.className = `quality-label ${isStale || state.lastFrameError ? "warning" : outOfRange ? "bad" : "good"}`;
    quality.lastElementChild.textContent = state.isFrozen
      ? "Display frozen · meter still updating"
      : state.lastFrameError
        ? "Most recent frame not decoded"
      : isStale
        ? `Last valid frame ${secondsSinceValid}s ago`
        : outOfRange
          ? below ? "Below your local minimum" : "Above your local maximum"
          : "Live · frame decoded";
  }

  $("reading-time").classList.toggle("muted", !sample || isStale);
  $("hold-button").disabled = !state.latest;
  $("hold-button").textContent = state.isFrozen ? "Resume live display" : "Freeze display";
  $("save-button").disabled = !state.latest;
  const points = trendPoints().split(" ").filter(Boolean);
  $("trend-line").setAttribute("points", points.join(" "));
  const latestPoint = points.at(-1)?.split(",").map(Number);
  const dot = $("trend-point");
  if (latestPoint) {
    dot.setAttribute("cx", latestPoint[0]);
    dot.setAttribute("cy", latestPoint[1]);
    dot.hidden = false;
    $("chart-empty").hidden = true;
  } else {
    dot.hidden = true;
    $("chart-empty").hidden = false;
  }
}

function trendPoints() {
  const values = state.trend.map((entry) => entry.dissolvedOxygenMgL);
  const unique = values.slice(-30);
  if (!unique.length) return "";
  const maximum = Math.max(5, ...unique) * 1.15;
  return unique.map((value, index) => {
    const x = unique.length === 1 ? 350 : 20 + index * (660 / (unique.length - 1));
    const y = 103 - (value / maximum) * 84;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function receiveValue(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  state.frameCount += 1;
  $("frame-count").textContent = `(${state.frameCount} frames)`;
  const raw = hexBytes(bytes);

  try {
    const decoded = decodeFrame(bytes);
    const sample = { ...decoded, receivedAt: new Date().toISOString(), rawFrame: raw };
    state.latest = sample;
    state.lastFrameError = "";
    state.lastValidAt = Date.now();
    state.trend.push(sample);
    state.trend = state.trend.slice(-30);
    state.readErrorLogged = false;
    $("last-seen").textContent = `Latest valid frame ${new Date(sample.receivedAt).toLocaleTimeString()}`;
    addPacketLog(`RX ${bytes.length} bytes · DO ${sample.dissolvedOxygenMgL.toFixed(2)} mg/L · ${sample.saturationPercent.toFixed(1)}% · ${raw}`);
    maybeAutoSave(sample);
  } catch (error) {
    state.lastFrameError = error.message;
    addPacketLog(`RX ${bytes.length} bytes · ${error.message} · ${raw || "(empty)"}`);
    if (state.lastValidAt) {
      $("last-seen").textContent = "Received an undecodable frame · previous reading may be stale.";
    } else {
      $("last-seen").textContent = `Waiting for a complete measurement frame (${bytes.length} bytes received).`;
    }
    const quality = $("reading-quality");
    quality.className = "quality-label warning";
    quality.lastElementChild.textContent = "Frame not decoded · check diagnostics";
  }
  renderReading();
}

function maybeAutoSave(sample) {
  const interval = Number.parseInt(state.settings.autoSaveSeconds, 10);
  if (!Number.isFinite(interval) || interval <= 0) return;
  const now = Date.now();
  if (now - state.lastAutoSaveAt < interval * 1000) return;
  state.lastAutoSaveAt = now;
  saveReading(sample, "Auto-save");
}

function saveReading(sample = state.latest, note = $("reading-note").value.trim()) {
  if (!sample) return;
  const record = {
    id: crypto.randomUUID(),
    receivedAt: sample.receivedAt,
    dissolvedOxygenMgL: sample.dissolvedOxygenMgL,
    saturationPercent: sample.saturationPercent,
    temperatureC: sample.temperatureC,
    orpMv: sample.orpMv,
    batteryPercent: sample.batteryPercent,
    note,
  };
  state.readings.unshift(record);
  state.readings = state.readings.slice(0, MAX_READINGS);
  storeJson(KEYS.readings, state.readings);
  $("reading-note").value = "";
  renderRecords();
  renderReading();
  showToast(note === "Auto-save" ? "Measurement saved automatically." : "Reading saved to this browser.");
}

function renderRecords() {
  const body = $("records-body");
  body.replaceChildren();
  $("record-count").textContent = String(state.readings.length);
  if (!state.readings.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-table";
    cell.textContent = "No saved readings yet.";
    row.append(cell);
    body.append(row);
    return;
  }

  for (const record of state.readings) {
    const row = document.createElement("tr");
    const date = new Date(record.receivedAt);
    const values = [
      Number(record.dissolvedOxygenMgL).toFixed(2),
      `${Number(record.saturationPercent).toFixed(1)}%`,
      Number(record.temperatureC).toFixed(1),
      String(record.orpMv),
      `${Math.min(100, Math.max(0, Number(record.batteryPercent))).toFixed(0)}%`,
      record.note || "—",
    ];
    const timeCell = document.createElement("td");
    timeCell.textContent = date.toLocaleString();
    row.append(timeCell);
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!state.readings.length) {
    showToast("There are no saved readings to export.");
    return;
  }
  const rows = [["Received at", "DO (mg/L)", "Saturation (%)", "Temperature (°C)", "ORP (mV)", "Battery (%)", "Note"]];
  for (const row of [...state.readings].reverse()) {
    rows.push([row.receivedAt, row.dissolvedOxygenMgL, row.saturationPercent, row.temperatureC, row.orpMv, row.batteryPercent, row.note]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `aquafeed-do-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderCalibrations() {
  const list = $("calibration-records");
  list.replaceChildren();
  if (!state.calibrations.length) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "No calibration entries logged.";
    list.append(item);
    return;
  }
  for (const entry of state.calibrations) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = entry.type;
    const date = document.createElement("small");
    date.textContent = new Date(entry.at).toLocaleString();
    item.append(label, date);
    list.append(item);
  }
}

function updateSettingsControls() {
  $("temperature-setting").value = state.settings.temperatureUnit;
  $("minimum-setting").value = state.settings.minimumMgL;
  $("maximum-setting").value = state.settings.maximumMgL;
  $("autosave-setting").value = state.settings.autoSaveSeconds;
}

function saveSettings() {
  const minimum = $("minimum-setting").value.trim();
  const maximum = $("maximum-setting").value.trim();
  const minValue = minimum === "" ? null : Number(minimum);
  const maxValue = maximum === "" ? null : Number(maximum);
  if ((minValue !== null && (!Number.isFinite(minValue) || minValue < 0 || minValue > 30)) ||
      (maxValue !== null && (!Number.isFinite(maxValue) || maxValue < 0 || maxValue > 30))) {
    showToast("DO limits must be between 0 and 30 mg/L.");
    return false;
  }
  if (minValue !== null && maxValue !== null && minValue > maxValue) {
    showToast("Minimum limit must be less than or equal to maximum limit.");
    return false;
  }
  state.settings = {
    temperatureUnit: $("temperature-setting").value,
    minimumMgL: minimum,
    maximumMgL: maximum,
    autoSaveSeconds: $("autosave-setting").value,
  };
  storeJson(KEYS.settings, state.settings);
  renderReading();
  showToast("Settings saved in this browser.");
  return true;
}

function stopSession() {
  clearInterval(state.readTimer);
  clearInterval(state.refreshTimer);
  state.readTimer = null;
  state.refreshTimer = null;
  state.characteristic?.removeEventListener("characteristicvaluechanged", receiveValue);
  state.characteristic = null;
  state.device = null;
  $("connect-button").disabled = false;
  $("disconnect-button").disabled = true;
  $("device-name").textContent = "No meter connected";
  setConnectionState("Disconnected");
}

async function readCurrentValue() {
  const characteristic = state.characteristic;
  if (!characteristic?.properties.read || state.readInFlight) return;
  state.readInFlight = true;
  try {
    const value = await characteristic.readValue();
    receiveValue({ target: { value } });
  } catch (error) {
    if (!state.readErrorLogged) {
      addPacketLog(`Read failed: ${error.message}`);
      state.readErrorLogged = true;
    }
  } finally {
    state.readInFlight = false;
  }
}

async function connectMeter() {
  if (!navigator.bluetooth) {
    setConnectionState("Browser unsupported", "error");
    $("last-seen").textContent = "Open this page in Chrome or Edge on localhost to use Web Bluetooth.";
    showToast("Web Bluetooth is unavailable in this browser.");
    return;
  }

  $("connect-button").disabled = true;
  state.lastValidAt = 0;
  state.lastFrameError = "";
  setConnectionState("Choose meter…");
  $("last-seen").textContent = "Select BLE-9100 in the browser device picker.";
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "BLE-9100" }],
      optionalServices: [BLE9100_SERVICE],
    });
    state.device = device;
    device.addEventListener("gattserverdisconnected", stopSession);
    setConnectionState("Connecting…");
    $("device-name").textContent = device.name || "BLE-9100";
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE9100_SERVICE);
    const characteristic = await service.getCharacteristic(BLE9100_CHARACTERISTIC);
    state.characteristic = characteristic;
    characteristic.addEventListener("characteristicvaluechanged", receiveValue);

    if (characteristic.properties.notify || characteristic.properties.indicate) {
      try {
        await characteristic.startNotifications();
        addPacketLog("Subscribed to FF02 notifications.");
      } catch (error) {
        addPacketLog(`Notifications unavailable: ${error.message}; will use reads if supported.`);
      }
    }

    setConnectionState("Connected", "connected");
    $("disconnect-button").disabled = false;
    $("last-seen").textContent = "Waiting for the first complete measurement frame.";
    addPacketLog(`Connected to ${device.name || "BLE-9100"}. Service FF01 · characteristic FF02.`);
    await readCurrentValue();
    state.readTimer = setInterval(() => {
      if (!state.lastValidAt || Date.now() - state.lastValidAt > 1600) readCurrentValue();
    }, 1500);
    state.refreshTimer = setInterval(renderReading, 1000);
  } catch (error) {
    addPacketLog(`Connect failed: ${error.message}`);
    setConnectionState("Disconnected", error.name === "NotFoundError" ? "" : "error");
    $("last-seen").textContent = error.name === "NotFoundError"
      ? "No meter selected. Keep the meter nearby and in Bluetooth mode."
      : `Connection failed: ${error.message}`;
    if (deviceIsConnected()) state.device.gatt.disconnect();
    state.device = null;
    $("connect-button").disabled = false;
  }
}

function deviceIsConnected() {
  return Boolean(state.device?.gatt?.connected);
}

$("connect-button").addEventListener("click", connectMeter);
$("disconnect-button").addEventListener("click", () => {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else stopSession();
});
$("hold-button").addEventListener("click", () => {
  state.isFrozen = !state.isFrozen;
  state.frozen = state.isFrozen ? state.latest : null;
  renderReading();
});
$("save-button").addEventListener("click", () => saveReading());
$("export-button").addEventListener("click", exportCsv);
$("print-button").addEventListener("click", () => window.print());
$("clear-records-button").addEventListener("click", () => {
  if (!state.readings.length) return showToast("There are no saved readings to clear.");
  if (!window.confirm(`Delete all ${state.readings.length} saved readings from this browser?`)) return;
  state.readings = [];
  storeJson(KEYS.readings, state.readings);
  renderRecords();
  renderReading();
  showToast("Saved readings cleared.");
});

for (const button of document.querySelectorAll("[data-do-unit]")) {
  button.addEventListener("click", () => {
    state.doUnit = button.dataset.doUnit;
    document.querySelectorAll("[data-do-unit]").forEach((item) => item.classList.toggle("active", item === button));
    renderReading();
  });
}

for (const control of [$("temperature-setting"), $("minimum-setting"), $("maximum-setting"), $("autosave-setting")]) {
  control.addEventListener("change", saveSettings);
}

for (const button of document.querySelectorAll(".calibration-log")) {
  button.addEventListener("click", () => {
    const entry = { type: button.dataset.calibration, at: new Date().toISOString() };
    state.calibrations.unshift(entry);
    state.calibrations = state.calibrations.slice(0, 100);
    storeJson(KEYS.calibrations, state.calibrations);
    renderCalibrations();
    showToast("Calibration entry added to this browser.");
  });
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${tab.dataset.page}`));
    history.replaceState(null, "", `#${tab.dataset.page}`);
  });
}

updateSettingsControls();
renderReading();
renderRecords();
renderCalibrations();

const selectedPage = location.hash.slice(1);
const selectedTab = document.querySelector(`.tab[data-page="${selectedPage}"]`);
if (selectedTab) selectedTab.click();
