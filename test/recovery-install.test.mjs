import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installRecovery, uninstallRecovery, windowsRecoveryTaskXml, LABEL, TASK } from "../bootstrap/recovery-install.cjs";

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
