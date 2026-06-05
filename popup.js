const dot = document.getElementById("dot");
const stateLabel = document.getElementById("stateLabel");
const count = document.getElementById("count");
const toggle = document.getElementById("toggle");

function render(rec, n) {
  dot.classList.toggle("rec", !!rec);
  stateLabel.textContent = rec ? "Recording…" : "Not recording";
  toggle.textContent = rec ? "Stop recording" : "Start recording";
  toggle.className = rec ? "stop" : "primary";
  if (typeof n === "number") count.textContent = n.toLocaleString();
}

function refresh() {
  chrome.storage.local.get(["tm_recording", "tm_events"], (r) => {
    render(!!r.tm_recording, Array.isArray(r.tm_events) ? r.tm_events.length : 0);
  });
}

toggle.addEventListener("click", () => {
  chrome.storage.local.get("tm_recording", (r) => {
    chrome.runtime.sendMessage({ cmd: r.tm_recording ? "stop" : "start" }, () => {
      void chrome.runtime.lastError; refresh();
    });
  });
});

document.getElementById("viewer").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "openViewer" }, () => { void chrome.runtime.lastError; });
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "clear" }, () => { void chrome.runtime.lastError; refresh(); });
});

chrome.storage.onChanged.addListener((c, area) => { if (area === "local") refresh(); });
refresh();
