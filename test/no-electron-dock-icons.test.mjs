// "got a bunch of the electron icons on my dash today" (ao1, 2026-10-08).
// Every way Relay could leave a generic Electron atom in the Dock is closed
// here; the runtime bundle's LSUIElement lives in mac-app-identity.test.mjs and
// the native app's own icon in tools/relay-application/test/migration.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { protocolNodePath, relayReferencePrompt } from "../src/session-delivery.js";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("the pill leaves the Dock before anything else can happen, not only once ready", () => {
  const early = main.indexOf('if (process.platform === "darwin" && app.dock) { try { app.dock.hide(); } catch {} }');
  assert.ok(early > 0);
  assert.ok(early < main.indexOf("app.requestSingleInstanceLock("), "hidden before the single-instance race");
  assert.ok(early < main.indexOf("app.whenReady("), "hidden before ready");
});

test("a second copy that loses the single-instance race exits at once", () => {
  assert.match(main, /if \(!gotSingleInstanceLock\) \{\n(?:\s*\/\/[^\n]*\n)*\s*app\.exit\(0\);/);
});

test("an agent is never handed the Electron binary to run the protocol helper", () => {
  assert.equal(protocolNodePath({ versions: { node: "22" }, execPath: "/usr/local/bin/node" }), "/usr/local/bin/node");
  assert.equal(protocolNodePath({ versions: { electron: "38" }, execPath: "/x/Electron.app/Contents/MacOS/Electron",
    canonicalCli: () => ({ node: "/h/.relay/recovery/node/node" }) }), "/h/.relay/recovery/node/node");
  assert.equal(protocolNodePath({ versions: { electron: "38" }, canonicalCli: () => null }), "node");
  assert.equal(protocolNodePath({ versions: { electron: "38" }, canonicalCli: () => { throw new Error("no runtime"); } }), "node");
  const prompt = relayReferencePrompt("relay_1", { agentProtocol: true, nodePath: "/managed/node" });
  assert.match(prompt, /\["\/managed\/node",/);
  assert.doesNotMatch(prompt, /Electron/);
});

// ---- Electron started with one of Relay's scripts (ao1, 2026-10-09) ----
// Measured on 0.1.617: `<runtime>/Electron <runtime>/…/relay-protocol.mjs --help`
// printed its help and then never quit. Before LSUIElement each one was an atom.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const asNode = require("../bootstrap/electron-as-node.cjs");
const stray = require("../src/stray-electron.cjs");
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("every runnable Relay script requires the Electron-as-Node guard first", () => {
  for (const relative of asNode.ENTRY_SCRIPTS) {
    const source = fs.readFileSync(path.join(packageRoot, relative), "utf8");
    const body = source.replace(/^#![^\n]*\n/, "").replace(/^\s*"use strict";\s*/, "").replace(/^(?:\s*\/\/[^\n]*\n)*/, "");
    assert.match(body, /^(?:import "\.\.\/bootstrap\/electron-as-node\.cjs";|require\("\.\/electron-as-node\.cjs"\);)/, `${relative} loads the guard before anything else`);
  }
  // Every script that can run on its own is in the list.
  const runnable = [];
  for (const dir of ["bin", "bootstrap", "src"]) {
    for (const name of fs.readdirSync(path.join(packageRoot, dir))) {
      if (!/\.(?:c|m)?js$/.test(name)) continue;
      const source = fs.readFileSync(path.join(packageRoot, dir, name), "utf8");
      if (/^#!\/usr\/bin\/env node|isMainModule\(import\.meta|require\.main === module/m.test(source)) runnable.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(runnable.filter((file) => !asNode.ENTRY_SCRIPTS.includes(file) && !asNode.STANDALONE_SCRIPTS.includes(file)), [],
    "a new runnable script must load the guard");
  for (const relative of asNode.STANDALONE_SCRIPTS) {
    assert.doesNotMatch(fs.readFileSync(path.join(packageRoot, relative), "utf8"), /electron-as-node/,
      `${relative} is copied alone into the protocol bundle and must not need a sibling`);
  }
});

test("an entry script started as an Electron app re-runs as Node and exits with its status", () => {
  const calls = [];
  const exits = [];
  const result = asNode.relaunchAsNodeIfElectronApp({
    versions: { electron: "43.4.1" }, type: "browser",
    argv: ["/r/Electron", path.join(packageRoot, "bin/relay.js"), "version"],
    env: { KEEP: "1" }, execPath: "/r/Electron", packageRoot,
    spawnSync: (file, args, options) => { calls.push({ file, args, options }); return { status: 7 }; },
    hideDock: () => calls.push("hide"), exit: (code) => exits.push(code),
  });
  assert.deepEqual(result, { relaunched: true, code: 7 });
  assert.equal(calls[0], "hide", "out of the Dock before anything else");
  assert.equal(calls[1].file, "/r/Electron");
  assert.deepEqual(calls[1].args, [path.join(packageRoot, "bin/relay.js"), "version"]);
  assert.equal(calls[1].options.stdio, "inherit");
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[1].options.env.KEEP, "1");
  assert.deepEqual(exits, [7]);
});

test("the guard never touches the pill, plain Node, Electron-as-Node, or a second relaunch", () => {
  const never = () => { throw new Error("must not relaunch"); };
  const base = { argv: ["/r/Electron", path.join(packageRoot, "bin/relay.js")], packageRoot, spawnSync: never, hideDock: () => {}, exit: never };
  assert.equal(asNode.relaunchAsNodeIfElectronApp({ ...base, versions: { node: "22" }, type: undefined }).reason, "not-electron-app");
  assert.equal(asNode.relaunchAsNodeIfElectronApp({ ...base, versions: { electron: "43" }, type: undefined }).reason, "not-electron-app");
  assert.equal(asNode.relaunchAsNodeIfElectronApp({ ...base, versions: { electron: "43" }, type: "browser",
    argv: ["/r/Electron", path.join(packageRoot, "overlay/main.cjs")] }).reason, "not-entry");
  const exits = [];
  assert.equal(asNode.relaunchAsNodeIfElectronApp({ ...base, versions: { electron: "43" }, type: "browser",
    env: { [asNode.RELAUNCHED]: "1" }, exit: (code) => exits.push(code) }).reason, "run-as-node-unavailable");
  assert.deepEqual(exits, [1], "no relaunch loop when RunAsNode is unavailable");
});

const LSAPPINFO = `
 12) "Relay" ASN:0x0-0x1:
    bundleID="work.relay.companion.pill"
    executable path="/h/.relay/runtime/Relay.app/Contents/MacOS/Relay"
    pid = 100 type="UIElement" flavor=3
 13) "Electron" ASN:0x0-0x2:
    executable path="/h/.relay/runtime/releases/0.1.580-x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    pid = 200 type="Foreground" flavor=3
 14) "Relay" ASN:0x0-0x3:
    executable path="/h/.relay/runtime/releases/0.1.617-y/node_modules/electron/dist/Electron.app/Contents/MacOS/Relay"
    pid = 300 type="UIElement" flavor=3
 15) "Electron" ASN:0x0-0x4:
    executable path="/Users/dev/src/relay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    pid = 400 type="Foreground" flavor=3
 16) "Claude" ASN:0x0-0x5:
    executable path="/Applications/Claude.app/Contents/MacOS/Claude"
    pid = 500 type="Foreground" flavor=3
`;

test("the sweep finds Relay-runtime Electron apps that are not a pill", () => {
  const commands = new Map([
    [100, "/h/.relay/runtime/Relay.app/Contents/MacOS/Relay /h/.relay/runtime/releases/0.1.617-y/node_modules/relay-companion/overlay/main.cjs"],
    [200, "/h/.relay/runtime/releases/0.1.580-x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /h/.relay/runtime/releases/0.1.580-x/node_modules/relay-companion/skill/relay/scripts/relay-protocol.mjs read relay_1"],
    [300, "/h/.relay/runtime/releases/0.1.617-y/node_modules/electron/dist/Electron.app/Contents/MacOS/Relay /h/.relay/runtime/releases/0.1.617-y/node_modules/relay-companion/overlay/main.cjs --relay-reopen n"],
    [400, "/Users/dev/src/relay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron script.js"],
    [500, "/Applications/Claude.app/Contents/MacOS/Claude"],
  ]);
  const found = stray.strayRelayElectronApps({ lsappinfo: LSAPPINFO, commands, selfPid: 100, homeDir: "/h" });
  assert.deepEqual(found.map((app) => app.pid), [200], "only the leaked protocol run: not this pill, another pill, a developer's Electron or another app");
});

test("the sweep quits strays and force-quits one that ignores SIGTERM", async () => {
  const signals = [];
  const execFileImpl = (file, args, _options, done) => {
    if (file === "/usr/bin/lsappinfo") return done(null, LSAPPINFO);
    if (file === "/bin/ps") return done(null, "  200 /h/.relay/runtime/releases/0.1.580-x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /x/relay-protocol.mjs --help\n  300 /h/.relay/runtime/releases/0.1.617-y/node_modules/electron/dist/Electron.app/Contents/MacOS/Relay /x/overlay/main.cjs\n");
    done(new Error("unexpected"));
  };
  const result = await stray.sweepStrayRelayElectronApps({ homeDir: "/h", selfPid: 100, execFileImpl,
    kill: (pid, signal) => signals.push([pid, signal]), sleep: async () => {} });
  assert.deepEqual(result.killed, [200]);
  assert.deepEqual(signals, [[200, "SIGTERM"], [200, 0], [200, "SIGKILL"]]);
});

test("the pill starts the sweep and the heal on macOS only, off the launch path", () => {
  const timers = [];
  const fake = (_fn, ms) => { const t = { ms, unref() {} }; timers.push(t); return t; };
  stray.startStrayElectronGuard({ platform: "linux", setTimeoutImpl: fake, setIntervalImpl: fake });
  assert.equal(timers.length, 0);
  stray.startStrayElectronGuard({ platform: "darwin", setTimeoutImpl: fake, setIntervalImpl: fake });
  assert.deepEqual(timers.map((t) => t.ms), [20_000, 90_000, 600_000]);
  assert.match(main, /strayElectron\.startStrayElectronGuard\(/);
});

test("the MCP broker descriptor never names Electron as the broker's Node", async () => {
  const { brokerNodeFor } = await import("../src/mcp-broker-state.js");
  const electron = "/h/.relay/runtime/releases/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  assert.equal(brokerNodeFor("/h/.relay/recovery/node/x/node"), "/h/.relay/recovery/node/x/node", "a real Node is kept");
  assert.equal(brokerNodeFor(electron, { managedNode: () => "/h/.relay/recovery/node/x/node" }), "/h/.relay/recovery/node/x/node");
  assert.equal(brokerNodeFor(electron, { managedNode: () => { throw new Error("none"); }, previous: "/opt/node" }), "/opt/node",
    "an earlier verified Node beats Electron");
  assert.equal(brokerNodeFor(electron, { managedNode: () => { throw new Error("none"); }, previous: electron }), electron,
    "with nothing better it stays runnable: the broker entry re-runs itself as Node");
});
