// The preview bridge, stubbed for test/preview-face-probe.mjs: same surface as
// overlay/preview-preload-source.cjs, canned answers, so the REAL preview
// renderer runs untouched against known content. Nothing privileged is exposed
// and no API is reachable — this preload only ever serves the probe's window.
const { ipcRenderer } = require("electron");

window.relayPreview = {
  onContent: (cb) => ipcRenderer.on("probe:content", (_event, payload) => cb(payload)),
  onTheme: () => {},
  ready: () => ipcRenderer.send("probe:ready"),
  rendered: () => {},
  minimize: () => {},
  // Reported rather than performed: closing the probe's own window would end
  // the run, and what the checks want to know is that close was ASKED for.
  close: () => ipcRenderer.send("probe:close"),
  openExternal: () => {},
  // Enough Markdown to lay a bubble out; the real sanitiser is covered by the
  // security tests in preview-ui.test.mjs, which is where it belongs.
  renderMarkdown: (markdown) => `<p>${String(markdown).replace(/[<>&]/g, "")}</p>`,
  loadChat: (threadId) => ipcRenderer.invoke("probe:chat", threadId),
  sendReply: () => ({ ok: false, error: "the probe does not send" }),
};
