// Content script: captures real UI events on the page, masks PII on-device
// BEFORE anything leaves the page, detects case IDs, and forwards to the
// background service worker. Raw PII values never leave this content script.

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
    [/outlook/i, "Outlook", "#0a6ed1", "O"],
    [/\bsap\b|s4hana|fiori/i, "SAP", "#7a7a7a", "SAP"],
    [/atlassian|jira/i, "Jira", "#0052cc", "J"],
    [/github/i, "GitHub", "#24292e", "GH"],
    [/google\.|gmail/i, "Google", "#ea4335", "G"]
  ];
  function appInfo(host) {
    for (const [re, name, color, glyph] of APP_MAP) {
      if (re.test(host)) return { name, color, glyph };
    }
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
    for (const [re, label] of PII) {
      out = out.replace(re, () => { found.push(label); return "••• [" + label + "]"; });
    }
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
    const ids = [];
    const seen = new Set();
    if (!text) return ids;
    for (const [re, label] of CASE) {
      const m = String(text).match(re);
      if (m) m.forEach((v) => {
        const key = label + "|" + v;
        if (!seen.has(key)) { seen.add(key); ids.push({ type: label, value: v }); }
      });
    }
    return ids;
  }

  // --- Element description --------------------------------------------------
  function labelFor(el) {
    if (!el || !el.tagName) return "";
    let t = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!t && el.id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) t = lab.innerText;
      } catch (e) { /* ignore */ }
    }
    if (!t && el.placeholder) t = el.placeholder;
    if (!t) t = (el.innerText || el.value || el.name || el.tagName || "").toString();
    return t.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  function selectorFor(el) {
    if (!el || !el.tagName) return "";
    if (el.id) return "#" + el.id;
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + cls;
  }

  // --- Emit ----------------------------------------------------------------
  function emit(kind, rawText) {
    if (!recording) return;
    const host = location.hostname;
    const ids = caseIds(rawText + " " + location.href);
    const masked = maskPII(rawText);
    const maskedUrl = maskPII(location.href);
    const ev = {
      ts: Date.now(),
      kind: kind,
      app: appInfo(host),
      domain: host,
      url: maskedUrl.text,
      text: masked.text,
      pii: masked.pii,
      caseIds: ids
    };
    try {
      chrome.runtime.sendMessage({ type: "tm_event", event: ev }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* SW restarting */ }
  }

  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest("a,button,input,select,textarea,[role],td,th,li,span,div") || e.target : e.target;
    emit("click", labelFor(el));
  }, true);

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el) return;
    if (el.type === "password" || el.autocomplete === "off-sensitive") return;
    const val = ("value" in el) ? el.value : "";
    emit("input", (labelFor(el) + (val ? " = " + val : "")));
  }, true);

  let lastUrl = location.href;
  function navOnce() { emit("nav", document.title || location.pathname); }
  navOnce();
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; navOnce(); }
  }, 800);
})();
