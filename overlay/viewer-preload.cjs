"use strict";

// The attachment viewer's whole world. It has no filesystem, no network and no
// Node: everything it can do is one of these calls, and every one of them is
// answered by main only for a live viewer window. The viewer receives local
// file: URLs under the attachments store (or nothing) — never a remote URL.

const { contextBridge, ipcRenderer } = require("electron");

const id = (value) => String(value == null ? "" : value);

contextBridge.exposeInMainWorld("relayViewer", {
  // main -> viewer
  onContent: (cb) => ipcRenderer.on("relay:viewer:content", (_e, payload) => cb(payload || {})),
  onTheme: (cb) => ipcRenderer.on("relay:viewer:theme", (_e, theme) => cb(String(theme || "light"))),
  onDownloadProgress: (cb) => ipcRenderer.on("relay:viewer:download", (_e, payload) => cb(payload || {})),

  // viewer -> main
  ready: () => ipcRenderer.send("relay:viewer:ready"),
  item: (relayId, attachmentId) => ipcRenderer.invoke("relay:viewer:item", id(relayId), id(attachmentId)),
  download: (items, options = {}) => ipcRenderer.invoke(
    "relay:viewer:download",
    Array.isArray(items) ? items.map((item) => ({ relayId: id(item?.relayId), attachmentId: id(item?.attachmentId) })) : [],
    { chatTitle: id(options?.chatTitle) },
  ),
  reveal: (relayId, attachmentId) => ipcRenderer.invoke("relay:viewer:reveal", id(relayId), id(attachmentId)),
  openDefault: (relayId, attachmentId) => ipcRenderer.invoke("relay:viewer:openDefault", id(relayId), id(attachmentId)),
  copyImage: (relayId, attachmentId) => ipcRenderer.invoke("relay:viewer:copyImage", id(relayId), id(attachmentId)),
  minimize: () => ipcRenderer.send("relay:viewer:window", "minimize"),
  close: () => ipcRenderer.send("relay:viewer:window", "close"),
});
