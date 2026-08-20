import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  desktopMigrationMarkerIsCurrent,
  desktopMigrationMarkerPath,
  runDesktopStartupMigration,
  startDesktopStartupMigration,
} from "../src/desktop-migration.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-desktop-migration-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const packageRoot = path.join(homeDir, ".relay", "lib", "node_modules", "relay-companion");
  const bin = path.join(packageRoot, "bin", "relay.js");
  const node = "/usr/local/bin/node";
  const appPath = path.join(homeDir, "Applications", "Relay.app");
  const pillPlistPath = path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.pill.plist");
  const daemonPlistPath = path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.plist");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "relay-companion", version: "0.1.41" }));
  fs.writeFileSync(bin, "#!/usr/bin/env node\n");
  return { homeDir, packageRoot, bin, node, appPath, pillPlistPath, daemonPlistPath };
}

test("startup migration is inert outside darwin and for a development checkout", () => {
  let installs = 0;
  const effects = {
    installDaemonImpl: () => { installs += 1; },
    installPillImpl: () => { installs += 1; },
  };
  assert.equal(runDesktopStartupMigration({ platform: "linux", packageRoot: "/tmp/dev", ...effects }).reason, "not-darwin");
  assert.equal(
    runDesktopStartupMigration({ platform: "darwin", packageRoot: "/Users/x/src/relay/packages/companion", ...effects }).reason,
    "unmanaged-install",
  );
  assert.equal(installs, 0);
});

test("migration writes both surfaces once per version with no capability mode", (t) => {
  const f = fixture(t);
  const calls = [];
  const installDaemonImpl = (_bin, _node, options) => {
    calls.push({ kind: "daemon", options });
    fs.mkdirSync(path.dirname(f.daemonPlistPath), { recursive: true });
    fs.writeFileSync(f.daemonPlistPath, "daemon");
    return { ok: true, plistPath: f.daemonPlistPath };
  };
  const installPillImpl = (_bin, options) => {
    calls.push({ kind: "pill", options });
    fs.mkdirSync(path.dirname(f.pillPlistPath), { recursive: true });
    fs.mkdirSync(path.join(f.appPath, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(f.appPath, "Contents", "MacOS", "applet"), "native applet");
    fs.writeFileSync(f.pillPlistPath, "pill KeepAlive");
    return { ok: true, plistPath: f.pillPlistPath, appPath: f.appPath };
  };
  const options = {
    platform: "darwin",
    homeDir: f.homeDir,
    packageRoot: f.packageRoot,
    bin: f.bin,
    node: f.node,
    version: "0.1.41",
    installDaemonImpl,
    installPillImpl,
  };

  const first = runDesktopStartupMigration(options);
  assert.equal(first.ok, true);
  assert.deepEqual(calls.map((call) => call.kind), ["daemon", "pill"]);
  assert.equal(calls[0].options.reload, false, "the running daemon must never unload itself");
  assert.equal(calls[1].options.reload, true, "the pill reload makes KeepAlive effective immediately");
  assert.equal("mode" in calls[0].options, false);
  assert.equal("mode" in calls[1].options, false);
  assert.equal("mode" in first.marker, false);
  assert.equal(desktopMigrationMarkerIsCurrent(first.marker, options), true);
  assert.equal(first.markerPath, desktopMigrationMarkerPath({ homeDir: f.homeDir, version: "0.1.41" }));

  const second = runDesktopStartupMigration(options);
  assert.equal(second.reason, "already-current");
  assert.equal(second.attempted, false);
  assert.equal(calls.length, 2, "a valid per-version marker prevents a pill restart loop");

  const historicalMarker = { ...first.marker, mode: "full" };
  assert.equal(desktopMigrationMarkerIsCurrent(historicalMarker, options), true);
  assert.equal(calls.length, 2);
});

test("a marker is not trusted after any recorded desktop surface disappears", (t) => {
  const f = fixture(t);
  let installs = 0;
  const installDaemonImpl = () => {
    installs += 1;
    fs.mkdirSync(path.dirname(f.daemonPlistPath), { recursive: true });
    fs.writeFileSync(f.daemonPlistPath, "daemon");
    return { ok: true, plistPath: f.daemonPlistPath };
  };
  const installPillImpl = () => {
    installs += 1;
    fs.mkdirSync(path.dirname(f.pillPlistPath), { recursive: true });
    fs.mkdirSync(path.join(f.appPath, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(f.appPath, "Contents", "MacOS", "applet"), "native applet");
    fs.writeFileSync(f.pillPlistPath, "pill");
    return { ok: true, plistPath: f.pillPlistPath, appPath: f.appPath };
  };
  const options = {
    platform: "darwin",
    homeDir: f.homeDir,
    packageRoot: f.packageRoot,
    bin: f.bin,
    node: f.node,
    version: "0.1.41",
    installDaemonImpl,
    installPillImpl,
  };
  assert.equal(runDesktopStartupMigration(options).ok, true);
  fs.rmSync(f.appPath, { recursive: true, force: true });
  assert.equal(runDesktopStartupMigration(options).ok, true);
  assert.equal(installs, 4, "missing Relay.app invalidates the marker and repairs both surface definitions");
});

test("a marker is not trusted after the native Relay app executable disappears", (t) => {
  const f = fixture(t);
  let installs = 0;
  const installDaemonImpl = () => {
    installs += 1;
    fs.mkdirSync(path.dirname(f.daemonPlistPath), { recursive: true });
    fs.writeFileSync(f.daemonPlistPath, "daemon");
    return { ok: true, plistPath: f.daemonPlistPath };
  };
  const installPillImpl = () => {
    installs += 1;
    const appletPath = path.join(f.appPath, "Contents", "MacOS", "applet");
    fs.mkdirSync(path.dirname(appletPath), { recursive: true });
    fs.writeFileSync(appletPath, "native applet");
    fs.mkdirSync(path.dirname(f.pillPlistPath), { recursive: true });
    fs.writeFileSync(f.pillPlistPath, "pill");
    return { ok: true, plistPath: f.pillPlistPath, appPath: f.appPath };
  };
  const options = {
    platform: "darwin",
    homeDir: f.homeDir,
    packageRoot: f.packageRoot,
    bin: f.bin,
    node: f.node,
    version: "0.1.41",
    installDaemonImpl,
    installPillImpl,
  };

  assert.equal(runDesktopStartupMigration(options).ok, true);
  fs.rmSync(path.join(f.appPath, "Contents", "MacOS", "applet"), { force: true });
  assert.equal(runDesktopStartupMigration(options).ok, true);
  assert.equal(installs, 4, "a damaged Relay.app invalidates the marker and is rebuilt");
});

test("transient migration failures retry on bounded unref'd timers and stop after success", () => {
  const scheduled = [];
  let attempts = 0;
  const controller = startDesktopStartupMigration({
    runMigration: () => {
      attempts += 1;
      return attempts < 3
        ? { attempted: true, ok: false, retryable: true, reason: "launchctl-busy" }
        : { attempted: true, ok: true, retryable: false };
    },
    retryDelaysMs: [10, 20, 30],
    setTimeoutImpl: (fn, delay) => {
      const timer = { fn, delay, unrefed: false, unref() { this.unrefed = true; } };
      scheduled.push(timer);
      return timer;
    },
  });
  assert.equal(controller.firstResult.ok, false);
  assert.deepEqual(scheduled.map((timer) => timer.delay), [10]);
  assert.equal(scheduled[0].unrefed, true);
  scheduled[0].fn();
  assert.deepEqual(scheduled.map((timer) => timer.delay), [10, 20]);
  assert.equal(scheduled[1].unrefed, true);
  scheduled[1].fn();
  assert.equal(controller.lastResult.ok, true);
  assert.equal(controller.attempts, 3);
  assert.equal(scheduled.length, 2, "success schedules no further retries");
});

test("non-retryable migration outcomes never create a background timer", () => {
  let scheduled = 0;
  const controller = startDesktopStartupMigration({
    runMigration: () => ({ attempted: false, ok: true, retryable: false, reason: "unmanaged-install" }),
    setTimeoutImpl: () => { scheduled += 1; },
  });
  assert.equal(controller.firstResult.reason, "unmanaged-install");
  assert.equal(scheduled, 0);
});
