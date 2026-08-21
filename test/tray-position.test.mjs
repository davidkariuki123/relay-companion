import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  RELAY_TRAY_DEFAULT_POSITION,
  RELAY_TRAY_GUID,
  RELAY_TRAY_POSITION_CACHE_SCHEMA,
  RELAY_TRAY_POSITION_KEY,
  destroyMacTrayPreservingPosition,
  installMacTrayPositionSignalHandlers,
  prepareMacTrayPosition,
  readMacTrayPositionCache,
  readMacDefaultsNumber,
  resolveMacTrayPositionCachePath,
  snapshotMacTrayPosition,
  writeMacTrayPositionCache,
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
    restoredFrom: null,
  });
});

test("the durable cache round-trips finite positions with Relay identity and private permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tray-cache-"));
  const cachePath = resolveMacTrayPositionCachePath({ relayHome: root });
  try {
    for (const value of [0, -17.5, 347]) {
      const written = writeMacTrayPositionCache(cachePath, value, {
        now: () => new Date("2026-08-21T12:00:00.000Z"),
      });
      assert.equal(written.cached, true);
      assert.deepEqual(readMacTrayPositionCache(cachePath), { status: "found", value });
      const document = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert.equal(document.schema, RELAY_TRAY_POSITION_CACHE_SCHEMA);
      assert.equal(document.guid, RELAY_TRAY_GUID);
      assert.equal(document.sourceDomain, RELAY_MAC_BUNDLE_IDENTIFIER);
      assert.equal(document.capturedAt, "2026-08-21T12:00:00.000Z");
      assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing and malformed caches are distinguished without deleting either", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tray-cache-invalid-"));
  const cachePath = path.join(root, "tray-position.json");
  try {
    assert.deepEqual(readMacTrayPositionCache(cachePath), { status: "missing" });
    fs.writeFileSync(cachePath, JSON.stringify({ schema: 1, guid: "wrong", position: 99 }));
    assert.deepEqual(readMacTrayPositionCache(cachePath), { status: "error" });
    assert.equal(fs.existsSync(cachePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a durable cache restores before legacy state and before Tray construction", () => {
  const reads = [];
  const writes = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() {},
      setUserDefault(key, type, value) { writes.push({ key, type, value }); },
    },
    readDomainValue: (domain) => {
      reads.push(domain);
      return domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "missing" }
        : { status: "found", value: 999 };
    },
    readCachedValue: () => ({ status: "found", value: 347 }),
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER]);
  assert.deepEqual(writes, [{ key: RELAY_TRAY_POSITION_KEY, type: "double", value: 347 }]);
  assert.equal(result.restoredFrom, "cache");
  assert.equal(result.migrated, false);
});

test("an unreadable cache fails closed and cannot resurrect stale legacy state", () => {
  const reads = [];
  const writes = [];
  const result = prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences: {
      registerDefaults() {},
      setUserDefault(...args) { writes.push(args); },
    },
    readDomainValue: (domain) => {
      reads.push(domain);
      return domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "missing" }
        : { status: "found", value: 999 };
    },
    readCachedValue: () => ({ status: "error" }),
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER]);
  assert.deepEqual(writes, []);
  assert.equal(result.restoredFrom, null);
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
  assert.equal(result.restoredFrom, "legacy");
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
  assert.equal(result.restoredFrom, null);
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

test("exit preservation refreshes durable cache before AppKit destroys the item", () => {
  const calls = [];
  const result = destroyMacTrayPreservingPosition({
    platform: "darwin",
    tray: {
      isDestroyed: () => false,
      destroy() { calls.push("destroy"); },
    },
    systemPreferences: {
      getUserDefault() { calls.push("read"); return 347; },
      setUserDefault() { calls.push("restore"); },
    },
    writeCachedValue(value) { calls.push(`cache:${value}`); return { cached: true }; },
  });
  assert.deepEqual(result, { preserved: true, value: 347 });
  assert.deepEqual(calls, ["read", "cache:347", "destroy", "restore"]);
});

test("candidate repair snapshots a finite branded value and fails closed on cache errors", () => {
  const writes = [];
  const success = snapshotMacTrayPosition({
    platform: "darwin",
    cachePath: "/relay/tray-position.json",
    readDomainValue: () => ({ status: "found", value: 347 }),
    writeCachedValue(value) { writes.push(value); return { cached: true }; },
  });
  assert.deepEqual(success, {
    ok: true,
    snapshotted: true,
    value: 347,
    sourceDomain: RELAY_MAC_BUNDLE_IDENTIFIER,
    cachePath: "/relay/tray-position.json",
  });
  assert.deepEqual(writes, [347]);
  assert.deepEqual(snapshotMacTrayPosition({
    platform: "darwin",
    readDomainValue: () => ({ status: "found", value: 347 }),
    writeCachedValue: () => ({ cached: false, reason: "cache-write-failed", detail: "disk full" }),
  }), {
    ok: false,
    snapshotted: false,
    reason: "cache-write-failed",
    detail: "disk full",
  });
});

test("direct upgrade from a generic-Electron release snapshots its legacy GUID before bootout", () => {
  const reads = [];
  const writes = [];
  const result = snapshotMacTrayPosition({
    platform: "darwin",
    cachePath: "/relay/tray-position.json",
    readDomainValue(domain) {
      reads.push(domain);
      return domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "missing" }
        : { status: "found", value: 281 };
    },
    readCachedValue: () => ({ status: "missing" }),
    writeCachedValue(value, sourceDomain) {
      writes.push({ value, sourceDomain });
      return { cached: true };
    },
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER, RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER]);
  assert.deepEqual(writes, [{ value: 281, sourceDomain: RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER }]);
  assert.deepEqual(result, {
    ok: true,
    snapshotted: true,
    value: 281,
    sourceDomain: RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER,
    cachePath: "/relay/tray-position.json",
  });
});

test("a valid existing cache outranks legacy live state during direct-skip ingress", () => {
  const reads = [];
  let writes = 0;
  const result = snapshotMacTrayPosition({
    platform: "darwin",
    cachePath: "/relay/tray-position.json",
    readDomainValue(domain) { reads.push(domain); return { status: "missing" }; },
    readCachedValue: () => ({ status: "found", value: 347 }),
    writeCachedValue() { writes += 1; return { cached: true }; },
  });
  assert.deepEqual(reads, [RELAY_MAC_BUNDLE_IDENTIFIER]);
  assert.equal(writes, 0);
  assert.deepEqual(result, {
    ok: true,
    snapshotted: false,
    reason: "cache-current",
    value: 347,
    cachePath: "/relay/tray-position.json",
  });
});

test("old updater to new candidate bridge restores the snapshot after AppKit deletes the live key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tray-ingress-"));
  const cachePath = resolveMacTrayPositionCachePath({ relayHome: root });
  try {
    const snapshot = snapshotMacTrayPosition({
      platform: "darwin",
      cachePath,
      readDomainValue: () => ({ status: "found", value: 347 }),
    });
    assert.equal(snapshot.ok, true);

    // This missing result models Electron/AppKit teardown after the old updater's
    // launchctl bootout. The new pill must restore from the candidate's cache,
    // never from a stale generic-Electron value.
    const writes = [];
    const prepared = prepareMacTrayPosition({
      platform: "darwin",
      systemPreferences: {
        registerDefaults() {},
        setUserDefault(key, type, value) { writes.push({ key, type, value }); },
      },
      readDomainValue: (domain) => domain === RELAY_MAC_BUNDLE_IDENTIFIER
        ? { status: "missing" }
        : { status: "found", value: 999 },
      readCachedValue: () => readMacTrayPositionCache(cachePath),
    });
    assert.deepEqual(writes, [{ key: RELAY_TRAY_POSITION_KEY, type: "double", value: 347 }]);
    assert.equal(prepared.restoredFrom, "cache");
    assert.deepEqual(readMacTrayPositionCache(cachePath), { status: "found", value: 347 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or unreadable live state never erases an existing durable cache", () => {
  let writes = 0;
  for (const status of ["missing", "error"]) {
    const result = snapshotMacTrayPosition({
      platform: "darwin",
      readDomainValue: () => ({ status }),
      writeCachedValue() { writes += 1; return { cached: true }; },
    });
    assert.equal(result.ok, status === "missing");
    assert.equal(result.snapshotted, false);
  }
  assert.equal(writes, 0);
});

test("SIGTERM and SIGINT share one guarded preserve-and-exit path", () => {
  const processLike = new EventEmitter();
  const calls = [];
  const installed = installMacTrayPositionSignalHandlers({
    platform: "darwin",
    processLike,
    app: { exit(code) { calls.push(`exit:${code}`); } },
    preserve() { calls.push("preserve"); },
  });
  assert.equal(installed.installed, true);
  processLike.emit("SIGTERM");
  processLike.emit("SIGINT");
  assert.deepEqual(calls, ["preserve", "exit:0"]);
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
