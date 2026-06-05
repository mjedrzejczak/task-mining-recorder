# Task Mining Recorder (demo extension)

A local Chrome/Edge extension (Manifest V3) that **records real browser activity**, **masks PII on-device**, **detects case IDs**, and **streams it live** into a Celonis-styled viewer. It's the working v0 behind the [onboarding prototype](https://mjedrzejczak.github.io/task-mining-onboarding/) — proving the "test capture → see data quality & privacy live" idea on real data.

> No backend, no network calls. Everything stays in `chrome.storage.local`.

## Install (Load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `task-mining-recorder/` folder.
4. Pin the extension and click its icon → **Start recording**.
5. Click **Open live view**, then browse normally in any tab — events stream in real time.

## What the live view shows (all computed from real capture)

The viewer has three tabs, every figure derived from your actual captured events — nothing mocked:

- **Live stream** — real-time events with their app, detected case IDs, and masked PII.
- **Privacy & GDPR scan** — a per-application verdict computed from the PII actually found and masked.
- **Case IDs & objects** — detected case IDs by app, mapped to the business objects they represent.

## What it captures

- **Clicks, form inputs, and navigations** across any website (UI metadata + element labels).
- **App detection** by domain (ServiceNow, Salesforce, Microsoft 365, SAP web, Jira, …).
- **PII masking on-device**: emails, IBANs, card-like numbers, phone numbers are masked *before* any event is stored or shown.
- **Case-ID detection**: labeled patterns — `INV…`, `ORD-…`, `PO-…`, `INC…`, `CASE-…`, SAP `45########`.

## What it intentionally does NOT do (v0 scope)

- **Native desktop apps** (SAP GUI, Excel desktop) — a browser extension cannot see these; that's what the client is for.
- **Robust PII detection** (names, free-text) — needs ML; v0 uses regex + masking rules and is honest about limits.
- **OCR from screenshots** and **real Process Mining / PiG join** — mocked in the storyboard prototype; not in this v0.
- **Persistence/backend** — events live only in local browser storage (capped to the most recent ~600).

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `content.js` | Captures events, masks PII, detects case IDs (runs on every page) |
| `background.js` | Service worker — recording state + serialized event store |
| `popup.html` / `popup.js` | Start/stop, open viewer, clear |
| `viewer.html` / `viewer.css` / `viewer.js` | Live dashboard (real-time stream + KPIs) |

## Privacy note

This is a self-recording demo tool for **your own** browsing. It is not a monitoring product. PII is masked at the source; raw values never leave the content script.
