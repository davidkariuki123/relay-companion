import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  RELAY_TRAY_DEFAULT_POSITION,
  RELAY_TRAY_GUID,
  RELAY_TRAY_POSITION_KEY,
  destroyMacTrayPreservingPosition,
  prepareMacTrayPosition,
  readMacDefaultsNumber,
} = require("../overlay/tray-position.cjs");
const {
  RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER,
  RELAY_MAC_BUNDLE_IDENTIFIER,
} = require("../src/mac-app-identity.cjs");

test("the macOS tray position default is bound to Relay's shipped identity", () => {
  assert.equal(RELAY_TRAY_GUID, "2aa0aef7-8c43-4644-b96d-2c5ba95a0232");
  assert.equal(
    RELAY_TRAY_POSITION_KEY,
    `NSStatusItem Preferred Position ${RELAY_TRAY_GUID}`,
  );
  assert.equal(RELAY_TRAY_DEFAULT_POSITION, 0);
});

test("the signed runtime pins an Electron release with macOS Tray GUID support", () => {
  const dependencies = JSON.parse(
    fs.readFileSync(new URL("../runtime-dependencies.json", import.meta.url), "utf8"),
  );
  assert.equal(dependencies.electron, "43.4.1");
  const [major, minor] = dependencies.electron.split(".").map(Number);
  assert.ok(major > 36 || (major === 36 && minor >= 9));
});

test("darwin registers the exact fallback without persisting or reading preferences", () => {
  const calls = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults(defaults) { calls.push(defaults); },
      setUserDefault() { throw new Error("must not overwrite a persisted user choice"); },
    },
    readDomainValue: () => ({ status: "missing" }),
  });
  assert.deepEqual(calls, [{ [RELAY_TRAY_POSITION_KEY]: 0 }]);
  assert.deepEqual(result, {
    prepared: true,
    key: RELAY_TRAY_POSITION_KEY,
    value: 0,
    migrated: false,
  });
});

test("a legacy Relay GUID position migrates once into the branded suite", () => {
  const reads = [];
  const writes = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() {},
      setUserDefault(key, type, value) { writes.push({ key, type, value }); },
    },
    readDomainValue: (domain, key) => {
      reads.push({ domain, key });
      return domain === RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER
        ? { status: "found", value: 347 }
        : { status: "missing" };
    },
  });
  assert.deepEqual(reads, [
    { domain: RELAY_MAC_BUNDLE_IDENTIFIER, key: RELAY_TRAY_POSITION_KEY },
    { domain: RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER, key: RELAY_TRAY_POSITION_KEY },
  ]);
  assert.deepEqual(writes, [{ key: RELAY_TRAY_POSITION_KEY, type: "double", value: 347 }]);
  assert.equal(result.migrated, true);
});

test("an existing branded position wins and is never overwritten", () => {
  const writes = [];
  const reads = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() {},
      setUserDefault(...args) { writes.push(args); },
    },
    readDomainValue: (domain) => {
      reads.push(domain);
      return domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "found", value: 512 }
        : { status: "found", value: 347 };
    },
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER]);
  assert.deepEqual(writes, []);
  assert.equal(result.migrated, false);
});

test("non-macOS platforms do not touch system preferences", () => {
  const result = prepareMacTrayPosition({
    platform: "win32",
    systemPreferences: {
      registerDefaults() { throw new Error("must not register on Windows"); },
    },
  });
  assert.deepEqual(result, { prepared: false, reason: "not-darwin" });
});

test("preference registration failure cannot remove the tray recovery surface", () => {
  const logs = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() { throw new Error("defaults unavailable"); },
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(result, { prepared: false, reason: "preparation-failed" });
  assert.match(logs.join("\n"), /defaults unavailable/);
});

test("migration failure still registers the safe first-run fallback", () => {
  const calls = [];
  const logs = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults(defaults) { calls.push(defaults); },
      setUserDefault() { throw new Error("write unavailable"); },
    },
    readDomainValue: (domain) => domain === RELAY_MAC_BUNDLE_IDENTIFIER
      ? { status: "missing" }
      : { status: "found", value: 347 },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(calls, [{ [RELAY_TRAY_POSITION_KEY]: 0 }]);
  assert.equal(result.prepared, true);
  assert.equal(result.migrated, false);
  assert.match(logs.join("\n"), /write unavailable/);
});

test("an unreadable branded suite never authorizes a legacy overwrite", () => {
  const writes = [];
  const reads = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() {},
      setUserDefault(...args) { writes.push(args); },
    },
    readDomainValue: (domain) => {
      reads.push(domain);
      return domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "error" }
        : { status: "found", value: 347 };
    },
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER]);
  assert.deepEqual(writes, []);
  assert.equal(result.migrated, false);
});

test("tray destruction restores the exact preferred position after AppKit deletes it", () => {
  const calls = [];
  let persisted = 347;
  const result = destroyMacTrayPreservingPosition({
    platform: "darwin",
    tray: {
      isDestroyed: () => false,
      destroy() { calls.push("destroy"); persisted = undefined; },
    },
    systemPreferences: {
      getUserDefault(key, type) { calls.push(`get:${key}:${type}`); return persisted; },
      setUserDefault(key, type, value) { calls.push(`set:${key}:${type}:${value}`); persisted = value; },
    },
  });
  assert.deepEqual(result, { preserved: true, value: 347 });
  assert.equal(persisted, 347);
  assert.deepEqual(calls, [
    `get:${RELAY_TRAY_POSITION_KEY}:double`,
    "destroy",
    `set:${RELAY_TRAY_POSITION_KEY}:double:347`,
  ]);
});

test("an unreadable position leaves the Tray intact for process teardown", () => {
  let destroyed = false;
  const result = destroyMacTrayPreservingPosition({
    platform: "darwin",
    tray: { isDestroyed: () => false, destroy() { destroyed = true; } },
    systemPreferences: { getUserDefault() { throw new Error("read failed"); } },
    log: () => {},
  });
  assert.equal(destroyed, false);
  assert.deepEqual(result, { preserved: false, reason: "position-read-failed" });
});

test("the defaults adapter distinguishes found, missing, and unreadable values", () => {
  const calls = [];
  assert.deepEqual(readMacDefaultsNumber("work.relay.test", "position", {
    env: { SAFE: "1" },
    execFileSync(command, args, options) {
      calls.push({ command, args, options });
      return "347\n";
    },
  }), { status: "found", value: 347 });
  assert.equal(calls[0].options.stdio[2], "pipe");
  assert.equal(calls[0].options.env.LC_ALL, "C");

  assert.deepEqual(readMacDefaultsNumber("work.relay.test", "position", {
    execFileSync() { const error = new Error("missing"); error.stderr = "The domain/default pair does not exist"; throw error; },
  }), { status: "missing" });
  assert.deepEqual(readMacDefaultsNumber("work.relay.test", "position", {
    execFileSync() { throw new Error("permission denied"); },
  }), { status: "error" });
  assert.deepEqual(readMacDefaultsNumber("work.relay.test", "position", {
    execFileSync() { return "not-a-number\n"; },
  }), { status: "error" });
});

test("the real macOS defaults adapter confirms an unknown key is missing", {
  skip: process.platform !== "darwin",
}, () => {
  assert.deepEqual(
    readMacDefaultsNumber("work.relay.companion.nonexistent-probe", "Relay Missing Position Probe"),
    { status: "missing" },
  );
});
