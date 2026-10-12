import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import health from "../bootstrap/installation-health.cjs";

// A Mac whose daemon is healthy and whose pill is simply gone, with the launch
// file in place: the shape of Sven's two-day outage on 2026-10-10.
function macHome(t, { version = "1.0.0", linkInPlist = true } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-liveness-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const root = path.join(homeDir, ".relay");
  const packageRoot = path.join(root, "runtime", "releases", `${version}-test`, "node_modules", "relay-companion");
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
  write(path.join(root, "runtime", "current.json"), { active: true, version, packageRoot, bin: path.join(packageRoot, "bin", "relay.js") });
  write(path.join(root, "recovery", "daemon.json"), { version, pid: 12, at: 1000 });
  write(path.join(packageRoot, "package.json"), { name: "relay-companion", version });
  write(path.join(packageRoot, "overlay", "main.cjs"), "");
  const bundleExecutable = path.join(packageRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Relay");
  write(bundleExecutable, "");
  const link = path.join(root, "runtime", "Relay.app");
  const program = linkInPlist ? path.join(link, "Contents", "MacOS", "Relay") : bundleExecutable;
  const plist = { Label: "work.relay.companion.pill", ProgramArguments: [program, path.join(packageRoot, "overlay", "main.cjs")] };
  write(path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.pill.plist"), "<plist/>");
  const statusPath = path.join(homeDir, ".relay-companion", "pill-status.json");
  // Each call records the launchd exit it was told to report.
  const run = (command, args) => {
    if (command === "/usr/bin/plutil") return { status: 0, stdout: JSON.stringify(plist) };
    if (command === "/bin/launchctl") return { status: 0, stdout: `work.relay.companion.pill = {\n\tpid = 0\n\tlast exit code = 78\n}` };
    return { status: 1, stdout: "" };
  };
  const daemon = `node ${packageRoot}/bin/relay.js daemon`;
  const pill = `${program} ${packageRoot}/overlay/main.cjs`;
  return { homeDir, packageRoot, bundleExecutable, link, statusPath, run, daemon, pill, write };
}

// Creating symlinks needs a privilege this host may lack (Windows without
// Developer Mode); the link cases then skip here and run on the Linux runner.
function linkOrSkip(t, target, link) {
  try { fs.symlinkSync(target, link, "dir"); return true; }
  catch (error) { if (error.code !== "EPERM") throw error; t.skip("symlinks need privileges on this host"); return false; }
}

const collect = (home, commands, extra = {}) => health.collectInstallationHealth({
  homeDir: home.homeDir, platform: "darwin", commands, now: 1001, run: home.run, env: {}, ...extra,
});

test("a pill that is gone, with nobody having quit it, is a failure of its own with the OS facts attached", (t) => {
  const home = macHome(t);
  if (!linkOrSkip(t, home.bundleExecutable.replace(/[\\/]Contents[\\/]MacOS[\\/]Relay$/, ""), home.link)) return;
  home.write(home.statusPath, { pid: 99, ready: true });
  const seen = new Date(900).toISOString();
  fs.utimesSync(home.statusPath, new Date(900), new Date(900));
  const report = collect(home, [home.daemon]);
  assert.equal(report.health.state, "failed");
  assert.equal(report.health.reason, "pill-missing");
  assert.equal(health.describeInstallationHealth(report), "Relay app is not running");
  assert.deepEqual(report.pill, { running: false, intent: "running", lastSeenAt: seen, lastExit: { code: 78, reason: null }, launch: { ok: true, reason: null } });
  assert.match(health.describePillLiveness(report.pill), /^NOT running since 1970-01-01T00:00:00\.900Z; last exit code 78; fix with: relay repair-installation$/);
  assert.equal(JSON.stringify(report).includes(home.homeDir), false, "no path leaves the machine");
});

test("a dangling or re-pointed Relay.app link is reported as the reason the app cannot start", (t) => {
  const home = macHome(t);
  if (!linkOrSkip(t, path.join(home.homeDir, "nowhere", "Electron.app"), home.link)) return;
  let report = collect(home, [home.daemon]);
  assert.deepEqual(report.pill.launch, { ok: false, reason: "link-dangling" });
  assert.match(health.describePillLiveness(report.pill), /cannot launch: link-dangling/);

  fs.unlinkSync(home.link);
  const other = path.join(home.homeDir, ".relay", "runtime", "releases", "0.9.0-old", "node_modules", "relay-companion", "node_modules", "electron", "dist", "Electron.app");
  fs.mkdirSync(path.join(other, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(other, "Contents", "MacOS", "Relay"), "");
  fs.symlinkSync(other, home.link, "dir");
  report = collect(home, [home.daemon, home.pill]);
  assert.equal(report.pill.running, true, "the pill may well be running on the wrong Electron");
  assert.deepEqual(report.pill.launch, { ok: false, reason: "link-wrong-release" });
  assert.notEqual(report.health.state, "failed", "a running pill is not a failure; the mismatch is for the fleet view and doctor to show");
});

test("a pill the person quit is waiting on them, a hidden one is running by choice, and a broken launch file is named without its path", (t) => {
  const home = macHome(t, { linkInPlist: false });
  home.write(path.join(home.homeDir, ".relay", "recovery", "intent.json"), { schema: 1, stopped: true, at: 1 });
  let report = collect(home, [home.daemon]);
  assert.equal(report.health.state, "waiting");
  assert.equal(report.health.reason, "pill-stopped");
  assert.equal(report.pill.intent, "stopped");
  assert.equal(health.describeInstallationHealth(report), "Relay app was quit");
  assert.match(health.describePillLiveness(report.pill), /quit on purpose/);

  fs.rmSync(path.join(home.homeDir, ".relay", "recovery", "intent.json"));
  home.write(home.statusPath, { pid: 99, ready: true, pillHidden: true });
  report = collect(home, [home.daemon, home.pill]);
  assert.notEqual(report.health.state, "failed");
  assert.deepEqual({ running: report.pill.running, intent: report.pill.intent }, { running: true, intent: "hidden" });
  assert.equal(health.describePillLiveness(report.pill), "running, hidden by choice");
  assert.equal(report.pill.lastExit, null, "a running pill is not asked how it last exited");

  fs.rmSync(path.join(home.homeDir, "Library", "LaunchAgents", "work.relay.companion.pill.plist"));
  report = collect(home, [home.daemon]);
  assert.deepEqual(report.pill.launch, { ok: false, reason: "registration-invalid: ENOENT" });
});

test("on Linux the unit's last result is read; elsewhere the OS facts are simply absent", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-liveness-linux-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const root = path.join(homeDir, ".relay"), packageRoot = path.join(root, "runtime", "releases", "1.0.0-test", "node_modules", "relay-companion");
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  write(path.join(root, "runtime", "current.json"), { active: true, version: "1.0.0", packageRoot, bin: path.join(packageRoot, "bin", "relay.js") });
  write(path.join(root, "recovery", "daemon.json"), { version: "1.0.0", pid: 12, at: 1000 });
  const commands = [`node ${packageRoot}/bin/relay.js daemon`];
  const linux = health.collectInstallationHealth({ homeDir, platform: "linux", commands, now: 1001, env: {},
    run: (command) => command === "systemctl" ? { status: 0, stdout: "ExecMainStatus=1\nResult=exit-code\n" } : { status: 1 } });
  assert.equal(linux.health.reason, "pill-missing");
  assert.deepEqual(linux.pill, { running: false, intent: "running", lastSeenAt: null, lastExit: { code: 1, reason: "exit-code" }, launch: null });
  const windows = health.collectInstallationHealth({ homeDir, platform: "win32", commands, now: 1001, env: {}, run: () => assert.fail("no query on Windows") });
  assert.deepEqual(windows.pill, { running: false, intent: "running", lastSeenAt: null, lastExit: null, launch: null });
});
