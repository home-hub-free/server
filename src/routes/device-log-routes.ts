import { Express } from "express";
import { addDeviceLog, getDeviceLogs } from "../handlers/device-log.handler";
import { log, EVENT_TYPES } from "../logger";

export function initDeviceLogRoutes(app: Express) {
  // Devices POST diagnostic log lines here (HomeHubDevice::log()). Built for
  // devices with no usable USB serial console — e.g. the presence-sensor, whose
  // UART0 is the radar. Body: { id, name?, level?, msg, ms? }.
  app.post("/device-log", (request, response) => {
    const { id, name, level, msg, ms } = request.body || {};
    if (id === undefined || msg === undefined) {
      return response.send(false);
    }
    addDeviceLog({
      id: String(id),
      name,
      level: level || "info",
      msg: String(msg),
      ms: typeof ms === "number" ? ms : undefined,
    });
    response.send(true);
  });

  // Backlog for the ops page (and any tooling). ?id= filters to one device,
  // ?limit= caps the number of lines returned (most recent).
  app.get("/device-logs", (request, response) => {
    const id = request.query.id ? String(request.query.id) : undefined;
    const limit = request.query.limit
      ? parseInt(String(request.query.limit), 10)
      : 200;
    response.send(getDeviceLogs(id, limit));
  });

  // The ops page itself: a self-contained live log viewer. Served by the hub so
  // it needs no dashboard build/deploy and works on the Pi immediately.
  app.get("/ops", (_request, response) => {
    response.type("html").send(OPS_PAGE);
  });

  log(EVENT_TYPES.info, ["device-log routes ready — ops page at /ops"]);
}

// Single-file ops page. Pulls the socket.io client the server already serves at
// /socket.io/socket.io.js, fetches the backlog from /device-logs, then live-
// tails the `device-log` WS event. Device filter + pause + clear, dark/mono.
const OPS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>home-hub · ops logs</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0e1116; color: #c9d1d9;
  }
  header {
    position: sticky; top: 0; display: flex; gap: 12px; align-items: center;
    padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; color: #e6edf3; }
  header .grow { flex: 1; }
  select, button {
    font: inherit; background: #21262d; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer;
  }
  button.active { border-color: #2f81f7; color: #2f81f7; }
  #status { font-size: 12px; color: #8b949e; }
  #status.live::before { content: "● "; color: #3fb950; }
  #status.down::before { content: "● "; color: #f85149; }
  #log { padding: 8px 14px; }
  .row { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
  .row:hover { background: #161b22; }
  .t { color: #6e7681; flex: none; }
  .d { color: #58a6ff; flex: none; min-width: 90px; }
  .lvl { flex: none; min-width: 44px; text-transform: uppercase; font-size: 11px; }
  .lvl.info { color: #8b949e; }
  .lvl.warn { color: #d29922; }
  .lvl.error { color: #f85149; }
  .m { color: #c9d1d9; }
  #empty { color: #6e7681; padding: 24px 14px; }
</style>
</head>
<body>
<header>
  <h1>home-hub · ops</h1>
  <label>device <select id="device"><option value="">all</option></select></label>
  <button id="pause">pause</button>
  <button id="clear">clear</button>
  <span class="grow"></span>
  <span id="status">connecting…</span>
</header>
<div id="log"></div>
<div id="empty">No logs yet. Devices report here via POST /device-log.</div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const logEl = document.getElementById("log");
  const emptyEl = document.getElementById("empty");
  const deviceSel = document.getElementById("device");
  const pauseBtn = document.getElementById("pause");
  const clearBtn = document.getElementById("clear");
  const statusEl = document.getElementById("status");

  let paused = false;
  const seenDevices = new Map(); // id -> name
  const entries = [];            // keep everything; render filters

  function label(e) { return (e.name ? e.name + " · " : "") + e.id; }

  function ensureDeviceOption(e) {
    const key = String(e.id);
    if (seenDevices.has(key)) return;
    seenDevices.set(key, e.name);
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label(e);
    deviceSel.appendChild(opt);
  }

  function matchesFilter(e) {
    const f = deviceSel.value;
    return !f || String(e.id) === f;
  }

  function fmtTime(at) {
    const d = new Date(at);
    return d.toLocaleTimeString([], { hour12: false }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function renderRow(e) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<span class="t">' + fmtTime(e.at) + '</span>' +
      '<span class="d">' + escapeHtml(label(e)) + '</span>' +
      '<span class="lvl ' + escapeHtml(e.level || "info") + '">' + escapeHtml(e.level || "info") + '</span>' +
      '<span class="m">' + escapeHtml(e.msg) + '</span>';
    return row;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function add(e, live) {
    entries.push(e);
    ensureDeviceOption(e);
    if (!matchesFilter(e)) return;
    emptyEl.style.display = "none";
    if (paused && live) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
    logEl.appendChild(renderRow(e));
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  function rerender() {
    logEl.innerHTML = "";
    const shown = entries.filter(matchesFilter);
    emptyEl.style.display = shown.length ? "none" : "block";
    shown.forEach((e) => logEl.appendChild(renderRow(e)));
    window.scrollTo(0, document.body.scrollHeight);
  }

  deviceSel.addEventListener("change", rerender);
  clearBtn.addEventListener("click", () => { entries.length = 0; rerender(); });
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "resume" : "pause";
    pauseBtn.classList.toggle("active", paused);
    if (!paused) rerender();
  });

  // Backlog first, then go live.
  fetch("/device-logs?limit=500")
    .then((r) => r.json())
    .then((rows) => { rows.forEach((e) => add(e, false)); })
    .catch(() => {});

  const socket = io();
  socket.on("connect", () => { statusEl.textContent = "live"; statusEl.className = "live"; });
  socket.on("disconnect", () => { statusEl.textContent = "disconnected"; statusEl.className = "down"; });
  socket.on("device-log", (e) => add(e, true));
</script>
</body>
</html>`;
