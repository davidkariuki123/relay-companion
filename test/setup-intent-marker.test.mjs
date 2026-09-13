import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

// The setup-intent marker (2026-09-13): the thin installer tells the signed-out
// pill it was opened for a person who will sign in there, so the pill can
// start that sign-in without a click. The writer lives in the stdlib-only
// bootstrap and the reader in the pill; this file pins both ends of the format.
const { writeSetupIntent } = createRequire(import.meta.url)("../bootstrap/relay-setup.cjs");
const bootstrap = fs.readFileSync(new URL("../bootstrap/relay-setup.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

// vm results come from another realm; compare their shape, not their prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const slice = (source, start, end) => {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `found: ${start}`);
  const j = source.indexOf(end, i);
  assert.ok(j > i, `found after: ${end}`);
  return source.slice(i, j);
};

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-intent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("plain setup writes a private marker that carries no credential", (t) => {
  const root = tempDir(t);
  const configDir = path.join(root, ".relay");
  const now = new Date("2026-09-13T10:00:00.000Z");
  assert.equal(writeSetupIntent(configDir, "0.1.291", [], { now }), true);
  const file = path.join(configDir, "setup-intent.json");
  const marker = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(marker, { agentInstalled: true, at: "2026-09-13T10:00:00.000Z", version: "0.1.291" });
  assert.deepEqual(Object.keys(marker).sort(), ["agentInstalled", "at", "version"], "nothing else rides along");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(configDir).some((name) => name.endsWith(".tmp")), false, "the atomic write left no temp file");
  // The website's endpoint overrides are still a plain sign-in setup.
  assert.equal(writeSetupIntent(configDir, "0.1.291", ["--api", "http://localhost:4000"], { now }), true);
});

test("paths that pair without a pill sign-in leave no marker", (t) => {
  const root = tempDir(t);
  const configDir = path.join(root, ".relay");
  assert.equal(writeSetupIntent(configDir, "0.1.291", ["--code", "PAIR123"]), false);
  assert.equal(writeSetupIntent(configDir, "0.1.291", ["--code", "PAIR123", "--api", "https://api.sendrelays.com"]), false);
  assert.equal(writeSetupIntent(configDir, "0.1.291", ["--agent-protocol"]), false);
  assert.equal(fs.existsSync(path.join(configDir, "setup-intent.json")), false);
  assert.equal(fs.existsSync(configDir), false, "not even the directory");
});

test("setup() writes the marker before activating the runtime and never lets it fail the install", () => {
  const setup = slice(bootstrap, "async function setup(argv = []) {", "async function stageVerifiedRuntime(");
  const marker = setup.indexOf("writeSetupIntent(");
  const activate = setup.indexOf("await activateRuntime(");
  assert.ok(marker >= 0 && activate > marker, "the pill activation opens reads the marker on its first paint");
  assert.match(setup, /try \{\s*writeSetupIntent\(process\.env\.RELAY_CONFIG_DIR \|\| path\.join\(os\.homedir\(\), "\.relay"\), version, setupCompatibilityArgs\);\s*\} catch \{\}/);
  assert.match(bootstrap, /^const SETUP_INTENT_FILE = "setup-intent\.json";$/m);
  assert.doesNotMatch(bootstrap, /require\("\.\.\/overlay/, "the thin installer ships without the pill");
});

function readerHarness() {
  const scope = vm.createContext({ fs, path, os, process: { env: {} }, Date });
  vm.runInContext(slice(main, "const SETUP_INTENT_FILE", "function pillVersion()"), scope);
  return {
    read: (dir, now) => vm.runInContext("readSetupIntent", scope)(dir, now),
    consume: (dir) => vm.runInContext("consumeSetupIntent", scope)(dir),
  };
}

test("the pill accepts a fresh marker and nothing else", (t) => {
  const root = tempDir(t);
  const { read } = readerHarness();
  const file = path.join(root, "setup-intent.json");
  const at = new Date("2026-09-13T10:00:00.000Z");
  const write = (value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(read(root, at.getTime()), null, "missing");
  writeSetupIntent(root, "0.1.291", [], { now: at });
  assert.deepEqual(plain(read(root, at.getTime())), { at: at.toISOString(), version: "0.1.291" });
  assert.ok(read(root, at.getTime() + 29 * 60 * 1000), "twenty-nine minutes later");
  assert.ok(read(root, at.getTime() + 30 * 60 * 1000), "thirty minutes is the edge of the window");
  assert.equal(read(root, at.getTime() + 30 * 60 * 1000 + 1), null, "expired");
  assert.equal(read(root, at.getTime() - 1), null, "a future timestamp is malformed, not fresh");
  write({ agentInstalled: false, at: at.toISOString(), version: "0.1.291" });
  assert.equal(read(root, at.getTime()), null, "agentInstalled must be exactly true");
  write({ agentInstalled: "true", at: at.toISOString() });
  assert.equal(read(root, at.getTime()), null);
  write({ agentInstalled: true, at: "yesterday" });
  assert.equal(read(root, at.getTime()), null, "unparseable time");
  write({ agentInstalled: true });
  assert.equal(read(root, at.getTime()), null, "no time");
  write("{not json");
  assert.equal(read(root, at.getTime()), null, "malformed file");
  write("null");
  assert.equal(read(root, at.getTime()), null);
});

test("consuming the marker removes it and tolerates its absence", (t) => {
  const root = tempDir(t);
  const { read, consume } = readerHarness();
  const at = new Date();
  writeSetupIntent(root, "0.1.291", [], { now: at });
  assert.ok(read(root, at.getTime()));
  consume(root);
  assert.equal(fs.existsSync(path.join(root, "setup-intent.json")), false);
  assert.equal(read(root, at.getTime()), null);
  assert.doesNotThrow(() => consume(root), "a second consume is a no-op");
  assert.doesNotThrow(() => consume(path.join(root, "never-created")));
});

test("the pill reads the marker only while signed out, consumes it on sign-in start, and pushes it to the renderer", () => {
  assert.match(main, /^function relayConfigDir\(\) \{\s*return process\.env\.RELAY_CONFIG_DIR \|\| path\.join\(os\.homedir\(\), "\.relay"\);\s*\}/m);
  const payload = slice(main, "function buildPayload() {", "// Pushes are serialized");
  assert.match(payload, /if \(currentAccount\.paired\) consumeSetupIntent\(\);/, "a paired account's marker is stale");
  assert.match(payload, /const setupIntent = currentAccount\.paired \? null : readSetupIntent\(relayConfigDir\(\)\);/);
  assert.match(payload, /agentInstalled: Boolean\(setupIntent\),/);
  const signIn = slice(main, 'ipcMain.handle("relay:installationAuthSignIn"', 'ipcMain.handle("relay:installationAuthGoogle"');
  assert.match(signIn, /consumeSetupIntent\(\);[\s\S]*\.signIn\(\{ forceAccountSelection: input\?\.forceAccountSelection === true \}\)/);
  // The renderer decides from the payload, so a change must reach it.
  assert.match(main, /onboarding: \[[^\]]*payload\.ui\.firstRelayKind, payload\.ui\.agentInstalled,/);
});

test("the first Relay is a hello to an inviter, else a share link", () => {
  const scope = vm.createContext({});
  vm.runInContext(slice(main, "function firstRelayKindFor(", "function firstLinkForOnboarding()"), scope);
  const kind = vm.runInContext("firstRelayKindFor", scope);
  assert.equal(kind({ inviter: { relayUserId: "usr_taylor", name: "Taylor" } }), "hello");
  assert.equal(kind({ inviter: { relayUserId: "  " } }), "link");
  assert.equal(kind({ inviter: null }), "link");
  assert.equal(kind(null), "link", "no agent-protocol.json at all");
  assert.match(main, /firstRelayKind: firstRelayKindFor\(protocolState\),/);
});

test("the protocol state carries the inviter for the current account only", () => {
  const protocol = { apiUrl: "https://api.sendrelays.com", account: { relayUserId: "usr_me" },
    inviter: { relayUserId: "usr_taylor", name: "Taylor" }, tutorial: { state: "pending" }, openingPreference: { surface: "terminal" } };
  const config = { userId: "usr_me" };
  const scope = vm.createContext({
    fs: { readFileSync: () => JSON.stringify(protocol) }, process: { env: {} },
    path: { join: (...parts) => parts.join("/") }, os: { homedir: () => "/home" },
    readConfigFile: () => ({}), account: () => config,
  });
  vm.runInContext(slice(main, "function onboardingProtocolState() {", "function firstRelayKindFor("), scope);
  const state = vm.runInContext("onboardingProtocolState", scope);
  assert.deepEqual(plain(state()), { tutorial: protocol.tutorial, openingPreference: protocol.openingPreference, inviter: protocol.inviter });
  delete protocol.inviter;
  assert.equal(state().inviter, null);
  config.userId = "usr_other";
  assert.equal(state(), null, "another account's protocol file says nothing about this one");
});
