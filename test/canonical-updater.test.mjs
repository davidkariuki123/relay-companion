import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  UPDATE_WORKER_LABEL,
  UPDATE_WORKER_LABEL_PREFIX,
  activateCanonicalRuntime as activateWithDrain,
  exactRuntimeHealth,
  isElectronExecutable,
  launchHiddenWindowsProcess,
  listUpdateWorkerJobs,
  resolveUpdateWorkerNode,
  reconcileUpdateWorkerJobs,
  runCanonicalUpdateTransaction,
  runtimeNpmCommand,
  spawnCanonicalUpdate,
  smokeCanonicalCandidate,
  CANDIDATE_SMOKE_TIMEOUT_MS,
  inspectUpdateRequest,
  legacyRuntimeTarget,
  waitForUpdateRequestAdmission,
} from "../src/canonical-updater.js";

test("a running tree that lost packages is not offered as a legacy rollback target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", "relay-companion");
  const write = (relative, contents = "") => {
    fs.mkdirSync(path.dirname(path.join(packageRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, relative), contents, { mode: 0o700 });
  };
  write("package.json", JSON.stringify({ name: "relay-companion", version: "0.1.494", dependencies: { "acme-client": "1" } }));
  write(path.join("bin", "relay.js"), "// relay");
  write(path.join("src", "task-daemon.js"), "// daemon");
  write(path.join("overlay", "main.cjs"), "// pill");
  write(path.join("node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"));
  assert.equal(legacyRuntimeTarget(packageRoot, "0.1.494"), null, "acme-client is declared but gone, as after a partial delete");
  fs.mkdirSync(path.join(root, "node_modules", "acme-client"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "acme-client", "package.json"), JSON.stringify({ name: "acme-client" }));
  const target = legacyRuntimeTarget(packageRoot, "0.1.494");
  assert.equal(target?.kind, "legacy");
  assert.equal(target.packageRoot, packageRoot);
});
import {
  canonicalNpmInvocation,
  ensureCandidateElectronRuntime,
  pathWithNodeDirectory,
  readCanonicalRuntime,
  repairCanonicalRuntime,
} from "../src/canonical-runtime.js";

const { installedServiceProcessRows } = createRequire(import.meta.url)("../bootstrap/runtime-health.cjs");
// Service registration fixtures use foreign OS paths; activity admission is
// exercised separately with real temporary homes in update-activity.test.mjs.
const activateCanonicalRuntime = (target, options) => activateWithDrain(target, { ...options, drain: async () => () => {} });

// These cases create a POSIX runtime tree on the real host filesystem. They
// remain active on macOS/Linux; Windows behavior is covered by injected-path
// and Windows-specific tests without asking NTFS to emulate POSIX paths.
const posixFsTest = process.platform === "win32" ? test.skip : test;

test("cold startup gets 120s and retries only a timeout against the same candidate", () => {
  const candidate = { node: "node", bin: "/verified/candidate/bin/relay.js" };
  const calls = [];
  const logs = [];
  const result = smokeCanonicalCandidate(candidate, {
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return calls.length === 1
        ? { status: null, signal: "SIGTERM", error: Object.assign(new Error("slow scan"), { code: "ETIMEDOUT" }) }
        : { status: 0 };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1], "retry reuses the exact candidate and environment");
  assert.equal(calls[0].options.timeout, 120_000);
  assert.equal(calls[0].options.timeout, CANDIDATE_SMOKE_TIMEOUT_MS);
  assert.match(logs[0], /timed out.*elapsed=.*exit=none.*signal=SIGTERM/);
  assert.match(logs[1], /passed/);
});

test("startup timeout is bounded and a real CLI failure is never retried or accepted", () => {
  for (const [failure, reason, expectedCalls] of [
    [{ error: { code: "ETIMEDOUT", message: "too slow" }, status: null }, "candidate-cli-smoke-timeout", 2],
    [{ status: 1, stderr: "bad module" }, "candidate-cli-smoke-failed", 1],
    [{ error: { code: "ENOENT", message: "missing node" }, status: null }, "candidate-cli-smoke-failed", 1],
  ]) {
    let calls = 0;
    const result = smokeCanonicalCandidate({ node: "node", bin: "candidate" }, { run: () => { calls++; return failure; } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(calls, expectedCalls);
  }
});

test("request observation rejects stale identities and identifies a dead worker without an outcome", () => {
  const launch = { requestPath: "request.json", requestId: "r1", workerId: "w1" };
  const request = { ...launch, state: "admitted", workerPid: 123, stage: "download-and-extract" };
  assert.equal(inspectUpdateRequest(launch, { read: () => ({ ...request, workerId: "other" }) }), null);
  assert.equal(inspectUpdateRequest(launch, { read: () => ({ ...request, requestId: "other" }) }), null);
  assert.equal(inspectUpdateRequest(launch, { read: () => request, alive: () => true }).state, "admitted");
  const dead = inspectUpdateRequest(launch, { read: () => request, alive: () => false });
  assert.equal(dead.state, "failed");
  assert.equal(dead.result.reason, "worker-exited");
  assert.equal(dead.result.phase, "download-and-extract");
  assert.equal(inspectUpdateRequest(launch, { read: () => ({ ...request, state: "completed" }), alive: () => false }).state, "completed");
});

test("cold worker admission can exceed five seconds while terminal startup failures return promptly", () => {
  let clock = 0;
  const request = { schema: 1, requestId: "r1", workerId: "w1" };
  const result = waitForUpdateRequestAdmission("request.json", {
    now: () => clock, sleep: (ms) => { clock += ms; },
    fsImpl: { readFileSync: () => JSON.stringify({ ...request, state: clock < 30_000 ? "prepared" : "admitted" }) },
  });
  assert.equal(result.state, "admitted");
  assert.equal(clock, 30_000);
  const failed = waitForUpdateRequestAdmission("request.json", {
    now: () => clock, sleep: () => assert.fail("terminal failure must not wait"),
    fsImpl: { readFileSync: () => JSON.stringify({ ...request, state: "failed" }) },
  });
  assert.equal(failed.state, "failed");
});

test("worker entry logs module-load failures before the updater can start", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeSource = path.join(root, "src");
  fs.mkdirSync(runtimeSource);
  const entry = path.join(runtimeSource, "relay-update-worker.cjs");
  fs.copyFileSync(new URL("../src/relay-update-worker.cjs", import.meta.url), entry);
  const requestPath = path.join(root, ".relay", "runtime", "update-requests", "r1.json");
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify({ schema: 1, requestId: "r1", workerId: "w1", state: "prepared" }));
  const payload = Buffer.from(JSON.stringify({ homeDir: root, platform: process.platform, requestPath, requestId: "r1", workerId: "w1" })).toString("base64url");
  const result = spawnSync(process.execPath, [entry, "--worker", payload], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  assert.equal(request.state, "failed");
  assert.equal(request.result.reason, "worker-startup-failed");
  const log = fs.readFileSync(path.join(root, ".relay", "update.log"), "utf8");
  assert.match(log, /worker starting; pid=/);
  assert.match(log, /worker startup failed/);
  assert.match(log, /worker exited; code=0; elapsed=/);
});

function seedLinuxRuntime(packageRoot, version) {
  for (const [relative, contents, mode] of [
    ["package.json", JSON.stringify({ version }), 0o600],
    ["bin/relay.js", "// bin", 0o700],
    ["src/task-daemon.js", "// daemon", 0o600],
    ["overlay/main.cjs", "// pill", 0o600],
    ["node_modules/electron/dist/electron", "", 0o700],
  ]) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode });
  }
}

test("runtime npm is resolved beside the exact Hermes/Node executable", () => {
  assert.equal(runtimeNpmCommand("/Users/a/.hermes/node/bin/node", {
    platform: "darwin",
    existsSync: (file) => file === "/Users/a/.hermes/node/bin/npm",
  }), "/Users/a/.hermes/node/bin/npm");
  assert.equal(runtimeNpmCommand("C:\\Users\\a\\.hermes\\node\\bin\\node.exe", {
    platform: "win32",
    existsSync: (file) => file.toLowerCase().endsWith("\\npm.cmd"),
  }), "C:\\Users\\a\\.hermes\\node\\bin\\npm.cmd");
});

test("Windows canonical installs execute npm-cli.js through the owning Node runtime", () => {
  const node = "C:\\Users\\a\\.hermes\\node\\bin\\node.exe";
  const npmCommand = "C:\\Users\\a\\.hermes\\node\\bin\\npm.cmd";
  const npmCli = "C:\\Users\\a\\.hermes\\node\\bin\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(canonicalNpmInvocation({
    npmCommand,
    node,
    platform: "win32",
    existsSync: (file) => file === npmCli,
  }), { ok: true, command: node, args: [npmCli] });
});

// The launchd/PATH failure that pinned David's Mac at 0.1.265 for a day: `npm` on
// POSIX is a symlink to npm-cli.js whose shebang is `#!/usr/bin/env node`, and a
// launchd agent's PATH holds no Homebrew/nvm node. Every canonical install died with
// "env: node: No such file or directory" — 35,440 times.
test("POSIX canonical installs execute npm-cli.js through the owning Node runtime", () => {
  const node = "/opt/homebrew/bin/node";
  const npmCommand = "/opt/homebrew/bin/npm";
  const npmCli = "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js";
  assert.deepEqual(canonicalNpmInvocation({
    npmCommand,
    node,
    platform: "darwin",
    realpathSync: (file) => (file === npmCommand ? npmCli : file),
    existsSync: () => false,
  }), { ok: true, command: node, args: [npmCli] });
});

test("a POSIX npm shim that is not a resolvable script falls back to the sibling npm-cli.js", () => {
  const node = "/usr/local/bin/node";
  const npmCommand = "/usr/local/bin/npm";
  const sibling = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
  assert.deepEqual(canonicalNpmInvocation({
    npmCommand,
    node,
    platform: "darwin",
    realpathSync: () => { throw new Error("ENOENT"); },
    existsSync: (file) => file === sibling,
  }), { ok: true, command: node, args: [sibling] });
});

test("an unresolvable POSIX npm still runs directly rather than failing the transaction", () => {
  assert.deepEqual(canonicalNpmInvocation({
    npmCommand: "/weird/npm",
    node: "/weird/node",
    platform: "darwin",
    realpathSync: () => { throw new Error("ENOENT"); },
    existsSync: () => false,
  }), { ok: true, command: "/weird/npm", args: [] });
});

test("the install child's PATH gains the directory owning this Node runtime", () => {
  assert.equal(
    pathWithNodeDirectory("/opt/homebrew/bin/node", { platform: "darwin", env: { PATH: "/usr/bin:/bin" } }),
    "/opt/homebrew/bin:/usr/bin:/bin",
  );
  // idempotent: an already-present directory moves to the front rather than repeating
  assert.equal(
    pathWithNodeDirectory("/opt/homebrew/bin/node", { platform: "darwin", env: { PATH: "/usr/bin:/opt/homebrew/bin" } }),
    "/opt/homebrew/bin:/usr/bin",
  );
  assert.equal(
    pathWithNodeDirectory("C:\\hermes\\node.exe", { platform: "win32", env: { Path: "C:\\Windows" } }),
    "C:\\hermes;C:\\Windows",
  );
});

test("Electron without a lifecycle hook is installed explicitly during canonical staging", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-stage-"));
  const packageRoot = path.join(dir, "node_modules", "relay-companion");
  const electronRoot = path.join(dir, "node_modules", "electron");
  const installScript = path.join(electronRoot, "install.js");
  const electronPath = path.join(electronRoot, "dist", process.platform === "win32" ? "electron.exe" : "electron");
  fs.mkdirSync(electronRoot, { recursive: true });
  fs.writeFileSync(path.join(electronRoot, "package.json"), JSON.stringify({ version: "43.4.1" }));
  fs.writeFileSync(installScript, "// installer");
  const calls = [];
  const result = ensureCandidateElectronRuntime(packageRoot, {
    platform: process.platform === "win32" ? "win32" : "linux",
    node: process.execPath,
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      fs.mkdirSync(path.dirname(electronPath), { recursive: true });
      fs.writeFileSync(electronPath, "binary");
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [installScript]);
});

test("package postinstall delegates to Electron releases that still own their lifecycle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-lifecycle-"));
  const packageRoot = path.join(dir, "node_modules", "relay-companion");
  const electronRoot = path.join(dir, "node_modules", "electron");
  fs.mkdirSync(electronRoot, { recursive: true });
  fs.writeFileSync(path.join(electronRoot, "package.json"), JSON.stringify({
    version: "39.8.10",
    scripts: { postinstall: "node install.js" },
  }));
  fs.writeFileSync(path.join(electronRoot, "install.js"), "// installer");
  const result = ensureCandidateElectronRuntime(packageRoot, {
    platform: process.platform === "win32" ? "win32" : "linux",
    onlyWhenUnscripted: true,
    spawnSyncImpl: () => assert.fail("must not race Electron's own lifecycle installer"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.delegatedToLifecycle, true);
  assert.equal(result.repaired, false);
});

test("Windows canonical npm invocation is spawnable without a shell", { skip: process.platform !== "win32" }, () => {
  const npmCommand = runtimeNpmCommand(process.execPath, { platform: "win32" });
  assert.ok(npmCommand, "the Windows Node runtime should include npm.cmd");
  const invocation = canonicalNpmInvocation({ npmCommand, node: process.execPath, platform: "win32" });
  assert.equal(invocation.ok, true);
  const result = spawnSync(invocation.command, [...invocation.args, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("macOS activation repairs all runtime registrations before restart and requires exact-root health", async () => {
  const calls = [];
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const target = {
    node: "/relay/node",
    bin: "/relay/runtime/releases/241/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/relay/runtime/releases/241/node_modules/relay-companion",
  };
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "" };
    if (command === "/bin/ps") {
      if (args[1] === "uid=,pid=,command=") return { status: 0, stdout: "" };
      return { status: 0, stdout: `${userId} ${target.node} ${target.bin} daemon\n${userId} Electron ${target.packageRoot}/overlay/main.cjs\n` };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = await activateCanonicalRuntime(target, {
    platform: "darwin",
    homeDir: "/Users/test",
    run,
    attempts: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], [target.node, target.bin, "repair-runtime", "--no-restart"]);
  assert.ok(calls.some((call) => call[0] === "/bin/launchctl" && call[1] === "bootout"));
  assert.ok(calls.some((call) => call[0] === "/bin/launchctl" && call[1] === "bootstrap"));
  assert.equal(calls.at(-1)[0], "/bin/ps");
});

test("Windows activation restarts tasks pill-first and rejects processes from an old root", async () => {
  const target = {
    node: "C:\\Relay\\node.exe",
    bin: "C:\\Relay\\runtime\\releases\\241\\node_modules\\relay-companion\\bin\\relay.js",
    packageRoot: "C:\\Relay\\runtime\\releases\\241\\node_modules\\relay-companion",
  };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "" };
    if (command === "powershell.exe") {
      return { status: 0, stdout: "node C:\\old\\relay.js daemon\nElectron C:\\old\\overlay\\main.cjs\n" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = await activateCanonicalRuntime(target, { platform: "win32", run, attempts: 1 });
  assert.equal(result.reason, "exact-root-health-failed");
  const starts = calls.filter((call) => call[0] === "schtasks.exe" && call[1] === "/Run");
  assert.match(starts[0].join(" "), /Pill/);
  assert.match(starts[1].join(" "), /Daemon/);
  assert.equal(exactRuntimeHealth(target, {
    platform: "win32",
    commands: [`NODE ${target.bin.toUpperCase()} daemon`, `ELECTRON ${target.packageRoot.toUpperCase()}\\OVERLAY\\MAIN.CJS`],
  }).ok, true);
  const mixed = exactRuntimeHealth(target, {
    platform: "win32",
    commands: [
      `node ${target.bin} daemon`,
      `Electron ${target.packageRoot}\\overlay\\main.cjs`,
      "node C:\\legacy\\node_modules\\relay-companion\\bin\\relay.js daemon",
      "Electron C:\\legacy\\node_modules\\relay-companion\\overlay\\main.cjs",
    ],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.oldDaemon, true);
  assert.equal(mixed.oldPill, true);
  // The hidden cmd.exe launcher wrapper repeats the whole service command line;
  // it is the same daemon or pill, not a second one, and a second stale wrapper
  // from another tree must not count as an old service either.
  const wrapped = exactRuntimeHealth(target, {
    platform: "win32",
    commands: [
      `"C:\\Windows\\system32\\cmd.exe"  /d /s /c ""C:\\node\\node.exe" "--max-old-space-size=128" "${target.bin}" "daemon" >> "C:\\u\\.relay\\daemon.log" 2>&1"`,
      `"C:\\node\\node.exe"  "--max-old-space-size=128" "${target.bin}" "daemon"`,
      `"C:\\Windows\\system32\\cmd.exe"  /d /s /c ""${target.packageRoot}\\node_modules\\electron\\dist\\electron.exe" "${target.packageRoot}\\overlay\\main.cjs""`,
      `"${target.packageRoot}\\node_modules\\electron\\dist\\electron.exe"  "${target.packageRoot}\\overlay\\main.cjs"`,
      "C:\\Windows\\system32\\cmd.exe /d /s /c \"\"C:\\node\\node.exe\" \"C:\\legacy\\node_modules\\relay-companion\\bin\\relay.js\" \"daemon\"\"",
    ],
  });
  assert.equal(wrapped.ok, true, "cmd.exe wrappers are the same service, not extra ones");
  assert.equal(wrapped.daemonCount, 1);
  assert.equal(wrapped.pillCount, 1);
  assert.equal(wrapped.oldDaemon, false);
});

test("legacy rollback is repaired by the failed candidate CLI with explicit target overrides", async () => {
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const legacy = {
    kind: "legacy",
    node: "/hermes/node/bin/node",
    bin: "/hermes/node/lib/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/hermes/node/lib/node_modules/relay-companion",
  };
  const failed = {
    node: "/relay/node",
    bin: "/Users/test/.relay/runtime/releases/241/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/Users/test/.relay/runtime/releases/241/node_modules/relay-companion",
  };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "" };
    if (command === "/bin/ps") {
      if (args[1] === "uid=,pid=,command=") return { status: 0, stdout: "" };
      return {
        status: 0,
        stdout: `${userId} node ${legacy.bin} daemon\n${userId} Electron ${legacy.packageRoot}/overlay/main.cjs\n`,
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = await activateCanonicalRuntime(legacy, {
    platform: "darwin",
    homeDir: "/Users/test",
    repairExecutable: failed,
    run,
    attempts: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].slice(0, 7), [
    failed.node,
    failed.bin,
    "repair-runtime",
    "--no-restart",
    "--target-bin",
    legacy.bin,
    "--target-node",
  ]);
  assert.equal(calls[0][7], legacy.node);
  assert.notEqual(calls[0][0], legacy.node, "pre-feature legacy CLI is never asked to repair itself");
});

test("transaction supplies explicit legacy rollback and separates smoke from activation", async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".relay-updater-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "lib", "node_modules", "relay-companion");
  const rawHermesNode = path.join(root, ".hermes", "node", "bin", "node");
  const rawHermesNpm = path.join(root, ".hermes", "node", "bin", "npm");
  const durableNode = path.join(root, "public", "bin", "node");
  for (const executable of [rawHermesNode, rawHermesNpm, durableNode]) {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "", { mode: 0o700 });
  }
  for (const [relative, contents, mode] of [
    ["package.json", JSON.stringify({ version: "0.1.240" }), 0o600],
    ["bin/relay.js", "// bin", 0o700],
    ["src/task-daemon.js", "// daemon", 0o600],
    ["overlay/main.cjs", "// pill", 0o600],
    ["node_modules/electron/dist/electron", "", 0o700],
  ]) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode });
  }
  const events = [];
  let options = null;
  let restored = null;
  const failedCandidate = {
    node: durableNode,
    bin: path.join(root, ".relay", "runtime", "releases", "failed", "node_modules", "relay-companion", "bin", "relay.js"),
    packageRoot: path.join(root, ".relay", "runtime", "releases", "failed", "node_modules", "relay-companion"),
  };
  const result = await runCanonicalUpdateTransaction({
    version: "0.1.241",
    runningVersion: "0.1.240",
    runningPackageRoot: packageRoot,
    node: rawHermesNode,
    npmCommand: rawHermesNpm,
    resolveServiceNode: () => durableNode,
    getProtectedPackageRoots: () => ["/relay/runtime/releases/in-use/node_modules/relay-companion"],
    platform: "linux",
    homeDir: root,
    activate: async (target, activationOptions) => {
      restored = { target, activationOptions };
      return { ok: true };
    },
    repair: async (received) => {
      options = received;
      events.push("repair");
      fs.unlinkSync(rawHermesNode);
      const rollback = await received.rollbackActivate(received.rollbackTarget, { failed: failedCandidate });
      assert.equal(rollback.ok, true);
      return { ok: true, candidate: { version: received.version } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(options.rollbackTarget.kind, "legacy");
  assert.equal(options.rollbackTarget.packageRoot, packageRoot);
  assert.equal(options.rollbackTarget.node, durableNode);
  assert.equal(options.node, durableNode, "canonical pointer/service target uses durable public Node");
  assert.equal(options.npmCommand, rawHermesNpm, "npm remains paired to the raw Hermes worker runtime");
  assert.equal(typeof options.preCommitVerify, "function");
  assert.equal(typeof options.postCommitActivate, "function");
  assert.equal(typeof options.rollbackActivate, "function");
  assert.deepEqual(options.protectedPackageRoots, ["/relay/runtime/releases/in-use/node_modules/relay-companion"]);
  assert.equal(restored.target.node, durableNode, "rollback still has a live node after Hermes disappears");
  assert.equal(restored.activationOptions.repairExecutable.node, durableNode);
  assert.deepEqual(events, ["repair"]);
});

test("detached launch uses a one-shot LaunchAgent on macOS and WMI handoff on Windows", () => {
  const captured = [];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-launch-"));
  const files = new Map();
  const fsImpl = {
    mkdirSync() {},
    writeFileSync(file, value) { files.set(file, String(value)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    readFileSync(file) {
      if (!files.has(file)) throw new Error("missing test request");
      return files.get(file);
    },
  };
  const admitted = (requestPath, options) => {
    const request = JSON.parse(options.fsImpl.readFileSync(requestPath, "utf8"));
    return { ...request, state: "admitted", admittedAt: Date.now() };
  };
  const run = (command, args) => {
    captured.push([command, args]);
    return { status: 0, stdout: command.toLowerCase().includes("powershell") ? "123\n" : "", stderr: "" };
  };
  spawnCanonicalUpdate({
    version: "0.1.241", runningVersion: "0.1.240", runningPackageRoot: "/legacy/pkg",
    node: "/usr/bin/node", homeDir, platform: "darwin", run, fsImpl, waitForAdmission: admitted,
  });
  const bootstrap = captured.find(([command, args]) => command === "/bin/launchctl" && args[0] === "bootstrap");
  assert.ok(bootstrap);
  const workerPlist = [...files.entries()].find(([file]) => file.endsWith("update-worker.plist"))?.[1] || "";
  assert.match(workerPlist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(workerPlist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(workerPlist, /--worker/);

  spawnCanonicalUpdate({
    version: "0.1.241", runningVersion: "0.1.240", runningPackageRoot: "C:\\legacy\\pkg",
    node: "C:\\node.exe", homeDir: "C:\\Users\\test", platform: "win32", run, fsImpl, waitForAdmission: admitted,
  });
  const powershell = captured.find(([command]) => /powershell\.exe$/i.test(command));
  assert.ok(powershell);
  const script = Buffer.from(powershell[1].at(-1), "base64").toString("utf16le");
  assert.match(script, /Invoke-CimMethod/);
  assert.match(script, /--worker/);
  // The WMI-created worker must not show a console window (field-observed as a
  // black node.exe window on every Windows machine during each update).
  assert.match(script, /Win32_ProcessStartup/);
  assert.match(script, /ShowWindow=\[uint16\]0/);
  assert.match(script, /ProcessStartupInformation=\$s/);
});

test("launchHiddenWindowsProcess creates the process through WMI with a hidden console and returns its pid", () => {
  const captured = [];
  const run = (command, args) => {
    captured.push([command, args]);
    return { status: 0, stdout: "4242\r\n", stderr: "" };
  };
  const launched = launchHiddenWindowsProcess(["C:\\node.exe", "C:\\pkg\\bootstrap\\update-watchdog.cjs", "--worker", "it's"], {
    run, env: { SystemRoot: "C:\\Windows" },
  });
  assert.deepEqual(launched, { ok: true, pid: 4242, detail: "" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(captured[0][1].slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = Buffer.from(captured[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /ShowWindow=\[uint16\]0/);
  assert.match(script, /ProcessStartupInformation=\$s/);
  // Command-line quoting and PowerShell single-quote escaping both survive.
  assert.match(script, /CommandLine='"C:\\node\.exe" "C:\\pkg\\bootstrap\\update-watchdog\.cjs" "--worker" "it''s"'/);
  assert.doesNotMatch(script, /CREATE_NO_WINDOW|134217728/);

  const failed = launchHiddenWindowsProcess(["C:\\node.exe"], {
    run: () => ({ status: 1, stdout: "", stderr: "Access denied" }), env: {},
  });
  assert.deepEqual(failed, { ok: false, pid: null, detail: "Access denied" });
});

// The pill launches `relay update` with ELECTRON_RUN_AS_NODE=1, which changes
// behaviour but not process.execPath — and `launchctl submit` carries no
// environment. A submitted Electron ran the worker as a GUI app (pid 15090 on
// Sven's Mac): no npm beside it, no exit when the work ended, "Update" did
// nothing visible, forever.
test("the update worker is never launched under Electron", () => {
  const electron = "/Users/x/.relay/runtime/releases/1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  assert.equal(isElectronExecutable(electron), true);
  assert.equal(isElectronExecutable("/opt/homebrew/bin/node"), false);
  assert.equal(isElectronExecutable("C:\\tools\\electron.exe"), true);

  // A real node resolves through the public ladder…
  assert.equal(
    resolveUpdateWorkerNode(electron, {
      platform: "darwin",
      homeDir: "/nonexistent-home",
      existsSync: (file) => file === "/usr/local/bin/node",
      run: (command) => command === "/usr/local/bin/node"
        ? ({ status: 0, stdout: "24.18.0\n" })
        : ({ status: 1, stdout: "" }),
    }),
    "/usr/local/bin/node",
  );
  assert.equal(
    resolveUpdateWorkerNode(electron, {
      platform: "darwin",
      homeDir: "/nonexistent-home",
      existsSync: (file) => file === "/usr/local/bin/node",
      run: (command) => command === "/usr/local/bin/node"
        ? ({ status: 0, stdout: "20.19.0\n" })
        : ({ status: 1, stdout: "" }),
    }),
    null,
    "a durable but incompatible Node must not own the updater",
  );
  // …a non-Electron node passes straight through…
  assert.equal(resolveUpdateWorkerNode("/usr/bin/node", { platform: "darwin" }), "/usr/bin/node");
  // …and with no real node anywhere the spawn refuses instead of submitting Electron.
  assert.equal(
    resolveUpdateWorkerNode(electron, {
      platform: "darwin",
      homeDir: "/nonexistent-home",
      existsSync: () => false,
      run: () => ({ status: 1, stdout: "" }),
    }),
    null,
  );
  assert.throws(() => spawnCanonicalUpdate({
    version: "0.1.241", runningVersion: "0.1.240", runningPackageRoot: "/legacy/pkg",
    node: electron, homeDir: "/nonexistent-home", platform: "darwin",
    spawnImpl: () => { throw new Error("must not spawn"); },
    run: () => ({ status: 1, stdout: "" }),
    existsSync: () => false,
  }), /refusing to launch it under Electron/);
});

// launchd KEEPS submitted jobs: exit 0 leaves the label registered, exit non-zero
// RESTARTS the job forever with its original payload. Sven's storm was ~20 stale
// labels resurrected the moment node became reachable, replaying two dead target
// versions. Reconciliation removes every legacy label and the fixed label admits
// only one current worker.
posixFsTest("legacy worker labels are all reconciled and the fixed label is the sole admission slot", () => {
  const nowMs = 1_700_000_000_000;
  const liveLabel = `${UPDATE_WORKER_LABEL_PREFIX}101.${nowMs - 60_000}`;
  const wedgedLabel = `${UPDATE_WORKER_LABEL_PREFIX}102.${nowMs - 2 * 60 * 60 * 1000}`;
  const finishedLabel = `${UPDATE_WORKER_LABEL_PREFIX}103.${nowMs - 120_000}`;
  const listing = [
    `123\t0\t${liveLabel}`,
    `456\t0\t${wedgedLabel}`,
    `-\t0\t${finishedLabel}`,
    "789\t0\tcom.apple.something",
  ].join("\n");
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "list") return { status: 0, stdout: listing };
    return { status: 0, stdout: "" };
  };
  const jobs = listUpdateWorkerJobs({ run });
  assert.equal(jobs.length, 3);

  const reconciled = reconcileUpdateWorkerJobs({ run });
  assert.equal(reconciled.removedLegacy, 3, "young legacy workers are killed too; they may be the storm source");
  const removed = calls.filter((call) => call[1] === "remove").map((call) => call[2]);
  assert.deepEqual(removed.sort(), [liveLabel, finishedLabel, wedgedLabel].sort());

  // A live fixed worker parks admission without creating a second job.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fixed-worker-"));
  const spawned = spawnCanonicalUpdate({
    version: "0.1.241", runningVersion: "0.1.240", runningPackageRoot: "/legacy/pkg",
    node: "/usr/bin/node", homeDir, platform: "darwin",
    run: (command, args) => (args[0] === "list"
      ? { status: 0, stdout: `123\t0\t${UPDATE_WORKER_LABEL}` }
      : { status: 0, stdout: "" }),
  });
  assert.equal(spawned.status, "busy");
});

posixFsTest("an admission timeout never removes the fixed label and cannot kill a newer owner", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-timeout-"));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "list") return { status: 0, stdout: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = spawnCanonicalUpdate({
    version: "0.1.241",
    runningVersion: "0.1.240",
    runningPackageRoot: "/legacy/pkg",
    node: "/usr/bin/node",
    homeDir,
    platform: "darwin",
    run,
    waitForAdmission: (requestPath, { fsImpl }) => JSON.parse(fsImpl.readFileSync(requestPath, "utf8")),
  });
  assert.equal(result.status, "not-admitted");
  assert.equal(
    calls.some((call) => call[1] === "remove" && call[2] === UPDATE_WORKER_LABEL),
    false,
    "a stale parent must never remove a fixed label that may now belong to another request",
  );
});

test("a worker that loses the canonical transaction lock is reported as busy", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-busy-"));
  const result = spawnCanonicalUpdate({
    version: "0.1.463",
    runningVersion: "0.1.461",
    runningPackageRoot: path.join(homeDir, "old", "node_modules", "relay-companion"),
    node: process.execPath,
    homeDir,
    platform: process.platform,
    run: (command) => ({
      status: 0,
      stdout: process.platform === "win32" && /powershell\.exe$/i.test(command) ? "123\n" : "",
      stderr: "",
    }),
    waitForAdmission: (requestPath, { fsImpl }) => ({
      ...JSON.parse(fsImpl.readFileSync(requestPath, "utf8")),
      state: "failed",
      completedAt: Date.now(),
      result: { ok: false, phase: "lock", reason: "transaction-in-progress", detail: "" },
    }),
  });
  assert.equal(result.status, "busy");
});

// A developer's checkout services (…/packages/companion/…) are not the runtime's
// own: counting them as "old" failed exact-root health on EVERY canonical
// activation while a dev pill ran — rollback, stranded ~650MB release, repeat
// (David's Mac: 140 release dirs in a day).
test("exact-root health ignores processes outside node_modules/relay-companion trees", () => {
  const target = {
    bin: "/u/.relay/runtime/releases/9/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/u/.relay/runtime/releases/9/node_modules/relay-companion",
  };
  const healthy = exactRuntimeHealth(target, {
    platform: "darwin",
    commands: [
      `node ${target.bin} daemon`,
      `Electron ${target.packageRoot}/overlay/main.cjs`,
      "node /Users/dev/src/relay/packages/companion/bin/relay.js daemon",
      "Electron /Users/dev/src/relay/packages/companion/overlay/main.cjs",
    ],
  });
  assert.equal(healthy.ok, true, "dev checkout services are invisible to health");
  assert.equal(healthy.oldPill, false);
  assert.equal(healthy.oldDaemon, false);
  const legacy = exactRuntimeHealth(target, {
    platform: "darwin",
    commands: [
      `node ${target.bin} daemon`,
      `Electron ${target.packageRoot}/overlay/main.cjs`,
      "Electron /usr/local/lib/node_modules/relay-companion/overlay/main.cjs",
    ],
  });
  assert.equal(legacy.ok, false, "legacy global-tree services still count as old");
  assert.equal(legacy.oldPill, true);
});

test("service quiescence sees installed Relay processes but never a developer checkout", () => {
  const target = {
    packageRoot: "/u/.relay/runtime/releases/9/node_modules/relay-companion",
  };
  const result = installedServiceProcessRows(target, {
    processId: 999,
    userId: 1000,
    includeTarget: true,
    run: () => ({
      status: 0,
      stdout: [
        " 1000 101 node /Users/dev/src/relay/packages/companion/bin/relay.js daemon",
        " 1000 102 Electron /Users/dev/src/relay/packages/companion/overlay/main.cjs",
        " 1000 103 node /usr/local/lib/node_modules/relay-companion/bin/relay.js daemon",
        ` 1000 104 Electron ${target.packageRoot}/overlay/main.cjs`,
        " 2000 105 node /usr/local/lib/node_modules/relay-companion/bin/relay.js daemon",
      ].join("\n"),
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map((row) => row.pid), [103, 104]);
});

test("macOS activation fails closed when installed service processes cannot be enumerated", async () => {
  const target = {
    node: "/relay/node",
    bin: "/relay/runtime/releases/242/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/relay/runtime/releases/242/node_modules/relay-companion",
  };
  const calls = [];
  const result = await activateCanonicalRuntime(target, {
    platform: "darwin",
    homeDir: "/Users/test",
    sleep: async () => {},
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "/bin/launchctl" && args[0] === "print") return { status: 113 };
      if (command === "/bin/ps" && args[1] === "uid=,pid=,command=") return { status: 1, stderr: "ps denied" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "service-process-query-failed");
  assert.equal(calls.some((call) => call[1] === "bootstrap"), false);
});

// A pill that left the launchd domain without exiting (or predates the labels)
// holds the singleton lock; the fresh services lose it and health fails 30s later.
// Activation now terminates exactly these — relay-companion trees other than the
// target's — before bootstrapping.
test("activation terminates escaped old-root services before bootstrapping", async () => {
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const target = {
    node: "/relay/node",
    bin: "/relay/runtime/releases/242/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/relay/runtime/releases/242/node_modules/relay-companion",
  };
  const calls = [];
  let orphanAlive = true;
  // The fixture pid must not be this process's own. staleServiceProcessRows
  // skips process.pid so activation can never TERM the updater itself, so a
  // collision silently turns this into a test that asserts nothing -- it sees
  // no stale row, kills nothing, and fails on an empty list. CI runners hand
  // out low pids and a hardcoded 4242 does collide (dev-stage, 84bda8f).
  const orphanPid = String(process.pid + 1);
  const orphanRow = `  ${userId} ${orphanPid} Electron /usr/local/lib/node_modules/relay-companion/overlay/main.cjs`;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/ps" && args[0] === "-axo" && args[1] === "uid=,pid=,command=") {
      return { status: 0, stdout: orphanAlive ? `${orphanRow}\n` : "" };
    }
    if (command === "/bin/ps") {
      return { status: 0, stdout: `${userId} node ${target.bin} daemon\n${userId} Electron ${target.packageRoot}/overlay/main.cjs\n` };
    }
    if (command === "/bin/kill") {
      if (args[0] === "-TERM") orphanAlive = false;
      return { status: 0, stdout: "" };
    }
    if (args[0] === "print") return { status: 113, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const result = await activateCanonicalRuntime(target, {
    platform: "darwin",
    homeDir: "/Users/test",
    run,
    sleep: async () => {},
    attempts: 1,
  });
  assert.equal(result.ok, true, result.reason);
  const kills = calls.filter((call) => call[0] === "/bin/kill");
  assert.deepEqual(kills, [["/bin/kill", "-TERM", orphanPid]], "TERM once, no KILL needed after it dies");
  const firstKill = calls.findIndex((call) => call[0] === "/bin/kill");
  const firstBootstrap = calls.findIndex((call) => call[1] === "bootstrap");
  assert.ok(firstKill < firstBootstrap, "stale services die before the new ones bootstrap");
});

test("the transaction refuses Electron as the service node", async () => {
  const result = await runCanonicalUpdateTransaction({
    version: "0.1.241",
    runningVersion: "0.1.240",
    runningPackageRoot: "/legacy/pkg",
    node: "/apps/Electron.app/Contents/MacOS/Electron",
    resolveServiceNode: (value) => value,
    platform: "darwin",
    homeDir: "/nonexistent-home",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "service-node-electron");
});

posixFsTest("later failed activation rolls back through public Node after Hermes disappears", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(process.cwd(), ".relay-hermes-rollback-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const rawNode = path.join(homeDir, ".hermes", "node", "bin", "node");
  const rawNpm = path.join(homeDir, ".hermes", "node", "bin", "npm");
  const publicNode = path.join(homeDir, "public", "bin", "node");
  for (const executable of [rawNode, rawNpm, publicNode]) {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "", { mode: 0o700 });
  }
  const legacyRoot = path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion");
  seedLinuxRuntime(legacyRoot, "0.1.240");
  const repair = (options) => repairCanonicalRuntime({
    ...options,
    installCandidate: ({ stagingRoot, version }) => {
      seedLinuxRuntime(path.join(stagingRoot, "node_modules", "relay-companion"), version);
      return { ok: true };
    },
  });
  const common = {
    homeDir,
    platform: "linux",
    node: rawNode,
    npmCommand: rawNpm,
    resolveServiceNode: () => publicNode,
    getProtectedPackageRoots: () => [],
    repair,
    smoke: () => ({ ok: true }),
  };
  const migrated = await runCanonicalUpdateTransaction({
    ...common,
    version: "0.1.241",
    runningVersion: "0.1.240",
    runningPackageRoot: legacyRoot,
    activate: async () => ({ ok: true }),
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.candidate.node, publicNode);
  fs.unlinkSync(rawNode);

  let rollbackTarget = null;
  const failed = await runCanonicalUpdateTransaction({
    ...common,
    version: "0.1.242",
    runningVersion: "0.1.241",
    runningPackageRoot: migrated.candidate.packageRoot,
    activate: async (target) => {
      if (target.version === "0.1.242") return { ok: false, reason: "forced-liveness-failure" };
      rollbackTarget = target;
      return { ok: true };
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(rollbackTarget.version, "0.1.241");
  assert.equal(rollbackTarget.node, publicNode);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).node, publicNode);
});

// launchctl bootout returns before the job has left the domain, so a bootstrap
// issued immediately fails with EIO ("Bootstrap failed: 5: Input/output error").
// That was the LAST gate stopping canonical activation on David's Mac once installs
// started succeeding — the transaction rolled back cleanly every single time.
test("macOS activation waits for the label to leave the domain and retries a racing bootstrap", async () => {
  const calls = [];
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  let printsLeft = 2;      // the label lingers for two polls after bootout
  let bootstrapsLeft = 1;  // and the first bootstrap still races
  const result = await activateCanonicalRuntime({
    node: "/relay/node",
    bin: "/relay/runtime/releases/241/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/relay/runtime/releases/241/node_modules/relay-companion",
    version: "0.1.241",
  }, {
    platform: "darwin",
    homeDir: "/home/relay",
    sleep: async () => {},
    attempts: 30,
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "/bin/ps") {
        if (args[1] === "uid=,pid=,command=") return { status: 0, stdout: "" };
        return { status: 0, stdout: `${userId} /relay/node /relay/runtime/releases/241/node_modules/relay-companion/bin/relay.js daemon\n${userId} Electron /relay/runtime/releases/241/node_modules/relay-companion/overlay/main.cjs\n` };
      }
      if (args[0] === "print") {
        printsLeft -= 1;
        return printsLeft >= 0 ? { status: 0, stdout: "" } : { status: 113, stdout: "" };
      }
      if (args[0] === "bootstrap" && bootstrapsLeft > 0) {
        bootstrapsLeft -= 1;
        return { status: 5, stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.ok(calls.some((c) => c.includes("print gui/")), "it waits on the domain rather than bootstrapping blind");
  assert.equal(calls.filter((c) => c.includes("bootstrap")).length, 3, "one retry for the pill, one clean bootstrap for the daemon");
});
