// Content script — capture as much visible UI text as possible; mask PII on-device
// before anything is stored. Runs in top frame + iframes (email bodies are often
// inside iframes in Gmail / Outlook Web).

(function () {
  "use strict";

  const IS_TOP = window === window.top;
  const MIN_IFRAME_CHARS = 40; // ignore tiny tracking/ad iframes

  let recording = false;
  chrome.storage.local.get("tm_recording", (r) => { recording = !!r.tm_recording; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tm_recording) recording = !!changes.tm_recording.newValue;
  });

  // --- App fingerprint ------------------------------------------------------
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

  // --- PII masking (everything else is kept) --------------------------------
  const PII = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "Email"],
    [/\b[A-Z]{2}\d{2}[A-Z0-9]{8,28}\b/g, "IBAN"],
    [/\b(?:\d[ -]?){13,19}\b/g, "Card"],
    [/(?:\+\d[\d().\s-]{7,}\d)|(?:\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,}[\s.-]?\d{3,}\b)/g, "Phone"],
    [/\b\d{3}-\d{2}-\d{4}\b/g, "SSN"]
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

  const CASE = [
    [/\bINC\d{6,8}\b/g, "Incident"],
    [/\bORD-?\d{3,}\b/gi, "Sales order"],
    [/\bPO-?\d{3,}\b/gi, "Purchase order"],
    [/\bINV-?\d{3,}\b/gi, "Invoice"],
    [/\b45\d{8}\b/g, "Invoice (SAP)"],
    [/\bCASE-?\d{3,}\b/gi, "Case"],
    [/\bREF-?\d{3,}\b/gi, "Reference"]
  ];
  function caseIds(text) {
    const ids = [], seen = new Set();
    if (!text) return ids;
    for (const [re, label] of CASE) {
      const m = String(text).match(re);
      if (m) m.forEach((v) => {
        const k = label + "|" + v;
        if (!seen.has(k)) { seen.add(k); ids.push({ type: label, value: v }); }
      });
    }
    return ids;
  }

  // --- Deep text (includes open shadow roots) -------------------------------
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
      const el = node;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i], depth + 1);
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
      } catch (e) { /* invalid selector in some contexts */ }
    }
    return "";
  }

  // --- Email / rich-content regions -----------------------------------------
  function scrapeEmailMeta() {
    const blocks = [];
    const subject = firstText([
      '[data-testid="message-header-subject"]',
      'h2[data-testid="subject-line"]',
      '.hP', // Gmail subject
      '[role="heading"][aria-level="2"]',
      'h1[title]',
      '.allowTextSelection[role="heading"]'
    ]);
    if (subject) blocks.push("[Subject] " + subject);

    const from = firstText([
      '[data-testid="message-header-from"]',
      '.gD', // Gmail from
      '[aria-label^="From:"]',
      'span[title*="@"]'
    ]);
    if (from) blocks.push("[From] " + from.slice(0, 200));

    const to = firstText([
      '[data-testid="message-header-to"]',
      '.g2', // Gmail to
      '[aria-label^="To:"]'
    ]);
    if (to) blocks.push("[To] " + to.slice(0, 200));

    return blocks;
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

    // Email body — Outlook, Gmail, generic
    const bodySelectors = [
      '[aria-label="Message body"]',
      '[aria-label="Message Body"]',
      'div[role="document"]',
      '[data-app-section="ReadingPane"]',
      '.ReadingPaneContents',
      '.allowTextSelection',
      '#UniqueMessageBody',
      '.elementToProof',
      '.a3s.aiL',           // Gmail message body
      '.ii.gt',              // Gmail alt
      'div[role="listitem"] .a3s',
      '[role="article"]',
      '.message-body',
      '.email-body'
    ];
    for (const sel of bodySelectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => add("Email body", el));
      } catch (e) {}
    }

    // Main reading pane fallback
    add("Main", document.querySelector('[role="main"], main, article'));

    // All substantial contenteditable (compose / inline editors)
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      if (textFrom(el).length > 15) add("Editor", el);
    });

    // Large text areas (not password)
    document.querySelectorAll("textarea").forEach((el) => {
      if (el.type === "password") return;
      const v = el.value || textFrom(el);
      if (v.length > 15) regions.push({ label: "Textarea", text: v });
    });

    // Table cells — only when we haven't found richer content (avoids list-view noise)
    if (regions.length < 2) {
      let cellCount = 0;
      document.querySelectorAll("td, th").forEach((el) => {
        if (cellCount >= 15) return;
        const t = textFrom(el);
        if (t.length > 4 && t.length < 500) { add("Cell", el); cellCount++; }
      });
    }

    return regions;
  }

  function buildContentSnapshot() {
    const parts = [];
    const meta = scrapeEmailMeta();
    parts.push(...meta);

    const regions = scrapeContentRegions();
    for (const r of regions) {
      parts.push("[" + r.label + "]\n" + r.text);
    }

    // Iframe-only: if no regions matched, use whole document body
    if (!IS_TOP && parts.length === 0) {
      const body = textFrom(document.body);
      if (body.length >= MIN_IFRAME_CHARS) parts.push("[Frame content]\n" + body);
    }

    // Top frame last resort: visible main area
    if (IS_TOP && parts.length === meta.length) {
      const main = textFrom(document.querySelector('[role="main"], main, article') || document.body);
      if (main.length > 30) parts.push("[Page content]\n" + main);
    }

    return parts.join("\n\n").trim();
  }

  // --- Element helpers ------------------------------------------------------
  function labelFor(el) {
    if (!el || !el.tagName) return "";
    let t = el.getAttribute?.("aria-label") || "";
    if (!t && el.id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) t = lab.innerText;
      } catch (e) {}
    }
    if (!t && el.placeholder) t = el.placeholder;
    if (!t) t = (el.innerText || el.value || el.name || el.tagName || "").toString();
    return t.trim().replace(/\s+/g, " ").slice(0, 300);
  }

  function isSensitiveInput(el) {
    if (!el || !el.tagName) return false;
    const type = (el.type || "").toLowerCase();
    return type === "password" || el.autocomplete === "cc-number";
  }

  // --- Emit -----------------------------------------------------------------
  function emit(kind, rawText, opts) {
    if (!recording) return;
    opts = opts || {};
    const host = location.hostname;
    const raw = String(rawText || "").slice(0, 100000);
    if (!raw && kind !== "nav") return;

    const ids = caseIds(raw + " " + location.href);
    const masked = maskPII(raw);
    const displayCap = opts.displayCap || (kind === "content" ? 12000 : 800);
    const full = masked.text;
    const text = full.length > displayCap ? full.slice(0, displayCap) + " …" : full;

    const ev = {
      ts: Date.now(),
      kind,
      app: appInfo(host),
      domain: host,
      url: maskPII(location.href).text,
      text,
      fullLen: full.length,
      region: opts.region || null,
      frame: !IS_TOP,
      pii: masked.pii,
      caseIds: ids
    };
    try {
      chrome.runtime.sendMessage({ type: "tm_event", event: ev }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  // --- Content capture (debounced) ------------------------------------------
  let lastSnap = "";
  let lastSnapTs = 0;
  let snapTimer = null;

  function captureContent(force) {
    if (!recording) return;
    const now = Date.now();
    if (!force && now - lastSnapTs < 800) return;

    const snap = buildContentSnapshot();
    if (!snap || snap.length < MIN_IFRAME_CHARS) return;

    // Iframes: only emit if substantial (email HTML sandbox)
    if (!IS_TOP && snap.length < MIN_IFRAME_CHARS) return;

    // Dedupe: skip if unchanged (compare first 500 + length)
    if (!force && snap === lastSnap) return;
    if (!force && Math.abs(snap.length - lastSnap.length) < 8 &&
        snap.slice(0, 500) === lastSnap.slice(0, 500)) return;

    lastSnap = snap;
    lastSnapTs = now;
    emit("content", snap, { displayCap: 12000, region: snap.includes("[Email body]") ? "email" : "page" });
  }

  function scheduleCapture(delay, force) {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => captureContent(!!force), delay || 400);
  }

  // --- Top-frame interaction listeners --------------------------------------
  if (IS_TOP) {
    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.("a,button,input,select,textarea,[role],td,th,li,div,span") || e.target;
      emit("click", labelFor(el));
      scheduleCapture(500, true);
    }, true);

    document.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || isSensitiveInput(el)) return;
      const val = el.value ?? textFrom(el);
      emit("input", labelFor(el) + (val ? " = " + val : ""), { displayCap: 4000 });
      scheduleCapture(600);
    }, true);

    document.addEventListener("change", (e) => {
      const el = e.target;
      if (!el || isSensitiveInput(el)) return;
      const val = el.value ?? "";
      emit("input", labelFor(el) + (val ? " = " + val : ""), { displayCap: 4000 });
      scheduleCapture(400);
    }, true);

    document.addEventListener("focusin", (e) => {
      const el = e.target;
      if (!el) return;
      if (el.isContentEditable || el.tagName === "TEXTAREA") scheduleCapture(300, true);
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

  // --- All frames: watch DOM + periodic content scan ------------------------
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(() => scheduleCapture(900), 900);
    });
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    }
  } catch (e) {}

  // Periodic scan — catches lazy-loaded email bodies
  setInterval(() => { if (recording) scheduleCapture(0); }, IS_TOP ? 3000 : 2000);

  // Initial capture when recording starts on an already-open email
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tm_recording?.newValue === true) {
      lastSnap = "";
      setTimeout(() => captureContent(true), 500);
      setTimeout(() => captureContent(true), 2000);
    }
  });

  if (recording) setTimeout(() => captureContent(true), 600);
})();
