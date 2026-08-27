"use strict";

// Setup launches this exact bundled program without disabling Chromium's
// sandbox. Reaching a completed load proves the native libraries, sandbox,
// display connection, main process, and one sandboxed renderer all work for
// the current graphical login.
const { app, BrowserWindow } = require("electron");

// The production pill deliberately uses XWayland because it must move and
// resize itself. Probe that same display backend so setup cannot pass on native
// Wayland and then fail only when the real pill starts.
app.commandLine.appendSwitch("ozone-platform", "x11");

const deadline = setTimeout(() => {
  process.stderr.write("Relay Electron readiness probe timed out.\n");
  app.exit(2);
}, 20_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadURL("data:text/html,<meta charset=utf-8><title>Relay runtime probe</title>");
    clearTimeout(deadline);
    process.stdout.write("relay-electron-ready\n");
    app.exit(0);
  } catch (error) {
    clearTimeout(deadline);
    process.stderr.write(`${error?.message || error}\n`);
    app.exit(1);
  }
}).catch((error) => {
  clearTimeout(deadline);
  process.stderr.write(`${error?.message || error}\n`);
  app.exit(1);
});
