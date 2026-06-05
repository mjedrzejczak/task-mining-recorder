// Content script: captures real UI events AND visible page content (e.g. an
// email body), masks PII on-device BEFORE anything leaves the page, detects
// case IDs, and forwards to the background service worker.

(function () {
  "use strict";

  let recording = false;
  chrome.storage.local.get("tm_recording", (r) => { recording = !!r.tm_recording; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tm_recording) recording = !!changes.tm_recording.newValue;
  });

  // --- Application fingerprinting by hostname -----------------------------
  const APP_MAP = [
    [/service-?now/i, "ServiceNow", "#0a6ed1", "SN"],
    [/salesforce|force\.com|lightning/i, "Salesforce", "#1a73e8", "SF"],
    [/sharepoint|office\.com|excel|onedrive|live\.com/i, "Microsoft 365", "#217346", "M"],
    [/outlook|mail\.google|gmail/i, "Mail", "#0a6ed1", "@"],
    [/\bsap\b|s4hana|fiori/i, "SAP", "#7a7a7a", "SAP"],
    [/atlassian|jira/i, "Jira", "#0052cc", "J"],
    [/github/i, "GitHub", "#24292e", "GH"],
    [/google\./i, "Google", "#ea4335", "G"]
  ];
  function appInfo(host) {
    for (const [re, name, color, glyph] of APP_MAP) if (re.test(host)) return { name, color, glyph };
    const short = (host || "page").replace(/^www\./, "");
    return { name: short, color: "#6B6880", glyph: short.slice(0, 2).toUpperCase() };
  }

  // --- PII masking (order matters: specific patterns first) ---------------
  const PII = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "Email"],
    [/\b[A-Z]{2}\d{2}[A-Z0-9]{8,28}\b/g, "IBAN"],
    [/\b(?:\d[ -]?){13,16}\b/g, "Card"],
    [/(?:\+\d[\d().\s-]{7,}\d)|(?:\b\d{3}[\s.\-]\d{3,}[\s.\-]\d{2,}\b)/g, "Phone"]
  ];
  function maskPII(text) {
    if (!text) return { text: "", pii: [] };
    const found = [];
    let out = String(text);
    for (const [re, label] of PII) out = out.replace(re, () => { found.push(label); return "••• [" + label + "]"; });
    return { text: out, pii: found };
  }

  // --- Case-ID detection (labeled patterns; safe to surface) --------------
  const CASE = [
    [/\bINC\d{6,8}\b/g, "Incident"],
    [/\bORD-?\d{3,}\b/gi, "Sales order"],
    [/\bPO-?\d{3,}\b/gi, "Purchase order"],
    [/\bINV-?\d{3,}\b/gi, "Invoice"],
    [/\b45\d{8}\b/g, "Invoice (SAP)"],
    [/\bCASE-?\d{3,}\b/gi, "Case"]
  ];
  function caseIds(text) {
    const ids = [], seen = new Set();
    if (!text) return ids;
    for (const [re, label] of CASE) {
      const m = String(text).match(re);
      if (m) m.forEach((v) => { const k = label + "|" + v; if (!seen.has(k)) { seen.add(k); ids.push({ type: label, value: v }); } });
    }
    return ids;
  }

  // --- Element description --------------------------------------------------
  function labelFor(el) {
    if (!el || !el.tagName) return "";
    let t = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!t && el.id) {
      try { const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lab) t = lab.innerText; } catch (e) {}
    }
    if (!t && el.placeholder) t = el.placeholder;
    if (!t) t = (el.innerText || el.value || el.name || el.tagName || "").toString();
    return t.trim().replace(/\s+/g, " ").slice(0, 160);
  }

  // --- Emit ----------------------------------------------------------------
  function emit(kind, rawText, maxText) {
    if (!recording) return;
    const host = location.hostname;
    const raw = String(rawText || "").slice(0, 20000); // cap before regex work
    const ids = caseIds(raw + " " + location.href);
    const masked = maskPII(raw);
    const cap = maxText || 240;
    const full = masked.text;
    const text = full.length > cap ? full.slice(0, cap) + " …" : full;
    const ev = {
      ts: Date.now(),
      kind,
      app: appInfo(host),
      domain: host,
      url: maskPII(location.href).text,
      text,
      fullLen: full.length,
      pii: masked.pii,
      caseIds: ids
    };
    try { chrome.runtime.sendMessage({ type: "tm_event", event: ev }, () => { void chrome.runtime.lastError; }); } catch (e) {}
  }

  // --- Visible page content (this is what captures the email body) ----------
  function mainNode() {
    return document.querySelector('[role="main"], main, article') || document.body;
  }
  function visibleText() {
    const node = mainNode();
    if (!node) return "";
    let t = (node.innerText || "").replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }
  let lastContent = "";
  let lastContentTs = 0;
  function captureContent() {
    if (!recording) return;
    const now = Date.now();
    if (now - lastContentTs < 1200) return;        // throttle
    const t = visibleText();
    if (!t || t.length < 20) return;
    if (t === lastContent) return;                  // exact dedupe
    // skip near-identical (same length & same first 120 chars)
    if (Math.abs(t.length - lastContent.length) < 12 && t.slice(0, 120) === lastContent.slice(0, 120)) return;
    lastContent = t;
    lastContentTs = now;
    emit("content", t, 1600);
  }

  // --- Interaction listeners -----------------------------------------------
  document.addEventListener("click", (e) => {
    const el = (e.target && e.target.closest) ? (e.target.closest("a,button,input,select,textarea,[role],td,th,li") || e.target) : e.target;
    emit("click", labelFor(el));
    setTimeout(captureContent, 600); // a click often reveals new content (e.g. opening an email)
  }, true);

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || el.type === "password") return;
    const val = ("value" in el) ? el.value : "";
    emit("input", labelFor(el) + (val ? " = " + val : ""));
  }, true);

  // --- Navigation + content triggers ---------------------------------------
  let lastUrl = location.href;
  emit("nav", document.title || location.pathname);
  setTimeout(captureContent, 800);

  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; emit("nav", document.title || location.pathname); setTimeout(captureContent, 700); }
  }, 800);

  // Catch dynamically loaded content (SPA email clients, lazy panels) — debounced
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => { clearTimeout(moTimer); moTimer = setTimeout(captureContent, 1500); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (e) {}

  // Periodic fallback while recording
  setInterval(captureContent, 4000);
})();
