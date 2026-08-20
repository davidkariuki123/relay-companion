// Minimal Electron host for the real Relay AI preview. The parity probe uses
// the production preview HTML, preload, and renderer from RELAY_PARITY_PACKAGE_ROOT;
// this file supplies only deterministic IPC responses.
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const packageRoot = path.resolve(process.env.RELAY_PARITY_PACKAGE_ROOT || path.join(__dirname, "../../.."));
const overlayRoot = path.join(packageRoot, "overlay");
const userData = process.env.RELAY_PARITY_USER_DATA;
if (userData) app.setPath("userData", userData);

const feed = JSON.parse(process.env.RELAY_PARITY_PREVIEW_FEED || "{}");
const payload = {
  relayId: "preview-parity",
  title: "Verify native runner parity",
  forHuman: "Please verify the runner.",
  senderName: "Sven Wellmann",
  createdAt: "2026-08-14T08:00:00.000Z",
  openFace: "task",
  taskStartedAt: "2026-08-14T08:00:01.000Z",
  taskCompletedAt: feed.completedAt || "",
  runtimes: { claude: true, codex: true },
};

ipcMain.on("relay:preview:ready", (event) => {
  event.sender.send("relay:preview:content", payload);
});
ipcMain.on("relay:preview:rendered", () => {});
ipcMain.on("relay:preview:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on("relay:preview:close", () => app.quit());
ipcMain.on("relay:preview:openExternal", () => {});
ipcMain.handle("relay:preview:chat", async () => ({ ok: true, messages: [], participants: [] }));
ipcMain.handle("relay:preview:reply", async () => ({ ok: true }));
ipcMain.handle("relay:preview:startTask", async () => ({ ok: false, error: "Already started" }));
ipcMain.handle("relay:preview:session", async () => feed);
ipcMain.handle("relay:preview:steer", async () => ({ ok: true }));
ipcMain.handle("relay:runFeed:watch", async () => feed);
ipcMain.on("relay:runFeed:unwatch", () => {});
ipcMain.handle("relay:runFeed:attachment", async (_event, input) => {
  if (input?.relayId !== "preview-parity" || input?.sessionId !== "preview-fixture" || input?.turnId !== "turn-1" || input?.itemId !== "u1" || input?.attachmentId !== "img1") {
    return { ok:false, error:"Not authorized" };
  }
  return {
    ok:true, mimeType:"image/png", size:70, name:"pixel.png",
    dataBase64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLahAAAAABJRU5ErkJggg==",
  };
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 760,
    height: 760,
    show: process.env.RELAY_PARITY_SHOW === "1",
    webPreferences: {
      preload: path.join(overlayRoot, "preview-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(overlayRoot, "preview.html"));
});

app.on("window-all-closed", () => app.quit());
