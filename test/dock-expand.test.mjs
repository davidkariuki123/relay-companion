// RELAY IN THE DOCK (David, Shane and Sven, 2026-10-08): opening Relay from its
// Dock icon is Expand — the full app, in front. Dev-gated (features.fullAppExpand,
// defined with the full-app frame in src/product-features.cjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const main = read("../overlay/main.cjs");
const html = read("../overlay/inbox.html");
const preload = read("../overlay/preload.cjs");
const cli = read("../bin/relay.js");
const between = (source, start, end) => { const a = source.indexOf(start); assert.notEqual(a, -1, start); return source.slice(a, source.indexOf(end, a)); };

test("an open from Relay.app or `relay pill --expand` asks the pill for the full app", () => {
  const expandRequestedByArgs = new Function(`${between(main, "function expandRequestedByArgs(", "\nlet pendingAppExpand")}\nreturn expandRequestedByArgs;`)();
  assert.equal(expandRequestedByArgs(["main.cjs", "--relay-expand", "--relay-reopen", "n"]), true);
  assert.equal(expandRequestedByArgs(["main.cjs", "--relay-from-application", "--relay-reopen", "n"]), true);
  assert.equal(expandRequestedByArgs(["main.cjs", "--relay-reopen", "n"]), false);
  const second = between(main, 'app.on("second-instance"', "\n  });");
  // A Dock open is labelled "app" so the renderer never drops a full app to
  // the mini card on the way; anything else ("mini") opens the mini card.
  assert.match(second, /const expand = expandRequestedByArgs\(argv\) && currentProductFeatures\(\)\.fullAppExpand === true;\n\s+requestExternalReopen\(nonce, \{ mode: expand \? "app" : "mini" \}\);\n\s+if \(expand\) requestAppExpand\(\);/);
  // A click on the pill's own Dock icon is the same open, but never the
  // activate macOS sends as the app first launches.
  assert.match(main, /const dockClick = pillReady && currentProductFeatures\(\)\.fullAppExpand === true;/);
  assert.match(preload, /onOpenFull: \(cb\) => ipcRenderer\.on\("openFull", \(_event, nonce, mode\) => cb\(nonce, mode\)\)/);
  assert.match(main, /if \(pendingReopenNonce\) requestExternalReopen\(pendingReopenNonce\);\n\s+else writePillStatus\(\);\n\s+if \(pendingAppExpand\) requestAppExpand\(\);/);
  const request = between(main, "function requestAppExpand()", "\n}\n");
  assert.match(request, /currentProductFeatures\(\)\.fullAppExpand !== true/);
  assert.match(request, /win\.webContents\.send\("relay:expandApp"\)/);
  assert.match(preload, /onExpandApp: \(cb\) => ipcRenderer\.on\("relay:expandApp", \(\) => cb\(\)\)/);
  assert.match(between(html, "window.relay.onExpandApp(", "let lastExternalOpenAt"), /if \(!appExpanded\) \{ noteViewCause\("dock"\); setAppExpanded\(true\); \}/);
});

test("the CLI marks an open made by the native Relay.app, and only that", () => {
  const source = between(cli, "function launchedByRelayApplication(", "\nasync function cmdPill(");
  const launchedByRelayApplication = new Function(`${source}\nreturn launchedByRelayApplication;`)();
  const ps = (comm) => () => ({ stdout: `${comm}\n` });
  assert.equal(launchedByRelayApplication({ platform: "darwin", ppid: 7, run: ps("/Applications/Relay.app/Contents/MacOS/relay") }), true);
  assert.equal(launchedByRelayApplication({ platform: "darwin", ppid: 7, run: ps("/Applications/Relay 2.app/Contents/MacOS/relay") }), true);
  assert.equal(launchedByRelayApplication({ platform: "darwin", ppid: 7, run: ps("/bin/zsh") }), false);
  assert.equal(launchedByRelayApplication({ platform: "darwin", ppid: 7, run: ps("/Users/x/.relay/runtime/releases/a/node_modules/electron/dist/Electron.app/Contents/MacOS/Relay") }), false);
  assert.equal(launchedByRelayApplication({ platform: "win32", ppid: 7, run: ps("/Applications/Relay.app/Contents/MacOS/relay") }), false);
  assert.match(cli, /\.\.\.\(flags\.expand \? \["--relay-expand"\] : \[\]\)/);
  assert.match(cli, /\[overlayMain, \.\.\.deepLinks, \.\.\.expandArgs, "--relay-reopen", reopenNonce\]/);
});
