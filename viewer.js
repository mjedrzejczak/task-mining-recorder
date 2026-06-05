const $ = (id) => document.getElementById(id);
const KIND_LABEL = { click: "Click", input: "Input", nav: "Nav" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function glyph(app) {
  return `<span class="glyph" style="background:${esc(app.color)}">${esc(app.glyph)}</span>`;
}

function renderState(rec, n) {
  $("recDot").classList.toggle("on", !!rec);
  $("recState").textContent = rec ? "Recording…" : "Not recording";
  $("recMeta").textContent = n ? `${n.toLocaleString()} events` : "";
  const t = $("toggle");
  t.textContent = rec ? "Stop recording" : "Start recording";
  t.className = rec ? "btn btn-stop" : "btn btn-primary";
}

function render(events, rec) {
  events = Array.isArray(events) ? events : [];
  renderState(rec, events.length);

  // KPIs + aggregates
  const apps = new Map();   // name -> {info, count}
  const ids = new Map();    // type|value -> {type, value, app}
  const pii = new Map();    // label -> count
  let piiTotal = 0;

  for (const e of events) {
    const a = apps.get(e.app.name) || { info: e.app, count: 0 };
    a.count++; apps.set(e.app.name, a);
    (e.pii || []).forEach((p) => { pii.set(p, (pii.get(p) || 0) + 1); piiTotal++; });
    (e.caseIds || []).forEach((c) => {
      const k = c.type + "|" + c.value;
      if (!ids.has(k)) ids.set(k, { type: c.type, value: c.value, app: e.app });
    });
  }

  $("kEvents").textContent = events.length.toLocaleString();
  $("kApps").textContent = apps.size;
  $("kPii").textContent = piiTotal.toLocaleString();
  $("kIds").textContent = ids.size;

  // Stream (newest first, cap render to last 150 for perf)
  const recent = events.slice(-150).reverse();
  $("stream").innerHTML = recent.length ? recent.map((e) => {
    const piiBadges = (e.pii || []).map((p) => `<span class="badge b-danger">masked: ${esc(p)}</span>`).join(" ");
    const idBadges = (e.caseIds || []).map((c) => `<span class="badge b-success">${esc(c.type)}: ${esc(c.value)}</span>`).join(" ");
    return `<div class="ev">
      <span class="t">${timeStr(e.ts)}</span>
      <span class="k">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
      <div class="body">
        <div class="txt">${esc(e.text) || "<span style='color:var(--text3)'>(no text)</span>"}</div>
        <div class="meta">
          <span class="chip">${glyph(e.app)}${esc(e.app.name)}</span>
          ${idBadges} ${piiBadges}
        </div>
      </div>
    </div>`;
  }).join("") : `<div class="empty">No events yet. Click <strong>Start recording</strong>, then browse in any tab.</div>`;

  // Apps
  const appRows = [...apps.values()].sort((a, b) => b.count - a.count);
  $("apps").innerHTML = appRows.length ? appRows.map((a) =>
    `<div class="list-row"><span class="chip">${glyph(a.info)}${esc(a.info.name)}</span><span class="mono" style="color:var(--text2)">${a.count}</span></div>`
  ).join("") : `<div class="empty">—</div>`;

  // Case IDs
  const idRows = [...ids.values()];
  $("ids").innerHTML = idRows.length ? idRows.map((c) =>
    `<div class="list-row"><span><span class="badge b-accent">${esc(c.type)}</span> <span class="mono">${esc(c.value)}</span></span><span class="chip">${glyph(c.app)}${esc(c.app.name)}</span></div>`
  ).join("") : `<div class="empty">No case IDs detected yet — open a record with an ID (INV…, ORD-…, INC…).</div>`;

  // PII
  const piiRows = [...pii.entries()].sort((a, b) => b[1] - a[1]);
  $("pii").innerHTML = piiRows.length ? piiRows.map(([label, n]) =>
    `<div class="list-row"><span class="badge b-danger">${esc(label)}</span><span class="mono" style="color:var(--text2)">${n} masked</span></div>`
  ).join("") : `<div class="empty">No PII detected in captured text yet.</div>`;
}

function refresh() {
  chrome.storage.local.get(["tm_events", "tm_recording"], (r) => {
    render(r.tm_events, !!r.tm_recording);
  });
}

$("toggle").addEventListener("click", () => {
  chrome.storage.local.get("tm_recording", (r) => {
    chrome.runtime.sendMessage({ cmd: r.tm_recording ? "stop" : "start" }, () => { void chrome.runtime.lastError; });
  });
});
$("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "clear" }, () => { void chrome.runtime.lastError; });
});

chrome.storage.onChanged.addListener((c, area) => { if (area === "local") refresh(); });
refresh();
