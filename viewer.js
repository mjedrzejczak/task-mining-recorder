const $ = (id) => document.getElementById(id);
const KIND_LABEL = { click: "Click", input: "Input", nav: "Nav", content: "Content" };

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

/** Highlight redaction tokens in already-escaped text */
function formatContent(escaped) {
  return escaped.replace(/▮▮▮ \[([^\]]+) extracted\]/g,
    '<span class="pii-token">▮▮▮ [$1 extracted]</span>');
}

function piiBadges(e) {
  if (e.piiCounts && typeof e.piiCounts === "object") {
    return Object.entries(e.piiCounts)
      .map(([label, n]) => `<span class="badge b-danger">${esc(label)} × ${n}</span>`).join(" ");
  }
  const counts = {};
  (e.pii || []).forEach((p) => { counts[p] = (counts[p] || 0) + 1; });
  return Object.entries(counts)
    .map(([label, n]) => `<span class="badge b-danger">${esc(label)} × ${n}</span>`).join(" ");
}

function renderState(rec, n) {
  $("recDot").classList.toggle("on", !!rec);
  $("recState").textContent = rec ? "Recording…" : "Not recording";
  $("recMeta").textContent = n ? `${n.toLocaleString()} events` : "";
  const t = $("toggle");
  t.textContent = rec ? "Stop recording" : "Start recording";
  t.className = rec ? "btn btn-stop" : "btn btn-primary";
}

/** Collect every case ID from events + re-scan text for anything missed */
function collectCaseIds(events) {
  const idMap = new Map();

  function add(c, app, source) {
    const value = String(c.value || "").trim();
    if (!value) return;
    const type = c.type || "Unknown";
    const object = c.object || (typeof TMScan !== "undefined" ? TMScan.objectFor(type) : type);
    const k = type + "|" + value.toUpperCase();
    if (!idMap.has(k)) {
      idMap.set(k, { type, value, object, app, sources: new Set() });
    }
    idMap.get(k).sources.add(source);
  }

  for (const e of events) {
    (e.caseIds || []).forEach((c) => add(c, e.app, KIND_LABEL[e.kind] || e.kind));
    if (typeof TMScan !== "undefined" && e.text) {
      TMScan.extractCaseIds(e.text).forEach((c) => add(c, e.app, (KIND_LABEL[e.kind] || e.kind) + " (rescan)"));
    }
  }
  return idMap;
}

function aggregate(events) {
  const apps = new Map();
  let piiTotal = 0;

  for (const e of events) {
    let a = apps.get(e.app.name);
    if (!a) { a = { info: e.app, count: 0, pii: new Map(), piiTotal: 0 }; apps.set(e.app.name, a); }
    a.count++;
    if (e.piiCounts) {
      Object.entries(e.piiCounts).forEach(([label, n]) => {
        a.pii.set(label, (a.pii.get(label) || 0) + n);
        a.piiTotal += n;
        piiTotal += n;
      });
    } else {
      (e.pii || []).forEach((p) => {
        a.pii.set(p, (a.pii.get(p) || 0) + 1);
        a.piiTotal++;
        piiTotal++;
      });
    }
  }

  const idMap = collectCaseIds(events);
  const objects = new Map();
  for (const id of idMap.values()) {
    let o = objects.get(id.object);
    if (!o) { o = { count: 0, types: new Set(), ids: [] }; objects.set(id.object, o); }
    o.count++;
    o.types.add(id.type);
    o.ids.push(id.value);
  }

  return { apps, idMap, objects, piiTotal };
}

function render(events, rec) {
  events = Array.isArray(events) ? events : [];
  renderState(rec, events.length);
  const { apps, idMap, objects, piiTotal } = aggregate(events);
  const allIds = [...idMap.values()];

  $("kEvents").textContent = events.length.toLocaleString();
  $("kApps").textContent = apps.size;
  $("kPii").textContent = piiTotal.toLocaleString();
  $("kIds").textContent = allIds.length;

  const recent = events.slice(-150).reverse();
  $("stream").innerHTML = recent.length ? recent.map((e) => {
    const idB = (e.caseIds || []).map((c) =>
      `<span class="badge b-success">${esc(c.type)}: <span class="mono">${esc(c.value)}</span></span>`
    ).join(" ");
    const lenB = (e.kind === "content" && e.fullLen) ? `<span class="badge b-neutral">${e.fullLen.toLocaleString()} chars</span>` : "";
    const regionB = e.region ? `<span class="badge b-accent">${esc(e.region)}</span>` : "";
    const frameB = e.frame ? `<span class="badge b-neutral">iframe</span>` : "";
    const body = e.kind === "content"
      ? formatContent(esc(e.text))
      : esc(e.text);
    const txtClass = e.kind === "content" ? "txt content" : "txt";
    return `<div class="ev"><span class="t">${timeStr(e.ts)}</span><span class="k">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
      <div class="body"><div class="${txtClass}">${body || "<span style='color:var(--text3)'>(no text)</span>"}</div>
      <div class="meta">${chip(e.app)} ${regionB} ${frameB} ${idB} ${piiBadges(e)} ${lenB}</div></div></div>`;
  }).join("") : `<div class="empty">No events yet. Click <strong>Start recording</strong>, then browse in any tab.</div>`;

  const appRows = [...apps.values()].sort((a, b) => b.count - a.count);
  $("apps").innerHTML = appRows.length ? appRows.map((a) =>
    `<div class="list-row">${chip(a.info)}<span class="mono" style="color:var(--text2)">${a.count}</span></div>`
  ).join("") : `<div class="empty">—</div>`;

  const privBody = appRows.length ? appRows.map((a) => {
    const cats = [...a.pii.keys()];
    const catHtml = cats.length ? cats.map((c) => `<span class="badge b-neutral">${esc(c)} × ${a.pii.get(c)}</span>`).join(" ")
      : `<span style="color:var(--text3)">none detected</span>`;
    const verdict = a.piiTotal > 0
      ? `<span class="badge b-success">● Redacted</span>`
      : `<span class="badge b-neutral">No PII seen</span>`;
    const mask = a.piiTotal > 0 ? `<span class="mono">${a.piiTotal} extracted &amp; hidden</span>` : `<span class="mono" style="color:var(--text3)">—</span>`;
    return `<tr><td>${chip(a.info)}</td><td>${catHtml}</td><td>${mask}</td><td>${verdict}</td></tr>`;
  }).join("") : `<tr><td colspan="4"><div class="empty">No apps scanned yet.</div></td></tr>`;
  $("privacyTbl").querySelector("tbody").innerHTML = privBody;

  const idsBody = allIds.length ? allIds.map((c) =>
    `<tr>
      <td><span class="badge b-accent">${esc(c.type)}</span></td>
      <td class="mono">${esc(c.value)}</td>
      <td><span class="badge b-success">${esc(c.object)}</span></td>
      <td>${chip(c.app)}</td>
      <td class="hint">${esc([...c.sources].join(", "))}</td>
    </tr>`
  ).join("") : `<tr><td colspan="5"><div class="empty">No case IDs detected yet. Try opening an email or record that mentions INV…, ORD-…, PO-…, INC…, or labeled IDs like "Invoice: 450021987".</div></td></tr>`;
  $("idsTbl").querySelector("tbody").innerHTML = idsBody;

  const objRows = [...objects.entries()].sort((a, b) => b[1].count - a[1].count);
  $("objects").innerHTML = objRows.length ? objRows.map(([name, o]) =>
    `<div class="cov-card">
      <div class="cov-name">${esc(name)} <span class="badge b-success">● ${o.count} ID${o.count === 1 ? "" : "s"}</span></div>
      <div class="cov-meta">Types: ${[...o.types].map(esc).join(", ")}</div>
      <div class="cov-meta mono" style="margin-top:4px;font-size:11px;">${o.ids.slice(0, 8).map(esc).join(" · ")}${o.ids.length > 8 ? " …" : ""}</div>
    </div>`
  ).join("") : `<div class="empty">No objects mapped yet — case IDs will appear here with their business object.</div>`;
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
