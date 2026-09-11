import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installRecovery, uninstallRecovery, windowsRecoveryTaskXml, LABEL, TASK } from "../bootstrap/recovery-install.cjs";

test("Mac watchdog update keeps its registration and host while publishing a complete new bundle", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-watchdog-safe-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let registered = false, failCheck = false;
  const calls = [];
  const options = { homeDir, platform: "darwin", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => process.execPath,
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl") {
        if (args[0] === "print") return { status: registered ? 0 : 113 };
        assert.equal(args[0], "bootstrap", "updates must not unregister their watchdog");
        registered = true; return { status: 0 };
      }
      if (args.includes("--self-check") && failCheck) return { status: 1 };
      return { status: 0 };
    } };
  const first = installRecovery(options);
  assert.equal(first.ok, true, first.detail); assert.equal(registered, true);
  const launcher = fs.readFileSync(first.launcher), pointer = fs.readFileSync(path.join(homeDir, ".relay", "recovery", "current.json"));
  const damaged = path.join(first.bundle, "bootstrap", "recovery-runner.cjs");
  fs.writeFileSync(damaged, "damaged previous bundle");
  failCheck = true;
  assert.equal(installRecovery(options).ok, false);
  assert.deepEqual(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "current.json")), pointer);
  assert.deepEqual(fs.readFileSync(first.launcher), launcher);
  assert.equal(registered, true);
  failCheck = false;
  const repaired = installRecovery(options);
  assert.equal(repaired.ok, true, repaired.detail);
  assert.notEqual(repaired.bundle, first.bundle);
  assert.equal(fs.readFileSync(damaged, "utf8"), "damaged previous bundle", "published bundles are never rewritten in place");
  assert.equal(calls.filter(call => call[1] === "bootstrap").length, 1);
  assert.deepEqual(fs.readFileSync(first.launcher), launcher);
  assert.ok(!fs.readdirSync(path.dirname(first.bundle)).some(name => name.startsWith(".pending-")));
});

test("an uncertain Mac watchdog query never unloads or bootstraps a possibly live job", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-watchdog-query-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const result = installRecovery({ homeDir, platform: "darwin", preserveNode: () => process.execPath,
    packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    runCommand: (command, args) => {
      if (command === "launchctl") { assert.equal(args[0], "print"); return { error: Error("ETIMEDOUT") }; }
      return { status: 0 };
    } });
  assert.equal(result.ok, false); assert.equal(result.detail, "recovery-registration-query-failed");
});

test("the probation host upgrade replaces a valid older launcher without unloading the watchdog", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-upgrade-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, platform: "darwin", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => process.execPath, runCommand: (command, args) => {
      if (command === "launchctl") assert.equal(args[0], "print");
      return { status: 0 };
    } };
  const first = installRecovery(options);
  assert.equal(first.ok, true);
  const root = path.join(homeDir, ".relay", "recovery"), old = Buffer.from("// valid old launcher\n");
  fs.writeFileSync(first.launcher, old);
  fs.writeFileSync(path.join(root, "launcher-host.json"), JSON.stringify({ schema: 1, sha256: crypto.createHash("sha256").update(old).digest("hex") }));
  assert.equal(installRecovery(options).ok, true);
  assert.match(fs.readFileSync(first.launcher, "utf8"), /runtimeProven === true/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "launcher-host.json"))).schema, 3);
});

test("installer process death during bundle preparation leaves the prior launch path usable", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-watchdog-crash-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const options = { homeDir, packageRoot, platform: "darwin", preserveNode: () => process.execPath, runCommand: () => ({ status: 0 }) };
  const first = installRecovery(options);
  assert.equal(first.ok, true);
  const root = path.join(homeDir, ".relay", "recovery"), pointer = fs.readFileSync(path.join(root, "current.json")), launcher = fs.readFileSync(first.launcher);
  // A new release's source differs, forcing preparation of a new bundle.
  const source = path.join(homeDir, "candidate");
  fs.cpSync(path.join(packageRoot, "bootstrap"), path.join(source, "bootstrap"), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(source, "package.json"));
  fs.appendFileSync(path.join(source, "bootstrap", "recovery-runner.cjs"), "\n// next release\n");
  const child = spawnSync(process.execPath, ["-e", `
    const {installRecovery}=require(${JSON.stringify(path.join(packageRoot, "bootstrap", "recovery-install.cjs"))});
    installRecovery({homeDir:${JSON.stringify(homeDir)},packageRoot:${JSON.stringify(source)},platform:'darwin',preserveNode:()=>process.execPath,
      runCommand:(_cmd,args)=>{if(args.includes('--self-check'))process.exit(19);return {status:0};}});
  `], { windowsHide: true, timeout: 10000, encoding: "utf8" });
  assert.equal(child.status, 19, child.stderr);
  assert.deepEqual(fs.readFileSync(path.join(root, "current.json")), pointer);
  assert.deepEqual(fs.readFileSync(first.launcher), launcher);
  assert.equal(spawnSync(process.execPath, [path.join(first.bundle, "bootstrap", "recovery-runner.cjs"), "--self-check"], { windowsHide: true }).status, 0);
  assert.equal(installRecovery({ ...options, packageRoot: source }).ok, true, "a later installation can finish after the crash");
});

test("Windows recovery task registers from XML that starts and keeps running on battery", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-battery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const result = installRecovery({ homeDir, platform: "win32", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => path.join(homeDir, ".relay", "recovery", "node", "node.exe"),
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--check") return spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
      return { status: 0 };
    } });
  assert.equal(result.ok, true, result.detail);
  const create = calls.find(([command, args]) => command === "schtasks.exe" && args[0] === "/Create");
  assert.ok(create, "the task is created");
  assert.deepEqual(create[1].slice(0, 3), ["/Create", "/TN", TASK]);
  assert.equal(create[1][3], "/XML", "schtasks /TR and /SC defaults refuse battery starts; register from XML instead");
  assert.ok(!create[1].includes("/SC") && !create[1].includes("/TR"));
  const xmlPath = create[1][4];
  const bytes = fs.readFileSync(xmlPath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "Task Scheduler needs a UTF-16 BOM");
  const xml = bytes.toString("utf16le").slice(1);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<Repetition><Interval>PT5M<\/Interval><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  const script = path.join(homeDir, ".relay", "recovery", "launch.vbs");
  assert.ok(xml.includes(`<Arguments>//B &quot;${script}&quot;</Arguments>`), "the hidden launcher script is the task action");
  assert.ok(fs.existsSync(script));
});

test("Windows recovery task XML is deterministic for a given start time", () => {
  const xml = windowsRecoveryTaskXml("C:\\Users\\x\\.relay\\recovery\\launch.vbs", new Date(2026, 8, 10, 1, 2, 3));
  assert.match(xml, /<StartBoundary>2026-09-10T01:02:03<\/StartBoundary>/);
  assert.match(xml, /<ExecutionTimeLimit>PT30M<\/ExecutionTimeLimit>/);
  assert.equal((xml.match(/OnBatteries>false</g) || []).length, 2);
});

for (const platform of ["win32", "darwin", "linux"]) test(`independent ${platform} registration uses a Relay-owned node and survives an older rollback`, t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-registration-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const options = { homeDir, platform, packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => path.join(homeDir, ".relay", "recovery", "node", "node"),
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (args[0] === "--check") return spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
      if (command === "systemctl" && args[1] === "show") return { status: 0, stdout: path.join(homeDir, ".config", "systemd", "user", args.at(-1)) };
      return { status: 0 };
    } };
  const result = installRecovery(options);
  assert.equal(result.ok, true, result.detail);
  const root = path.join(homeDir, ".relay", "recovery");
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "current.json")));
  assert.ok(pointer.node.startsWith(root));
  assert.ok(fs.existsSync(path.join(pointer.bundle, "bootstrap", "recovery-runner.cjs")));
  assert.ok(calls.some(([command]) => command === ({win32:"schtasks.exe",darwin:"launchctl",linux:"systemctl"})[platform]));
  fs.writeFileSync(path.join(root, "known-good.json"), JSON.stringify(pointer));
  const replacementNode = path.join(root, "node", "replacement-node");
  assert.equal(installRecovery({ ...options, preserveNode: () => replacementNode }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "launcher-node.json"))).node, pointer.node,
    "the scheduler stays on the proven Node while a replacement awaits a real check");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "current.json"))).node, replacementNode);
  // Simulate a newer *published* bundle for the monotonic-selection check.
  const pkg = JSON.parse(fs.readFileSync(path.join(pointer.bundle, "package.json")));
  pkg.version = "99.0.0"; fs.writeFileSync(path.join(pointer.bundle, "package.json"), JSON.stringify(pkg));
  pointer.version = pkg.version; fs.writeFileSync(path.join(root, "current.json"), JSON.stringify(pointer));
  assert.equal(installRecovery(options).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "current.json"))).version, "99.0.0");
});

for (const reload of [false, true]) test(`Linux recovery resolves its isolated home and uninstalls after reload=${reload}`, t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-isolated-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const linked = new Map();
  let enabled = false;
  let started = false;
  const runCommand = (command, args) => {
    if (command !== "systemctl") return { status: 0 };
    if (args[1] === "link") linked.set(path.basename(args[2]), args[2]);
    if (args[1] === "show") return { status: 0, stdout: linked.get(args.at(-1)) || "" };
    if (["enable", "disable"].includes(args[1])) {
      const units = args.slice(2).filter(arg => !arg.startsWith("--"));
      if (!units.every(name => linked.has(name))) return { status: 1, stderr: "Unit not found" };
      enabled = args[1] === "enable";
      started = enabled && args.includes("--now");
    }
    return { status: 0 };
  };
  const options = { homeDir, platform: "linux", reload, runCommand,
    packageRoot: fileURLToPath(new URL("..", import.meta.url)), preserveNode: () => process.execPath };
  assert.equal(installRecovery(options).ok, true);
  assert.equal(enabled, true, "deferred setup still enables the timer for the next user session");
  assert.equal(started, reload, "deferred setup must not start the recovery worker");
  assert.equal(uninstallRecovery(options).ok, true);
  assert.equal(enabled, false);
  for (const file of linked.values()) assert.equal(fs.existsSync(file), false);
});

test("Linux recovery refuses the wrong systemd fragment and preserves files when stop fails", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-wrong-unit-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let enabled = false;
  const options = { homeDir, platform: "linux", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => process.execPath,
    runCommand: (command, args) => {
      if (args[1] === "enable") enabled = true;
      return { status: 0, stdout: "/another/home/recovery.service" };
    } };
  const installed = installRecovery(options);
  assert.equal(installed.ok, false);
  assert.match(installed.detail, /recovery-unit-not-resolved/);
  assert.equal(enabled, false);
  const removed = uninstallRecovery({ ...options, runCommand: () => ({ ok: false, out: "Failed to connect to bus" }) });
  assert.equal(removed.ok, false);
  assert.equal(removed.detail, "Failed to connect to bus");
  assert.equal(fs.existsSync(path.join(homeDir, ".config", "systemd", "user", `${LABEL}.timer`)), true);
});
