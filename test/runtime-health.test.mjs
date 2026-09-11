import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const health = require("../bootstrap/runtime-health.cjs");

test("memory pressure trips on a small absolute reserve or a small share of the machine", () => {
  const pressure = options => health.memoryPressure({ platform: "win32", ...options });
  assert.equal(pressure({ freeBytes: 11 * 1024 * 1024, totalBytes: 16e9 }).pressured, true);
  assert.equal(pressure({ freeBytes: 700 * 1024 * 1024, totalBytes: 16e9 }).pressured, true);
  assert.equal(pressure({ freeBytes: 3.6e9, totalBytes: 16e9 }).pressured, false);
  // 1 GB free on a 64 GB machine is under 5%: still pressure for a 245 MB extraction.
  assert.equal(pressure({ freeBytes: 1e9, totalBytes: 64e9 }).pressured, true);
  const unknown = pressure({ freeBytes: NaN, totalBytes: 0 });
  assert.equal(unknown.pressured, false);
  assert.equal(unknown.freeMB, null);
  assert.equal(typeof health.memoryPressure().pressured, "boolean");
});

test("macOS uses dispatch pressure flags, not free pages or XNU's internal enum", () => {
  for (const [output, expected] of [["1\n", "normal"], ["2", "warning"], ["4", "critical"], ["0", "unknown"], ["", "unknown"]]) {
    const result = health.memoryPressure({ platform: "darwin", freeBytes: 166 * 1048576, totalBytes: 16e9,
      run: (command, args) => {
        assert.equal(command, "/usr/sbin/sysctl"); assert.deepEqual(args, ["-n", "kern.memorystatus_vm_pressure_level"]);
        return { status: 0, stdout: output };
      } });
    assert.equal(result.level, expected);
    assert.equal(result.pressured, ["warning", "critical"].includes(expected));
  }
  const unavailable = health.memoryPressure({ platform: "darwin", run: () => { throw Error("timeout"); } });
  assert.equal(unavailable.level, "unknown"); assert.equal(unavailable.pressured, false);
});

test("the Windows in-place restart stops only installed services, runs both tasks, and proves the exact root came back", async () => {
  const target = {
    packageRoot: "C:\\u\\.relay\\runtime\\releases\\r\\node_modules\\relay-companion",
    bin: "C:\\u\\.relay\\runtime\\releases\\r\\node_modules\\relay-companion\\bin\\relay.js",
  };
  const commands = [];
  let polls = 0;
  const run = (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "powershell.exe") return { status: 0, stdout: "5932\r\n22592\r\n" };
    return { status: 0, stdout: "" };
  };
  const result = await health.activateWindowsRuntimeServices(target, {
    platform: "win32", run, sleep: async () => {}, now: () => 0, healthCheck: () => ({ ok: ++polls >= 2 }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.terminated, [5932, 22592]);
  assert.equal(polls, 2);
  assert.deepEqual(commands.slice(0, 2), ["schtasks.exe /Query /TN Relay Companion Daemon", "schtasks.exe /Query /TN Relay Companion Pill"]);
  assert.match(commands[2], /^powershell\.exe .*node_modules\[\\\\\/\]relay-companion/);
  assert.match(commands[2], /taskkill\.exe \/PID \$_\.ProcessId \/T \/F/);
  assert.match(commands[2], /GetOwnerSid/);
  assert.deepEqual(commands.slice(3, 5), ["schtasks.exe /Run /TN Relay Companion Daemon", "schtasks.exe /Run /TN Relay Companion Pill"]);

  const missing = await health.activateWindowsRuntimeServices(target, { platform: "win32", run: () => ({ status: 1 }), sleep: async () => {} });
  assert.equal(missing.reason, "service-task-missing");

  let clock = 0;
  const expired = await health.activateWindowsRuntimeServices(target, {
    platform: "win32", run, sleep: async () => { clock += 1000; }, now: () => clock, activationDeadlineMs: 2500, healthCheck: () => ({ ok: false }),
  });
  assert.equal(expired.reason, "activation-deadline-exceeded");

  assert.equal((await health.restartInstalledRuntimeServices(target, { platform: "sunos" })).reason, "activation-platform-unsupported");
  assert.equal((await health.activateWindowsRuntimeServices(target, { platform: "linux" })).reason, "activation-platform-unsupported");
});
