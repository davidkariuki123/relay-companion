const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("migration", {
  relocate: () => ipcRenderer.invoke("application:relocate"),
  inspect: () => ipcRenderer.invoke("migration:inspect"),
  tutorial: () => ipcRenderer.invoke("migration:tutorial"),
  install: () => ipcRenderer.invoke("application:install"),
  open: () => ipcRenderer.invoke("application:open"),
  handoff: () => ipcRenderer.invoke("application:handoff"),
  uninstall: () => ipcRenderer.invoke("application:uninstall"),
  reconcile: () => ipcRenderer.invoke("application:reconcile"),
  cancelDownload: () => ipcRenderer.invoke("application:cancel-download"),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("application:progress", listener);
    return () => ipcRenderer.removeListener("application:progress", listener);
  },
});
