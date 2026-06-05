const $ = (id) => document.getElementById(id);
const KIND_LABEL = { click: "Click", input: "Input", nav: "Nav", content: "Content" };

// Maps a detected case-ID type to the business object it represents.
const OBJECT_MAP = {
  "Incident": "Service Ticket",
  "Case": "Service Ticket",
  "Sales order": "Sales Order",
  "Purchase order": "Purchase Order",
  "Invoice": "Invoice",
  "Invoice (SAP)": "Invoice"
};

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function glyph(app) {
  return `<span class="glyph" style="background:${esc(app.color)}">${esc(app.glyph)}</span>`;
}
function chip(app) {
  return `<span class="chip">${glyph(app)}${esc(app.name)}</span>`;
}

function renderState(rec, n) {
  $("recDot").classList.toggle("on", !!rec);
  $("recState").textContent = rec ? "Recording…" : "Not recording";
  $("recMeta").textContent = n ? `${n.toLocaleString()} events` : "";
  const t = $("toggle");
  t.textContent = rec ? "Stop recording" : "Start recording";
  t.className = rec ? "btn btn-stop" : "btn btn-primary";
}

function aggregate(events) {
  const apps = new Map();   // name -> { info, count, pii:Map(label->n), piiTotal }
  const idMap = new Map();  // type|value -> { type, value, app }
  const objects = new Map();// object -> { count, types:Set }
  let piiTotal = 0;

  for (const e of events) {
    let a = apps.get(e.app.name);
    if (!a) { a = { info: e.app, count: 0, pii: new Map(), piiTotal: 0 }; apps.set(e.app.name, a); }
    a.count++;
    (e.pii || []).forEach((p) => { a.pii.set(p, (a.pii.get(p) || 0) + 1); a.piiTotal++; piiTotal++; });
    (e.caseIds || []).forEach((c) => {
      const k = c.type + "|" + c.value;
      if (!idMap.has(k)) idMap.set(k, { type: c.type, value: c.value, app: e.app });
      const obj = OBJECT_MAP[c.type] || c.type;
      let o = objects.get(obj);
      if (!o) { o = { count: 0, types: new Set() }; objects.set(obj, o); }
      if (!idMap.has(k + "#counted")) { idMap.set(k + "#counted", true); o.count++; o.types.add(c.type); }
    });
  }
  return { apps, idMap, objects, piiTotal };
}

function render(events, rec) {
  events = Array.isArray(events) ? events : [];
  renderState(rec, events.length);
  const { apps, idMap, objects, piiTotal } = aggregate(events);
  const realIds = [...idMap.entries()].filter(([k]) => !k.endsWith("#counted")).map(([, v]) => v);

  $("kEvents").textContent = events.length.toLocaleString();
  $("kApps").textContent = apps.size;
  $("kPii").textContent = piiTotal.toLocaleString();
  $("kIds").textContent = realIds.length;

  // --- Tab 1: stream ---
  const recent = events.slice(-150).reverse();
  $("stream").innerHTML = recent.length ? recent.map((e) => {
    const piiB = (e.pii || []).map((p) => `<span class="badge b-danger">masked: ${esc(p)}</span>`).join(" ");
    const idB = (e.caseIds || []).map((c) => `<span class="badge b-success">${esc(c.type)}: ${esc(c.value)}</span>`).join(" ");
    const lenB = (e.kind === "content" && e.fullLen) ? `<span class="badge b-neutral">${e.fullLen.toLocaleString()} chars</span>` : "";
    const regionB = e.region ? `<span class="badge b-accent">${esc(e.region)}</span>` : "";
    const frameB = e.frame ? `<span class="badge b-neutral">iframe</span>` : "";
    const txtClass = e.kind === "content" ? "txt content" : "txt";
    return `<div class="ev"><span class="t">${timeStr(e.ts)}</span><span class="k">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
      <div class="body"><div class="${txtClass}">${esc(e.text) || "<span style='color:var(--text3)'>(no text)</span>"}</div>
      <div class="meta">${chip(e.app)} ${regionB} ${frameB} ${idB} ${piiB} ${lenB}</div></div></div>`;
  }).join("") : `<div class="empty">No events yet. Click <strong>Start recording</strong>, then browse in any tab.</div>`;

  const appRows = [...apps.values()].sort((a, b) => b.count - a.count);
  $("apps").innerHTML = appRows.length ? appRows.map((a) =>
    `<div class="list-row">${chip(a.info)}<span class="mono" style="color:var(--text2)">${a.count}</span></div>`
  ).join("") : `<div class="empty">—</div>`;

  // --- Tab 2: privacy verdict per app ---
  const privBody = appRows.length ? appRows.map((a) => {
    const cats = [...a.pii.keys()];
    const catHtml = cats.length ? cats.map((c) => `<span class="badge b-neutral">${esc(c)}</span>`).join(" ")
      : `<span style="color:var(--text3)">none detected</span>`;
    const verdict = a.piiTotal > 0
      ? `<span class="badge b-success">● PII masked</span>`
      : `<span class="badge b-neutral">No PII seen</span>`;
    const mask = a.piiTotal > 0 ? `<span class="mono">${a.piiTotal}/${a.piiTotal} masked</span>` : `<span class="mono" style="color:var(--text3)">—</span>`;
    return `<tr><td>${chip(a.info)}</td><td>${catHtml}</td><td>${mask}</td><td>${verdict}</td></tr>`;
  }).join("") : `<tr><td colspan="4"><div class="empty">No apps scanned yet.</div></td></tr>`;
  $("privacyTbl").querySelector("tbody").innerHTML = privBody;

  // --- Tab 3: case IDs + objects ---
  const idsBody = realIds.length ? realIds.map((c) =>
    `<tr><td><span class="badge b-accent">${esc(c.type)}</span></td><td class="mono">${esc(c.value)}</td><td>${chip(c.app)}</td></tr>`
  ).join("") : `<tr><td colspan="3"><div class="empty">No case IDs detected yet — open a record with an ID (INV…, ORD-…, INC…).</div></td></tr>`;
  $("idsTbl").querySelector("tbody").innerHTML = idsBody;

  const objRows = [...objects.entries()];
  $("objects").innerHTML = objRows.length ? objRows.map(([name, o]) =>
    `<div class="cov-card"><div class="cov-name">${esc(name)} <span class="badge b-success">● Covered</span></div>
     <div class="cov-meta">${o.count} ID${o.count === 1 ? "" : "s"} found · keyed by ${[...o.types].map(esc).join(", ")}</div></div>`
  ).join("") : `<div class="empty">No objects yet — detected case IDs will map to objects here.</div>`;
}

function refresh() {
  chrome.storage.local.get(["tm_events", "tm_recording"], (r) => render(r.tm_events, !!r.tm_recording));
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("panel-" + tab.dataset.tab).classList.add("active");
  });
});

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
