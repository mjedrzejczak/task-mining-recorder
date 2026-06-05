// Shared scan logic — PII redaction + case-ID extraction (content script + viewer)
(function (global) {
  "use strict";

  const OBJECT_MAP = {
    "Incident (ServiceNow)": "Service Ticket",
    "Request (ServiceNow)": "Service Request",
    "Change (ServiceNow)": "Change Request",
    "Task (ServiceNow)": "Task",
    "Incident": "Service Ticket",
    "Case": "Service Ticket",
    "Ticket": "Service Ticket",
    "Ticket (Jira)": "Service Ticket",
    "Sales order": "Sales Order",
    "Purchase order": "Purchase Order",
    "Invoice": "Invoice",
    "Invoice (SAP)": "Invoice",
    "Document (SAP)": "Invoice",
    "Reference": "Reference",
    "Work order": "Work Order",
    "Service request": "Service Request",
    "Credit note": "Credit Note",
    "Delivery note": "Delivery Note",
    "Contract": "Contract",
    "Customer": "Customer",
    "Numeric ID": "Unclassified ID"
  };

  // --- Case-ID patterns (run on RAW text before masking) --------------------
  const CASE_RULES = [
    { re: /\bINC\d{7,10}\b/gi, type: "Incident (ServiceNow)" },
    { re: /\bRITM\d{7,10}\b/gi, type: "Request (ServiceNow)" },
    { re: /\bREQ\d{7,10}\b/gi, type: "Request (ServiceNow)" },
    { re: /\bCHG\d{7,10}\b/gi, type: "Change (ServiceNow)" },
    { re: /\bTASK\d{7,10}\b/gi, type: "Task (ServiceNow)" },
    { re: /\b[A-Z][A-Z0-9]{1,8}-\d{1,8}\b/g, type: "Ticket (Jira)" },
    { re: /\bORD[-\s#]?\d{3,}\b/gi, type: "Sales order" },
    { re: /\bSO[-\s#]?\d{3,}\b/gi, type: "Sales order" },
    { re: /\bPO[-\s#]?\d{3,}\b/gi, type: "Purchase order" },
    { re: /\bINV[-\s#]?\d{3,}\b/gi, type: "Invoice" },
    { re: /\bINVOICE[-\s#]?\d{3,}\b/gi, type: "Invoice" },
    { re: /\b45\d{8}\b/g, type: "Invoice (SAP)" },
    { re: /\b10\d{9}\b/g, type: "Document (SAP)" },
    { re: /\bCASE[-\s#]?\d{3,}\b/gi, type: "Case" },
    { re: /\bREF[-\s#]?\d{3,}\b/gi, type: "Reference" },
    { re: /\bTICKET[-\s#]?\d{3,}\b/gi, type: "Ticket" },
    { re: /\bSR[-\s#]?\d{3,}\b/gi, type: "Service request" },
    { re: /\bWO[-\s#]?\d{3,}\b/gi, type: "Work order" },
    { re: /\bCN[-\s#]?\d{3,}\b/gi, type: "Credit note" },
    { re: /\bDN[-\s#]?\d{3,}\b/gi, type: "Delivery note" },
    { re: /\bCON[-\s#]?\d{3,}\b/gi, type: "Contract" }
  ];

  const LABELED = [
    { re: /(?:invoice(?:\s+(?:no|number|#))?|inv)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Invoice" },
    { re: /(?:purchase\s+order|\bpo\b)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Purchase order" },
    { re: /(?:sales\s+order|\border\b)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Sales order" },
    { re: /(?:ticket|case|incident)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Ticket" },
    { re: /(?:customer(?:\s+id|\s+no)?|\bcust\b)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Customer" },
    { re: /(?:document|doc)[:\s#=-]+([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, type: "Document (SAP)" }
  ];

  function objectFor(type) {
    return OBJECT_MAP[type] || type;
  }

  function extractCaseIds(text) {
    const ids = [];
    const seen = new Set();
    if (!text) return ids;

    function add(type, value) {
      value = String(value).trim();
      if (!value || value.length < 3) return;
      if (/^[\w.+-]+@[\w-]+\./.test(value)) return;
      if (/^\d+$/.test(value) && value.length < 8) return; // skip bare short numbers
      const k = type + "|" + value.toUpperCase();
      if (seen.has(k)) return;
      seen.add(k);
      ids.push({ type, value, object: objectFor(type) });
    }

    for (const { re, type } of CASE_RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) add(type, m[0]);
    }
    for (const { re, type } of LABELED) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) add(type, m[1]);
    }
    return ids;
  }

  // --- PII redaction — never show raw values, only extraction tokens ----------
  const TOKEN = (label) => "▮▮▮ [" + label + " extracted]";

  function maskPII(text) {
    if (!text) return { text: "", pii: [], piiCounts: {} };
    let out = String(text);
    const piiCounts = {};

    function bump(label, n) {
      piiCounts[label] = (piiCounts[label] || 0) + (n || 1);
    }
    function rep(label) {
      return () => { bump(label); return TOKEN(label); };
    }

    // Header lines — always fully redact (From/To/Cc contain names + emails)
    out = out.replace(/^\[From\]\s*.+$/gim, () => { bump("Sender"); return "[From] " + TOKEN("Sender"); });
    out = out.replace(/^\[To\]\s*.+$/gim, () => { bump("Recipient"); return "[To] " + TOKEN("Recipient"); });
    out = out.replace(/^\[Cc\]\s*.+$/gim, () => { bump("Recipient"); return "[Cc] " + TOKEN("Recipient"); });

    // Name + angle-bracket email (Outlook/Gmail style)
    out = out.replace(/[\w\s.'",\-–—]+<\s*[\w.+-]+@[\w.-]+\s*>/g, rep("Sender"));
    out = out.replace(/<\s*[\w.+-]+@[\w.-]+\s*>/g, rep("Email"));

    // Standalone emails
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, rep("Email"));

    // IBAN
    out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{8,28}\b/g, rep("IBAN"));

    // Credit card-ish
    out = out.replace(/\b(?:\d[ \-]?){13,19}\b/g, rep("Card"));

    // Phone (international + local)
    out = out.replace(/(?:\+\d[\d().\s\-]{7,}\d)/g, rep("Phone"));
    out = out.replace(/\b(?:\+?\d{1,3}[\s.\-]?)?\(?\d{2,4}\)?[\s.\-]\d{3,}[\s.\-]\d{3,}\b/g, rep("Phone"));

    // SSN / national ID patterns
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, rep("SSN"));
    out = out.replace(/\b\d{11}\b/g, rep("National ID"));

    // IPv4
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, rep("IP address"));

    // URLs with tokens/session ids in query string — redact query values
    out = out.replace(/([?&](?:token|session|auth|key|password|email)=)[^&\s]+/gi, (_, p) => { bump("URL credential"); return p + TOKEN("Credential"); });

    // Street-ish (number + street name) — conservative
    out = out.replace(/\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr| Blvd)\b/g, rep("Address"));

    const pii = Object.entries(piiCounts).map(([label, count]) => ({ label, count }));
    return { text: out, pii, piiCounts };
  }

  /** Full pipeline: extract IDs from raw, then redact PII for display/storage */
  function scanText(raw) {
    const ids = extractCaseIds(raw);
    const masked = maskPII(raw);
    return { caseIds: ids, ...masked };
  }

  /** Build a flat pii label list (for backward compat with event.pii array) */
  function piiLabels(piiCounts) {
    const labels = [];
    for (const [label, count] of Object.entries(piiCounts || {})) {
      for (let i = 0; i < count; i++) labels.push(label);
    }
    return labels;
  }

  global.TMScan = { extractCaseIds, maskPII, scanText, piiLabels, objectFor, OBJECT_MAP };
})(typeof self !== "undefined" ? self : window);
