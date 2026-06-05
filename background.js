// Background service worker: single writer for the event store.
// State lives in chrome.storage.local so it survives SW restarts and the
// live viewer can subscribe via storage.onChanged.

const MAX_EVENTS = 600;

async function init() {
  const cur = await chrome.storage.local.get(["tm_recording", "tm_events"]);
  const patch = {};
  if (typeof cur.tm_recording === "undefined") patch.tm_recording = false;
  if (!Array.isArray(cur.tm_events)) patch.tm_events = [];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();

// Serialize read-modify-write so rapid events don't race.
let writeChain = Promise.resolve();
function appendEvent(ev) {
  writeChain = writeChain.then(async () => {
    const { tm_recording, tm_events = [] } = await chrome.storage.local.get(["tm_recording", "tm_events"]);
    if (!tm_recording) return;
    ev.id = (ev.ts || Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
    tm_events.push(ev);
    if (tm_events.length > MAX_EVENTS) tm_events.splice(0, tm_events.length - MAX_EVENTS);
    await chrome.storage.local.set({ tm_events });
  }).catch(() => {});
  return writeChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "tm_event" && msg.event) {
    appendEvent(msg.event);
    return; // no async response needed
  }
  if (msg.cmd === "start") {
    chrome.storage.local.set({ tm_recording: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.cmd === "stop") {
    chrome.storage.local.set({ tm_recording: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.cmd === "clear") {
    writeChain = writeChain.then(() => chrome.storage.local.set({ tm_events: [] }))
      .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.cmd === "openViewer") {
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
    return;
  }
});
