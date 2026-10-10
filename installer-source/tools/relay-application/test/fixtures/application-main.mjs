// Execute the shipped main process with Darwin paths on any host. Only the OS
// and Electron boundary is simulated; handler registration and relocationPlan
// run from the real source. No app, service, or real /Applications is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";

export const candidate = {
  appId: "work.relay.application", distribution: "application", activationEnabled: true,
  desktopOnboarding: true, version: "0.1.568", applicationVersion: "0.1.568",
  runtimeSourceSha: "a".repeat(40),
};
const mainSource = fs.readFileSync(new URL("../../app/main.cjs", import.meta.url), "utf8");
const planSource = fs.readFileSync(new URL("../../app/relocation.cjs", import.meta.url), "utf8");
const volumeSource = fs.readFileSync(new URL("../../app/dmg-volume.cjs", import.meta.url), "utf8");

// `bundle` is where the running Relay.app sits: on the "Install Relay" disk
// image, or a translocated mirror of it. `mounts` are the attached disk images
// `hdiutil info` reports, each holding a Relay.app with the given receipt.
// `handoff` is an installation hand-off left by the copy that moved itself.
export async function applicationMain({ existing, platform = "darwin", installed = false,
  preview = false, ownsLock = true, trash = async () => {}, move,
  bundle = installed ? "/Applications/Relay.app" : "/Volumes/Install Relay/Relay.app",
  mounts = [{ mount: "/Volumes/Install Relay", receipt: candidate }], hdiutil = () => {}, handoff } = {}) {
  const destination = "/Applications/Relay.app";
  const execPath = `${bundle}/Contents/MacOS/relay`;
  const resources = `${bundle}/Contents/Resources`;
  const paths = { appData: "/Users/test/Library/Application Support" };
  const receiptPath = `${destination}/Contents/Resources/candidate.json`;
  const ours = preview ? { ...candidate, activationEnabled: false, distribution: "application-preview" } : candidate;
  const files = new Map([[`${resources}/candidate.json`, JSON.stringify(ours)]]);
  // The running bundle's own receipt wins where it sits on one of the images.
  for (const { mount, receipt } of mounts) {
    const file = `${mount}/Relay.app/Contents/Resources/candidate.json`;
    if (!files.has(file)) files.set(file, JSON.stringify(receipt));
  }
  const handoffPath = `${paths.appData}/Relay Application/installation-handoff.json`;
  if (handoff) files.set(handoffPath, JSON.stringify(handoff));
  // Processes the application starts through execFile (hdiutil and plutil),
  // kept apart from the filesystem calls the relocation tests sequence.
  const processes = [], timers = [];
  const execFile = (command, args, _options, callback) => {
    processes.push([command, ...args]);
    const child = { stdin: { end: input => finish(input) } };
    const finish = input => queueMicrotask(() => {
      try {
        const name = path.posix.basename(command);
        if (name === "plutil") {
          assert.equal(input, "<plist/>");
          return callback(null, JSON.stringify({ images: mounts.map(({ mount }) => ({ "system-entities": [{ "content-hint": "Apple_HFS", "mount-point": mount }] })) }));
        }
        assert.equal(name, "hdiutil");
        hdiutil(args);
        callback(null, args[0] === "info" ? "<plist/>" : "");
      } catch (error) { callback(error); }
    });
    if (path.posix.basename(command) !== "plutil") finish();
    return child;
  };
  const directories = new Set();
  if (existing !== undefined) {
    directories.add(destination);
    if (existing !== null) files.set(receiptPath, typeof existing === "string" ? existing : JSON.stringify(existing));
  }
  const calls = [], handlers = new Map();
  const filesystem = {
    existsSync: file => files.has(file) || directories.has(file),
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error(`Missing fixture file: ${file}`), { code: "ENOENT" });
      return files.get(file);
    },
    writeFileSync(file, bytes, options) { calls.push({ action: "write", file, options }); files.set(file, bytes); },
    rmSync(file) { calls.push({ action: "remove", file }); files.delete(file); },
  };
  let win, ready;
  const app = {
    setName() {}, setPath(name, value) { paths[name] = value; }, getPath: name => paths[name],
    requestSingleInstanceLock: () => ownsLock, quit() { calls.push({ action: "quit" }); }, on() {}, isInApplicationsFolder: () => installed,
    whenReady: () => ({ then(fn) { ready = Promise.resolve().then(fn); return ready; } }),
    moveToApplicationsFolder(options) {
      calls.push({ action: "move", handoff: files.get(`${paths.userData}/installation-handoff.json`) });
      // Model an actual destination conflict; a missing trash call must fail.
      if (directories.has(destination) && !options.conflictHandler("exists")) return false;
      const moved = move ? move(options) : true;
      if (moved) { directories.add(destination); files.set(receiptPath, JSON.stringify(candidate)); }
      return moved;
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); win = this;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler() {} });
    }
    loadURL() {}
  }
  const electron = {
    app, BrowserWindow, ipcMain: { handle(name, fn) { handlers.set(name, fn); } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} }, nativeTheme: { shouldUseDarkColors: false },
    shell: { async trashItem(file) {
      assert.equal(file, destination);
      calls.push({ action: "trash", file });
      await trash(file);
      directories.delete(file); files.delete(receiptPath);
    } },
  };
  const modules = {
    electron, "node:fs": filesystem, "node:path": path.posix, "node:os": { homedir: () => "/Users/test" },
    "node:url": { pathToFileURL: () => assert.fail("Unexpected URL conversion") },
    "node:child_process": { spawn: () => assert.fail("Unexpected process launch"), execFile },
    "./migration.cjs": { inspectInstallation: () => ({ pointer: "absent" }), planMigration: () => ({}) },
    "./deep-link.cjs": { parseRelayDeepLink: () => null },
    "./integration-status.cjs": { integrationStatus: () => ({}) },
    "./pill-status.cjs": { pillIsUp: () => false },
    "./open-relay.cjs": { createRelayOpener: () => () => assert.fail("Unexpected pill launch") },
  };
  const load = name => {
    if (!(name in modules)) throw Error(`Unexpected dependency: ${name}`);
    return modules[name];
  };
  const planModule = { exports: {} };
  vm.runInNewContext(planSource, { require: load, module: planModule }, { filename: "relocation.cjs" });
  modules["./relocation.cjs"] = planModule.exports;
  const volumeModule = { exports: {} };
  vm.runInNewContext(volumeSource, { require: load, module: volumeModule }, { filename: "dmg-volume.cjs" });
  modules["./dmg-volume.cjs"] = volumeModule.exports;
  vm.runInNewContext(mainSource, {
    require: load, console, __dirname: `${resources}/app.asar`,
    process: { platform, resourcesPath: resources, execPath, argv: [], env: {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {}, setInterval() { return 0; },
  }, { filename: "application/main.cjs" });
  await ready;
  // Runs what the application scheduled, then lets the processes it starts
  // (each answers on a microtask) finish.
  const runTimers = async () => {
    for (const timer of timers.splice(0)) timer.fn();
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  if (!ownsLock && !preview) return { calls, windowCreated: Boolean(win), handlers };
  assert.ok(handlers.has("application:relocate"), "the real application must register relocation");
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return {
    calls, files, processes, timers, runTimers, destination, event,
    handoff: `${paths.userData}/installation-handoff.json`,
    relocate: (sender = event) => handlers.get("application:relocate")(sender),
  };
}
