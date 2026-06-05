// Content script — capture visible UI text; redact ALL PII before storage;
// extract case IDs from raw text first so IDs survive redaction.

(function () {
  "use strict";

  const IS_TOP = window === window.top;
  const MIN_IFRAME_CHARS = 40;

  let recording = false;
  chrome.storage.local.get("tm_recording", (r) => { recording = !!r.tm_recording; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tm_recording) recording = !!changes.tm_recording.newValue;
  });

  const APP_MAP = [
    [/service-?now/i, "ServiceNow", "#0a6ed1", "SN"],
    [/salesforce|force\.com|lightning/i, "Salesforce", "#1a73e8", "SF"],
    [/sharepoint|office\.com|excel|onedrive|live\.com/i, "Microsoft 365", "#217346", "M"],
    [/outlook\.(live|office)/i, "Outlook", "#0a6ed1", "@"],
    [/mail\.google|gmail/i, "Gmail", "#ea4335", "G"],
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

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IFRAME"]);
  function deepText(root, maxChars) {
    if (!root) return "";
    const parts = [];
    const limit = maxChars || 80000;
    function walk(node, depth) {
      if (parts.join("").length >= limit || depth > 12) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, " ").trim();
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (SKIP_TAGS.has(node.tagName)) return;
      if (node.shadowRoot) walk(node.shadowRoot, depth + 1);
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], depth + 1);
    }
    walk(root, 0);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function textFrom(el) {
    if (!el) return "";
    return deepText(el, 80000) || (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const t = textFrom(el);
        if (t && t.length > 2) return t;
      } catch (e) {}
    }
    return "";
  }

  /** Email headers: never emit raw From/To — placeholders only; IDs extracted from raw. */
  function scrapeEmailMeta() {
    const blocks = [];
    const allIds = [];

    const subject = firstText([
      '[data-testid="message-header-subject"]', 'h2[data-testid="subject-line"]',
      '.hP', '[role="heading"][aria-level="2"]', 'h1[title]', '.allowTextSelection[role="heading"]'
    ]);
    if (subject) {
      const s = TMScan.scanText(subject);
      allIds.push(...s.caseIds);
      blocks.push("[Subject] " + s.text);
    }

    const fromRaw = firstText([
      '[data-testid="message-header-from"]', '.gD', '[aria-label^="From:"]', 'span[title*="@"]'
    ]);
    if (fromRaw) {
      allIds.push(...TMScan.extractCaseIds(fromRaw));
      blocks.push("[From] ▮▮▮ [Sender extracted]");
    }

    const toRaw = firstText([
      '[data-testid="message-header-to"]', '.g2', '[aria-label^="To:"]'
    ]);
    if (toRaw) {
      allIds.push(...TMScan.extractCaseIds(toRaw));
      blocks.push("[To] ▮▮▮ [Recipient extracted]");
    }

    return { blocks, extraIds: allIds };
  }

  function scrapeContentRegions() {
    const regions = [];
    const seen = new Set();
    function add(label, el) {
      if (!el) return;
      const t = textFrom(el);
      if (!t || t.length < 8) return;
      const key = t.slice(0, 200);
      if (seen.has(key)) return;
      seen.add(key);
      regions.push({ label, text: t });
    }

    const bodySelectors = [
      '[aria-label="Message body"]', '[aria-label="Message Body"]', 'div[role="document"]',
      '[data-app-section="ReadingPane"]', '.ReadingPaneContents', '.allowTextSelection',
      '#UniqueMessageBody', '.elementToProof', '.a3s.aiL', '.ii.gt',
      'div[role="listitem"] .a3s', '[role="article"]', '.message-body', '.email-body'
    ];
    for (const sel of bodySelectors) {
      try { document.querySelectorAll(sel).forEach((el) => add("Email body", el)); } catch (e) {}
    }
    add("Main", document.querySelector('[role="main"], main, article'));
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      if (textFrom(el).length > 15) add("Editor", el);
    });
    document.querySelectorAll("textarea").forEach((el) => {
      if (el.type === "password") return;
      const v = el.value || textFrom(el);
      if (v.length > 15) regions.push({ label: "Textarea", text: v });
    });
    if (regions.length < 2) {
      let n = 0;
      document.querySelectorAll("td, th").forEach((el) => {
        if (n >= 15) return;
        const t = textFrom(el);
        if (t.length > 4 && t.length < 500) { add("Cell", el); n++; }
      });
    }
    return regions;
  }

  function buildContentSnapshot() {
    const meta = scrapeEmailMeta();
    const parts = [...meta.blocks];
    const allIds = [...meta.extraIds];

    for (const r of scrapeContentRegions()) {
      parts.push("[" + r.label + "]\n" + r.text);
      allIds.push(...TMScan.extractCaseIds(r.text));
    }

    if (!IS_TOP && parts.length === meta.blocks.length) {
      const body = textFrom(document.body);
      if (body.length >= MIN_IFRAME_CHARS) {
        parts.push("[Frame content]\n" + body);
        allIds.push(...TMScan.extractCaseIds(body));
      }
    }
    if (IS_TOP && parts.length === meta.blocks.length) {
      const main = textFrom(document.querySelector('[role="main"], main, article') || document.body);
      if (main.length > 30) {
        parts.push("[Page content]\n" + main);
        allIds.push(...TMScan.extractCaseIds(main));
      }
    }

    const raw = parts.join("\n\n").trim();
    const scanned = TMScan.scanText(raw);

    // Merge IDs found in raw regions with scan pass
    const idMap = new Map();
    [...allIds, ...scanned.caseIds].forEach((c) => idMap.set(c.type + "|" + c.value, c));

    return {
      raw,
      text: scanned.text,
      caseIds: [...idMap.values()],
      pii: TMScan.piiLabels(scanned.piiCounts),
      piiCounts: scanned.piiCounts
    };
  }

  function labelFor(el) {
    if (!el || !el.tagName) return "";
    let t = el.getAttribute?.("aria-label") || "";
    if (!t && el.placeholder) t = el.placeholder;
    if (!t) t = (el.innerText || el.name || el.tagName || "").toString();
    return t.trim().replace(/\s+/g, " ").slice(0, 200);
  }

  function isSensitiveInput(el) {
    if (!el || !el.tagName) return false;
    const type = (el.type || "").toLowerCase();
    return type === "password" || el.autocomplete === "cc-number";
  }

  function emit(kind, rawText, opts) {
    if (!recording) return;
    opts = opts || {};
    const host = location.hostname;
    const raw = String(rawText || "").slice(0, 100000);
    if (!raw && kind !== "nav") return;

    const scanned = TMScan.scanText(raw);
    const displayCap = opts.displayCap || (kind === "content" ? 12000 : 800);
    const full = scanned.text;
    const text = full.length > displayCap ? full.slice(0, displayCap) + " …" : full;

    const ev = {
      ts: Date.now(),
      kind,
      app: appInfo(host),
      domain: host,
      url: TMScan.maskPII(location.href).text,
      text,
      fullLen: full.length,
      region: opts.region || null,
      frame: !IS_TOP,
      pii: TMScan.piiLabels(scanned.piiCounts),
      piiCounts: scanned.piiCounts,
      caseIds: opts.caseIds || scanned.caseIds
    };
    try {
      chrome.runtime.sendMessage({ type: "tm_event", event: ev }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  let lastSnap = "";
  let lastSnapTs = 0;
  let snapTimer = null;

  function captureContent(force) {
    if (!recording) return;
    const now = Date.now();
    if (!force && now - lastSnapTs < 800) return;

    const snap = buildContentSnapshot();
    if (!snap.text || snap.text.length < MIN_IFRAME_CHARS) return;
    if (!IS_TOP && snap.text.length < MIN_IFRAME_CHARS) return;
    if (!force && snap.text === lastSnap) return;
    if (!force && Math.abs(snap.text.length - lastSnap.length) < 8 &&
        snap.text.slice(0, 500) === lastSnap.slice(0, 500)) return;

    lastSnap = snap.text;
    lastSnapTs = now;
    emit("content", snap.raw, {
      displayCap: 12000,
      region: snap.text.includes("[Email body]") ? "email" : "page",
      caseIds: snap.caseIds
    });
  }

  function scheduleCapture(delay, force) {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => captureContent(!!force), delay || 400);
  }

  if (IS_TOP) {
    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.("a,button,input,select,textarea,[role],td,th,li") || e.target;
      emit("click", labelFor(el));
      scheduleCapture(500, true);
    }, true);

    document.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || isSensitiveInput(el)) return;
      const val = el.value ?? textFrom(el);
      const label = labelFor(el);
      const raw = val ? label + " = " + val : label;
      emit("input", raw, { displayCap: 4000 });
      scheduleCapture(600);
    }, true);

    document.addEventListener("change", (e) => {
      const el = e.target;
      if (!el || isSensitiveInput(el)) return;
      emit("input", labelFor(el) + (el.value ? " = " + el.value : ""), { displayCap: 4000 });
      scheduleCapture(400);
    }, true);

    document.addEventListener("focusin", (e) => {
      const el = e.target;
      if (el?.isContentEditable || el?.tagName === "TEXTAREA") scheduleCapture(300, true);
    }, true);

    let lastUrl = location.href;
    emit("nav", document.title || location.pathname);
    scheduleCapture(900, true);
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        emit("nav", document.title || location.pathname);
        lastSnap = "";
        scheduleCapture(700, true);
      }
    }, 700);
  }

  let moTimer = null;
  try {
    const mo = new MutationObserver(() => { clearTimeout(moTimer); moTimer = setTimeout(() => scheduleCapture(900), 900); });
    const start = () => mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  } catch (e) {}

  setInterval(() => { if (recording) scheduleCapture(0); }, IS_TOP ? 3000 : 2000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tm_recording?.newValue === true) {
      lastSnap = "";
      setTimeout(() => captureContent(true), 500);
      setTimeout(() => captureContent(true), 2000);
    }
  });

  if (recording) setTimeout(() => captureContent(true), 600);
})();
