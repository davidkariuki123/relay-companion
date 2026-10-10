"use strict";
const { app, BrowserWindow, ipcMain, clipboard, dialog, protocol, net, nativeTheme, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn, execFile } = require("node:child_process");
const { inspectInstallation, planMigration } = require("./migration.cjs");
const { parseRelayDeepLink } = require("./deep-link.cjs");
const { integrationStatus } = require("./integration-status.cjs");
const { pillIsUp, pillOffersFullApp } = require("./pill-status.cjs");
const { createRelayOpener } = require("./open-relay.cjs");
const { relocationPlan } = require("./relocation.cjs");
const { createVolumeTools } = require("./dmg-volume.cjs");
// Standard local origin lets sandboxed education frames load bundled assets
// without granting them same-origin access to the installer's privileged bridge.
protocol.registerSchemesAsPrivileged([{ scheme: "relay-setup", privileges: { standard: true, secure: true } }]);

// Read-only previews use a separate identity. Activating candidates explicitly
// opt into application identity and must be tested on disposable machines.
const candidate = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "candidate.json"), "utf8"));
const preview = candidate.activationEnabled === false && candidate.distribution === "application-preview";
const application = candidate.activationEnabled === true && candidate.distribution === "application"
  && candidate.appId === "work.relay.application";
if (!preview && !application) throw new Error("Invalid Relay application identity");
app.setName(preview ? "Relay Migration Preview" : "Relay");
app.setPath("userData", path.join(app.getPath("appData"), preview ? "Relay Migration Preview" : "Relay Application"));
let setupRunning = false;
let ownsApplication = true;
let mainWindow;
let setupChild;
// On a computer this application already set up, launching Relay means
// opening the Companion, never this window. The window appears only when
// that quiet launch could not be confirmed.
let quietLaunchFailed = false;
let setupProgress = { phase: "idle", canCancel: false };
function publishProgress(progress) {
  setupProgress = progress;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("application:progress", progress);
}
const pendingLinks = [];
function queueLink(value) {
  if (application && typeof value === "string" && value.length <= 2048 && parseRelayDeepLink(value)) pendingLinks.push(value);
}
// Relay opens in this window's place: the pill stands in the middle of the
// screen with Continue with Google (the installer's setup-intent marker), so
// this window leaves as soon as the pill reports itself up. If that cannot be
// confirmed the window stays and shows Open Relay instead.
//
// Setup activates the runtime part way through the install step, and that
// activation is what starts the pill (application-install.cjs). The step then
// goes on registering agents and services for a while, so a window that only
// left at the hand-off stood behind the pill until the step finished (Shane,
// 2026-09-20). This watch runs from the start of the install step and hides
// the window the moment a pill started by this setup is on screen. The
// process stays until the step ends, and a step that then fails shows the
// window again with its message.
let hiddenBehindPill = false;
function onboardingRunId() {
  if (!candidate.desktopOnboarding) return null;
  try { return JSON.parse(fs.readFileSync(path.join(process.env.RELAY_CONFIG_DIR || path.join(os.homedir(), ".relay"), "desktop-onboarding.json"), "utf8")).id || null; } catch { return null; }
}
function watchPillTakingOver({ pollMs = 250 } = {}) {
  const since = Date.now();
  const timer = setInterval(() => {
    if (!["installing", "ready"].includes(setupProgress.phase)) return;
    if (!pillIsUp({ since, visible: true, runId: onboardingRunId() })) return;
    clearInterval(timer);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) { mainWindow.hide(); hiddenBehindPill = true; }
  }, pollMs);
  return () => clearInterval(timer);
}
let pendingHandoff;
// RELAY'S ONE DOCK ICON (David, Shane and Sven, 2026-10-08). Where the pill
// offers the full app, this application stays running after the hand-off,
// windowless, as Relay's single place in the Dock and the app switcher: a
// click on it, or Cmd-Tab onto it, opens the full app (`relay pill --expand`).
// The pill itself never takes a Dock slot. Elsewhere it leaves, as before.
let dockResident = false;
function handoffToRelay() {
  if (pendingHandoff) return pendingHandoff;
  pendingHandoff = openRelay().then(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    if (process.platform === "darwin" && pillOffersFullApp()) dockResident = true;
    else setTimeout(() => app.quit(), 250);
    return { opened: true };
  }).finally(() => { pendingHandoff = null; });
  return pendingHandoff;
}
// Relay is already set up here when the runtime pointer is active and this
// application owns it. Nothing in the middle of a setup transaction counts.
// Files alone never settle it: a home folder restored onto a fresh OS carries
// every marker and not one logon task (Shane, 2026-09-19), so the quiet launch
// also asks whether the background service is actually alive.
function installationState() {
  if (!application) return { setUp: false, serviceAlive: false };
  try {
    const installation = inspectInstallation({ homeDir: os.homedir() });
    const setUp = installation.pointer === "active" && installation.applicationOwner !== "absent" && installation.transaction === "absent"
      && !installation.recoveryPending && installation.installedVersion.localeCompare(candidate.version, undefined, { numeric: true }) >= 0;
    return { setUp, serviceAlive: installation.serviceHeartbeat === "fresh" };
  } catch { return { setUp: false, serviceAlive: false }; }
}
function alreadySetUp() {
  return installationState().setUp;
}
let expandNextOpen = false;
const openPill = createRelayOpener({
  launch: () => {
    const bootstrap = require(path.join(process.resourcesPath, "installer", "bootstrap", "relay-setup.cjs"));
    const target = bootstrap.activeCanonicalCli();
    if (!target) throw new Error("Finish Relay setup first");
    const expand = expandNextOpen ? ["--expand"] : [];
    expandNextOpen = false;
    return spawn(target.node, [target.bin, "pill", ...pendingLinks.splice(0), ...expand], {
      windowsHide: true, detached: true, stdio: "ignore",
    });
  },
  isVisible: (since) => pillIsUp({ since, visible: true, runId: onboardingRunId() }),
});
function openRelay() {
  if (!application || setupRunning) return Promise.reject(new Error("Relay is not ready to open"));
  return openPill().then(result => pendingLinks.length ? openRelay() : result);
}
function openOrShowFailure() {
  openRelay().catch(() => { quietLaunchFailed = true; mainWindow?.show(); });
}
if (application) {
  for (const arg of process.argv) queueLink(arg);
  ownsApplication = app.requestSingleInstanceLock();
  if (!ownsApplication) app.quit();
  app.on("open-url", (event, url) => { event.preventDefault(); queueLink(url); if (app.isReady()) { openOrShowFailure(); } });
  app.on("second-instance", (_event, argv) => { for (const arg of argv) queueLink(arg); openOrShowFailure(); });
  // The Dock icon clicked, or Relay chosen in the app switcher, while this
  // application keeps Relay's place there: the full app, in front.
  app.on("activate", () => {
    if (!dockResident || setupRunning) return;
    expandNextOpen = true;
    openOrShowFailure();
  });
}
app.whenReady().then(() => {
  if (!ownsApplication) return;
  protocol.handle("relay-setup", request => {
    const url = new URL(request.url);
    let file;
    try { file = path.resolve(__dirname, `.${decodeURIComponent(url.pathname)}`); } catch { return new Response("Not found", { status: 404 }); }
    const relative = path.relative(__dirname, file);
    if (url.hostname !== "app" || !relative || relative.startsWith("..") || path.isAbsolute(relative)
      || !/\.(html|css|js|png|jpg|jpeg|svg|webp|woff2)$/.test(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href);
  });
  // Opened from the "Install Relay" disk image (anywhere outside Applications),
  // Relay installs itself: the window says "Installing Relay…" and calls
  // application:relocate on its own, with no drag and no button (founder,
  // 0.1.624, 2026-10-10). Sized and centred like the pill that takes its place
  // once Relay is ready.
  const animatedInstall = application && candidate.desktopOnboarding && process.platform === "darwin" && !app.isInApplicationsFolder();
  const win = new BrowserWindow({ width: 344, height: 524, minWidth: 344, minHeight: 524, ...(application && candidate.desktopOnboarding ? {frame:false,transparent:true,resizable:false} : {useContentSize:true}), autoHideMenuBar: true, title: "Relay", show: false,
    // The page follows the system appearance; match it before first paint.
    backgroundColor: application && candidate.desktopOnboarding ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#221E1B" : "#FFFFFF",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  mainWindow = win;
  win.on("close", event => {
    if (!setupRunning) return;
    event.preventDefault();
    if (setupProgress.canCancel && setupChild?.connected) setupChild.send({ action: "cancel-download" }, () => {});
  });
  const ownSender = (event) => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  const volumes = createVolumeTools({ execFile, readCandidate: file => JSON.parse(fs.readFileSync(file, "utf8")) });
  let relocating = null;
  ipcMain.handle("application:relocate", async (event) => {
    if (!ownSender(event) || !application || process.platform !== "darwin" || app.isInApplicationsFolder()) throw new Error("Installation is unavailable from this window");
    // One move at a time: the window starts it on its own, and Try again
    // must never overlap a move still under way.
    if (relocating) return relocating;
    relocating = (async () => {
      // An earlier Relay in Applications (often the copy whose first setup
      // failed) goes to the Trash, where it can still be recovered, so the move
      // below has no conflict to refuse (relocation.cjs).
      const bundle = path.resolve(path.dirname(process.execPath), "../..");
      const destination = path.join("/Applications", path.basename(bundle));
      const plan = relocationPlan(destination, candidate);
      if (plan.action === "refuse") throw new Error(plan.message);
      if (plan.action === "replace") {
        try { await shell.trashItem(destination); }
        catch { throw new Error("Relay could not replace the older Relay in Applications. Move it to the Trash, then try again."); }
      }
      // The disk image this copy runs from, for the copy in Applications to
      // eject once it is open (dmg-volume.cjs). Unknown is fine: nothing is ejected.
      const volume = await volumes.find({ bundlePath: bundle, candidate });
      const handoff = path.join(app.getPath("userData"), "installation-handoff.json");
      fs.writeFileSync(handoff, JSON.stringify({version:candidate.version, runtimeSourceSha:candidate.runtimeSourceSha, startedAt:new Date().toISOString(), volume, appName:path.basename(bundle)}), {mode:0o600});
      let moved = false;
      try { moved = app.moveToApplicationsFolder({ conflictHandler: () => false }); }
      finally { if (!moved) fs.rmSync(handoff, {force:true}); }
      if (!moved) throw new Error("Relay could not move to Applications. Move any Relay app in Applications to the Trash, then try again.");
      return { ok: true };
    })().finally(() => { relocating = null; });
    return relocating;
  });
  ipcMain.handle("migration:inspect", (event) => {
    if (!ownSender(event)) throw new Error("Invalid caller");
    const installation = inspectInstallation({ homeDir: os.homedir() });
    return { candidate, installation, progress: setupProgress, launch: { quietLaunchFailed },
      plan: planMigration({ installation, platform: candidate.platform, targetVersion: candidate.version }) };
  });
  ipcMain.handle("migration:tutorial", (event) => {
    if (!ownSender(event)) throw new Error("Invalid caller");
    clipboard.writeText("Give me the Relay tutorial.");
  });
  const lifecycle = (event, action) => {
    if (!ownSender(event) || !application || setupRunning) throw new Error("Application setup is unavailable");
    return runLifecycle(action);
  };
  const runLifecycle = async (action, { allowRecovery = true } = {}) => {
    if (!application || setupRunning) throw new Error("Application setup is unavailable");
    if (action === "uninstall") {
      const answer = await dialog.showMessageBox(win, { type: "question", title: "Remove Relay integrations?",
        message: "Remove Relay’s agent connections, unmodified managed skills and background services?",
        detail: "Your account data, messages, encryption keys and protocol authorization will be kept. Then remove the application using your operating system.",
        buttons: ["Cancel", "Remove integrations"], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return { cancelled: true };
    }
    setupRunning = true;
    publishProgress({ phase: action === "install" ? "verifying" : "installing", canCancel: false });
    const stopWatchingPill = action === "install" ? watchPillTakingOver() : () => {};
    try {
      const logRoot = app.getPath("logs");
      fs.mkdirSync(logRoot, { recursive: true });
      const logPath = path.join(logRoot, "application-setup.log");
      const fd = fs.openSync(logPath, "a", 0o600);
      const applicationRoot = process.platform === "darwin" ? path.resolve(path.dirname(process.execPath), "../..") : path.dirname(process.execPath);
      const env = { ...process.env };
      for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete env[key];
      for (const key of Object.keys(env)) if (/^RELAY_(CONFIG|HOME|COMPANION_HOME|NATIVE_CREDENTIALS)/.test(key)) delete env[key];
      // An old Relay may be updating itself at the moment setup starts. Setup
      // then exits 75; wait for that update and run setup again rather than
      // stopping with "needs attention" (seen in CI, 2026-10-01).
      const waitForOtherUpdateUntil = Date.now() + 10 * 60_000;
      try {
        for (;;) {
          const code = await new Promise((resolve, reject) => {
          const child = spawn(path.join(process.resourcesPath, process.platform === "win32" ? "node.exe" : "node"),
            [path.join(process.resourcesPath, "activate.cjs"), action, applicationRoot, process.execPath, ...(!allowRecovery ? ["--preserve-state"] : [])],
            { windowsHide: true, stdio: ["ignore", fd, fd, "ipc"], env });
          setupChild = child;
          child.on("message", message => {
            if (message?.type === "setup-progress") publishProgress(message);
          });
          child.once("error", reject);
          child.once("exit", resolve);
          });
          if (code === 0) break;
          if (code === 75 && Date.now() < waitForOtherUpdateUntil) {
            publishProgress({ phase: "waiting", canCancel: false });
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          throw new Error(code === 2 ? "Download cancelled. You can retry setup when you are ready." : `Relay setup needs attention. Details: ${logPath}`);
        }
      } finally { fs.closeSync(fd); }
      publishProgress({ phase: action === "install" ? "ready" : "idle", canCancel: false });
      return { ok: true, integrations: action === "install" ? integrationStatus() : undefined };
    } catch (error) {
      publishProgress({ phase: "stopped", canCancel: false });
      // The pill took this window's place before the step failed: the message
      // belongs on screen, not behind it.
      if (hiddenBehindPill && mainWindow && !mainWindow.isDestroyed()) { hiddenBehindPill = false; mainWindow.show(); }
      throw error;
    } finally { stopWatchingPill(); setupRunning = false; setupChild = null; }
  };
  ipcMain.handle("application:install", (event) => lifecycle(event, "install"));
  ipcMain.handle("application:uninstall", (event) => lifecycle(event, "uninstall"));
  ipcMain.handle("application:reconcile", (event) => lifecycle(event, "reconcile"));
  ipcMain.handle("application:cancel-download", event => {
    if (!ownSender(event)) throw new Error("Invalid caller");
    if (setupProgress.canCancel && setupChild?.connected) setupChild.send({ action: "cancel-download" }, () => {});
  });
  ipcMain.handle("application:open", (event) => {
    if (!ownSender(event) || !application || setupRunning) throw new Error("Relay is not ready to open");
    return openRelay();
  });
  ipcMain.handle("application:handoff", (event) => {
    if (!ownSender(event) || !application || setupRunning) throw new Error("Relay is not ready to open");
    return handoffToRelay();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadURL(animatedInstall ? "relay-setup://app/native-install.html" : application && candidate.desktopOnboarding ? "relay-setup://app/native-bootstrap.html" : "relay-setup://app/index.html");
  const state = installationState();
  // Relocation restarts Electron. The installed copy resumes the existing
  // bootstrap, whose verification and progress renderer remain authoritative.
  // isInApplicationsFolder exists only on macOS: calling it elsewhere threw
  // here and left the Windows and Linux setup window hidden for good.
  if (application && process.platform === "darwin" && app.isInApplicationsFolder()) {
    const handoff = path.join(app.getPath("userData"), "installation-handoff.json");
    try {
      const pending = JSON.parse(fs.readFileSync(handoff, "utf8"));
      if (pending.version === candidate.version && pending.runtimeSourceSha === candidate.runtimeSourceSha) {
        fs.rmSync(handoff);
        // The "Install Relay" disk image has done its job. Electron's mover
        // ejects it about five seconds after the move; this is the second
        // attempt, for a translocated app or a busy first try. Setup carries
        // on regardless of the outcome.
        if (pending.volume) setTimeout(() => { volumes.eject({ mount: pending.volume, appName: pending.appName, candidate }); }, 8000);
      }
    } catch (error) { if (error.code !== "ENOENT") console.error("Installation handoff could not be read:", error.message); }
  }
  if (state.setUp && !animatedInstall) {
    // Launching Relay on a computer it is set up on opens the Companion, with
    // any relay:// link, and this process leaves. The window is shown only
    // when the Companion cannot be seen coming up.
    // An ordinary app open must never clear local data because startup was
    // slow. Show the disclosed setup/retry action when recovery is needed.
    const ready = state.serviceAlive ? Promise.resolve() : runLifecycle("install", { allowRecovery: false });
    ready.then(() => handoffToRelay()).then(({ opened }) => {
      if (opened) return;
      quietLaunchFailed = true;
      win.show();
    }).catch(() => { quietLaunchFailed = true; win.show(); });
    return;
  }
  win.once("ready-to-show", () => win.show());
  if (pendingLinks.length) openOrShowFailure();
}).catch(error => {
  // A startup error must never leave a running Relay with no window. The
  // install harnesses fail on this message (native-install-proof.mjs).
  console.error("Relay startup failed:", error);
  quietLaunchFailed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
app.on("window-all-closed", () => app.quit());
