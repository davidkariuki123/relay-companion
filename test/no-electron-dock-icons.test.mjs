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
