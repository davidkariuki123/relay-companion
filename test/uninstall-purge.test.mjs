import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  electronProfileDirs,
  localStateDirs,
  mcpCliRemovalResult,
  pathContains,
  purgeLocalState,
  removeClaudeDesktopMcpConfig,
  retryUninstallStep,
  runningPackageRoot,
  stopMacRelayProcesses,
  uninstallResultLines,
} from "../src/install.js";
import { uninstallManagedCompanionPackage } from "../src/uninstall-package.js";

const { installCanonicalCliLauncher } = createRequire(import.meta.url)("../bootstrap/relay-setup.cjs");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-${label}-`));
}

test("uninstall removes only the relay server from Claude Desktop's config, atomically, keeping everything else", () => {
  const dir = tmpDir("desktop");
  const configPath = path.join(dir, "claude_desktop_config.json");
  const before = {
    coworkUserFilesPath: "/Users/x/Cowork",
    preferences: { pairedDeviceId: "dev_123", folders: { "/repo": "allow" } },
    mcpServers: {
      relay: { command: "/usr/local/bin/node", args: ["/opt/relay/bin/relay.js", "mcp"] },
      other: { command: "npx", args: ["-y", "some-other-server"] },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(before, null, 2));

  const res = removeClaudeDesktopMcpConfig({ env: { CLAUDE_USER_DATA_DIR: dir } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removedFrom, [configPath]);
  assert.deepEqual(res.failures, []);

  const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(after.mcpServers.relay, undefined, "relay entry removed");
  assert.deepEqual(after.mcpServers.other, before.mcpServers.other, "other servers untouched");
  assert.deepEqual(after.preferences, before.preferences, "preferences untouched");
  assert.equal(after.coworkUserFilesPath, before.coworkUserFilesPath);
  // No temp file left behind from the atomic rename.
  assert.deepEqual(fs.readdirSync(dir), ["claude_desktop_config.json"]);
});

test("a config without a relay entry, or a missing config, is left alone and reported as ok", () => {
  const dir = tmpDir("desktop-none");
  const configPath = path.join(dir, "claude_desktop_config.json");
  const original = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2);
  fs.writeFileSync(configPath, original);
  const res = removeClaudeDesktopMcpConfig({ env: { CLAUDE_USER_DATA_DIR: dir } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removedFrom, []);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "file byte-identical when nothing to remove");

  const missing = tmpDir("desktop-missing");
  const res2 = removeClaudeDesktopMcpConfig({ env: { CLAUDE_USER_DATA_DIR: missing } });
  assert.deepEqual(res2, { ok: true, removedFrom: [], failures: [] });
});

test("a malformed Claude Desktop config is never overwritten; the failure is reported instead", () => {
  const dir = tmpDir("desktop-bad");
  const configPath = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(configPath, '{ "mcpServers": { "relay": {');
  const res = removeClaudeDesktopMcpConfig({ env: { CLAUDE_USER_DATA_DIR: dir } });
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].configPath, configPath);
  assert.equal(fs.readFileSync(configPath, "utf8"), '{ "mcpServers": { "relay": {', "left byte-identical");
});

test("purge deletes the pairing dir and the companion state dir, honouring the same env overrides the readers use", () => {
  const home = tmpDir("home");
  const configDir = path.join(home, ".relay");
  const stateDir = path.join(home, ".relay-companion");
  fs.mkdirSync(path.join(configDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ deviceToken: "dev_secret" }));
  fs.writeFileSync(path.join(configDir, "daemon.log"), "log");
  fs.writeFileSync(path.join(stateDir, "ledger.json"), "{}");
  fs.writeFileSync(path.join(stateDir, "attachments", "a.txt"), "x");
  const [electronProfile] = electronProfileDirs({ platform: process.platform, homeDir: home, env: {} });
  fs.mkdirSync(path.join(electronProfile, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(electronProfile, "Preferences"), "{}");
  const unrelated = path.join(home, "keep.txt");
  fs.writeFileSync(unrelated, "keep");

  assert.deepEqual(localStateDirs({ homeDir: home, env: {} }), [path.resolve(configDir), path.resolve(stateDir)]);

  const res = purgeLocalState({ homeDir: home, env: {} });
  assert.equal(res.ok, true);
  // The credential is removed on its own first, then each state dir.
  assert.equal(res.removed[0], path.join(path.resolve(configDir), "config.json"), "pairing deleted first");
  for (const dir of [configDir, stateDir]) {
    assert.ok(res.removed.includes(path.resolve(dir)), `${dir} removed`);
  }
  assert.equal(fs.existsSync(configDir), false, "pairing dir gone");
  assert.equal(fs.existsSync(stateDir), false, "state dir gone");
  assert.equal(fs.existsSync(electronProfile), false, "Electron profile gone");
  assert.ok(res.removed.includes(electronProfile));
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep", "nothing outside Relay's dirs touched");

  assert.equal(res.pairingRemains, false);

  // Idempotent: a second purge finds nothing and is still ok.
  assert.deepEqual(purgeLocalState({ homeDir: home, env: {} }), {
    ok: true,
    removed: [],
    failed: [],
    pairingRemains: false,
  });

  // Env overrides relocate what gets purged, exactly as they relocate what gets read.
  const alt = tmpDir("alt");
  const altConfig = path.join(alt, "cfg");
  const altState = path.join(alt, "state");
  fs.mkdirSync(altConfig);
  fs.mkdirSync(altState);
  const res2 = purgeLocalState({ homeDir: home, env: { RELAY_CONFIG_DIR: altConfig, RELAY_HOME: altState } });
  assert.deepEqual(res2.removed.sort(), [path.resolve(altConfig), path.resolve(altState)].sort());
  assert.equal(fs.existsSync(altConfig), false);
  assert.equal(fs.existsSync(altState), false);
});

test("purge removes both device and setup credentials in the real native-user scope", () => {
  const home = tmpDir("credential-scope");
  const env = {
    RELAY_CONFIG_DIR: path.join(home, "config"),
    RELAY_HOME: path.join(home, "state"),
    RELAY_NATIVE_CREDENTIALS_WITH_CUSTOM_CONFIG: "1",
    APPDATA: path.join(home, "appdata"),
  };
  const calls = [];
  const result = purgeLocalState({
    homeDir: home,
    env,
    platform: process.platform,
    runningFrom: path.join(os.tmpdir(), "outside-relay"),
    deleteCredential: ({ account }) => {
      calls.push(["device", account]);
      return { ok: true };
    },
    deleteInstallationCredentials: ({ platform }) => {
      calls.push(["installation", platform]);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["device", "device-token"], ["installation", process.platform]]);
});

test("purge never touches native credentials when a test or tool injects another home", () => {
  const home = tmpDir("foreign-home");
  let calls = 0;
  const result = purgeLocalState({
    homeDir: home,
    env: {},
    platform: process.platform,
    deleteCredential: () => { calls += 1; return { ok: true }; },
    deleteInstallationCredentials: () => { calls += 1; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});

test("purge removes an exact legacy bootstrap relay shim on every platform", () => {
  const home = tmpDir("legacy-shim-home");
  const temp = tmpDir("legacy-shim-temp");
  const launcherDir = path.join(temp, "relay-bootstrap-old-handoff");
  const launcherPath = path.join(launcherDir, "relay-cli.cjs");
  const shimPath = path.join(home, ".local", "bin", "relay");
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.mkdirSync(launcherDir, { recursive: true });
  fs.writeFileSync(launcherPath, "// retired handoff");
  fs.writeFileSync(shimPath, `#!/bin/sh\nexec '${process.execPath}' '${launcherPath}' "$@"\n`);

  const result = purgeLocalState({
    homeDir: home,
    env: { TEMP: temp },
    platform: "win32",
    deleteCredential: () => ({ ok: true }),
    deleteInstallationCredentials: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(shimPath), false);
  assert.ok(result.removed.includes(shimPath));
  assert.equal(fs.existsSync(launcherPath), true, "the temp owner cleans its own test/runtime directory");
});

test("complete purge removes the invoking npm-global package and retries transient failures", () => {
  const prefix = String.raw`C:\Tools\node`;
  const packageRoot = String.raw`C:\Tools\node\node_modules\relay-companion`;
  let packagePresent = true;
  let attempts = 0;
  const sleeps = [];
  const result = uninstallManagedCompanionPackage({
    runningRoot: String.raw`C:\Users\x\.relay\runtime\releases\1\node_modules\relay-companion`,
    shimRoot: packageRoot,
    platform: "win32",
    homeDir: String.raw`C:\Users\x`,
    existsSync(candidate) {
      const normalized = path.win32.resolve(candidate).toLowerCase();
      if (normalized === path.win32.resolve(path.win32.join(prefix, "relay.cmd")).toLowerCase()) return true;
      if (normalized === path.win32.resolve(packageRoot).toLowerCase()) return packagePresent;
      return false;
    },
    runCommand(command, args) {
      attempts += 1;
      assert.equal(command, "npm");
      assert.deepEqual(args, ["uninstall", "--global", "--prefix", prefix, "relay-companion"]);
      if (attempts === 2) packagePresent = false;
      return attempts === 1 ? { status: 1, stderr: "EBUSY" } : { status: 0, stdout: "removed" };
    },
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [200]);
});

test("complete purge never uninstalls a checkout or arbitrary project dependency", () => {
  let calls = 0;
  const result = uninstallManagedCompanionPackage({
    runningRoot: "/workspace/relay/packages/companion",
    platform: "linux",
    runCommand: () => { calls += 1; return { status: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test("a direct canonical CLI discovers and removes the npm-global entry package", () => {
  const home = String.raw`C:\Users\x`;
  const globalRoot = String.raw`C:\Node\node_modules`;
  const globalPackage = path.win32.join(globalRoot, "relay-companion");
  const canonical = String.raw`C:\Users\x\.relay\runtime\releases\1\node_modules\relay-companion`;
  let packagePresent = true;
  const calls = [];
  const result = uninstallManagedCompanionPackage({
    runningRoot: canonical,
    platform: "win32",
    homeDir: home,
    existsSync(candidate) {
      const normalized = path.win32.resolve(candidate).toLowerCase();
      if (normalized === path.win32.resolve(globalPackage).toLowerCase()) return packagePresent;
      if (normalized === path.win32.resolve(String.raw`C:\Node\relay.cmd`).toLowerCase()) return true;
      return false;
    },
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "root") return { status: 0, stdout: `${globalRoot}\n` };
      packagePresent = false;
      return { status: 0, stdout: "removed" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.deepEqual(calls, [
    ["npm.cmd", "root", "--global"],
    ["npm", "uninstall", "--global", "--prefix", String.raw`C:\Node`, "relay-companion"],
  ]);
});

test("Linux purge removes Relay's generated command pair but preserves an unrelated relay command", () => {
  const ownedHome = tmpDir("linux-cli-owned");
  const pointerPath = path.join(ownedHome, ".relay", "runtime", "current.json");
  const installed = installCanonicalCliLauncher({ node: process.execPath }, {
    platform: "linux",
    homeDir: ownedHome,
    pointerPath,
    env: {},
  });
  assert.equal(installed.ok, true);

  const purged = purgeLocalState({
    homeDir: ownedHome,
    env: {},
    platform: "linux",
    deleteCredential: () => ({ ok: true }),
  });
  assert.equal(purged.ok, true);
  assert.equal(fs.existsSync(installed.shimPath), false, "Relay's generated command is removed");
  assert.equal(fs.existsSync(installed.launcherPath), false, "Relay's generated launcher is removed");
  assert.ok(purged.removed.includes(installed.shimPath));
  assert.ok(purged.removed.includes(installed.launcherPath));

  const collisionHome = tmpDir("linux-cli-unrelated");
  const collisionInstall = installCanonicalCliLauncher({ node: process.execPath }, {
    platform: "linux",
    homeDir: collisionHome,
    env: {},
  });
  assert.equal(collisionInstall.ok, true);
  const unrelatedShim = collisionInstall.shimPath;
  const unrelatedSource = "#!/bin/sh\necho someone-else\n";
  fs.writeFileSync(unrelatedShim, unrelatedSource);
  fs.writeFileSync(path.join(collisionHome, ".relay", "config.json"), "{}\n");

  const collisionPurge = purgeLocalState({
    homeDir: collisionHome,
    env: {},
    platform: "linux",
    deleteCredential: () => ({ ok: true }),
  });
  assert.equal(collisionPurge.ok, true);
  assert.equal(fs.readFileSync(unrelatedShim, "utf8"), unrelatedSource, "an unrelated relay command is untouched");
  assert.equal(collisionPurge.removed.includes(unrelatedShim), false);

  const damagedHome = tmpDir("linux-cli-damaged");
  const damagedInstall = installCanonicalCliLauncher({ node: process.execPath }, {
    platform: "linux",
    homeDir: damagedHome,
    env: {},
  });
  assert.equal(damagedInstall.ok, true);
  fs.rmSync(damagedInstall.launcherPath, { force: true });
  purgeLocalState({
    homeDir: damagedHome,
    env: {},
    platform: "linux",
    deleteCredential: () => ({ ok: true }),
  });
  assert.equal(fs.existsSync(damagedInstall.shimPath), false, "an exact orphaned Relay shim is still removed");

  fs.rmSync(ownedHome, { recursive: true, force: true });
  fs.rmSync(collisionHome, { recursive: true, force: true });
  fs.rmSync(damagedHome, { recursive: true, force: true });
});

test("purging from inside the canonical runtime kills the pairing first and the running release last", () => {
  // Reproduces the real layout: since the canonical runtime, the tree being
  // deleted contains the tree the process is executing from.
  const home = tmpDir("canonical");
  const configDir = path.join(home, ".relay");
  const release = path.join(configDir, "runtime", "releases", "0.1.268-abc", "node_modules", "relay-companion");
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, "package.json"), '{"version":"0.1.268"}');
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ deviceToken: "dev_secret" }));
  fs.writeFileSync(path.join(configDir, "daemon.log"), "log");

  assert.equal(pathContains(configDir, release, "linux"), true, "the release is inside the purge target");

  const order = [];
  const realRm = fs.rmSync;
  fs.rmSync = (target, opts) => {
    order.push(path.relative(home, target));
    return realRm(target, opts);
  };
  let res;
  try {
    res = purgeLocalState({ homeDir: home, env: {}, runningFrom: release, platform: "linux" });
  } finally {
    fs.rmSync = realRm;
  }

  // The credential goes first — before anything that could fail and abort.
  assert.equal(order[0], path.join(".relay", "config.json"), `pairing deleted first, got ${order[0]}`);
  // The branch we are executing from goes after the ordinary entries.
  const runtimeIdx = order.findIndex((p) => p === path.join(".relay", "runtime"));
  const logIdx = order.findIndex((p) => p === path.join(".relay", "daemon.log"));
  assert.ok(runtimeIdx > logIdx, `running branch deleted after the rest (runtime ${runtimeIdx}, log ${logIdx})`);

  assert.equal(res.ok, true);
  assert.equal(res.pairingRemains, false, "machine is genuinely forgotten");
  assert.equal(fs.existsSync(configDir), false, "nothing left behind when nothing is locked");
});

test("one locked file never spares its neighbours — even when purging from OUTSIDE the tree", () => {
  // The 2026-08-18 production observation: running from the global shim (not
  // inside ~/.relay), a locked daemon.log made the whole-directory rmSync throw
  // and every other file survived. Entry-by-entry must apply regardless of
  // where the process lives.
  const home = tmpDir("outside");
  const configDir = path.join(home, ".relay");
  fs.mkdirSync(path.join(configDir, "runtime", "releases", "r1"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ deviceToken: "dev_secret" }));
  fs.writeFileSync(path.join(configDir, "daemon.log"), "locked");
  fs.writeFileSync(path.join(configDir, "pill.log"), "free");
  fs.writeFileSync(path.join(configDir, "relay-daemon.vbs"), "free");

  const lockedFile = path.join(configDir, "daemon.log");
  const realRm = fs.rmSync;
  fs.rmSync = (target, opts) => {
    // A locked file fails its own delete AND any recursive delete of an
    // ancestor that still contains it — exactly as the OS behaves.
    const t = path.resolve(String(target));
    if (t === lockedFile || (fs.existsSync(lockedFile) && pathContains(t, lockedFile, "linux"))) {
      const err = new Error(`EBUSY: resource busy or locked, unlink '${lockedFile}'`);
      err.code = "EBUSY";
      throw err;
    }
    return realRm(target, opts);
  };
  let res;
  try {
    // runningFrom is far away from the purge target.
    res = purgeLocalState({ homeDir: home, env: {}, runningFrom: "/opt/global/node_modules/relay-companion", platform: "linux" });
  } finally {
    fs.rmSync = realRm;
  }

  assert.equal(res.pairingRemains, false);
  assert.equal(fs.existsSync(path.join(configDir, "pill.log")), false, "unlocked neighbour deleted");
  assert.equal(fs.existsSync(path.join(configDir, "relay-daemon.vbs")), false, "unlocked neighbour deleted");
  assert.equal(fs.existsSync(path.join(configDir, "runtime")), false, "unlocked subtree deleted");
  assert.equal(fs.existsSync(path.join(configDir, "daemon.log")), true, "only the locked file remains");
  assert.equal(res.ok, false);
  assert.ok(res.failed.some((f) => f.path.endsWith("daemon.log")), "names the one locked file");
  // The directory itself is reported too (it cannot go while a child remains).
  assert.ok(res.failed.some((f) => path.resolve(f.path) === path.resolve(configDir)));
});

test("a release that cannot be deleted still leaves the machine forgotten, and says so", () => {
  const home = tmpDir("locked");
  const configDir = path.join(home, ".relay");
  const runtime = path.join(configDir, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ deviceToken: "dev_secret" }));

  // Simulate Windows holding the running release open (EBUSY) while everything
  // else deletes cleanly.
  const realRm = fs.rmSync;
  fs.rmSync = (target, opts) => {
    if (String(target).includes(`${path.sep}runtime`)) {
      const err = new Error("EBUSY: resource busy or locked");
      err.code = "EBUSY";
      throw err;
    }
    return realRm(target, opts);
  };
  let res;
  try {
    res = purgeLocalState({ homeDir: home, env: {}, runningFrom: runtime, platform: "linux" });
  } finally {
    fs.rmSync = realRm;
  }

  assert.equal(res.ok, false, "the failure is reported, not swallowed");
  assert.ok(res.failed.some((f) => f.path.includes("runtime")), "names the file it could not delete");
  // The point of the ordering: a locked runtime must never save the pairing.
  assert.equal(res.pairingRemains, false, "pairing still gone despite the locked release");
  assert.equal(fs.existsSync(path.join(configDir, "config.json")), false);
});

test("uninstall retries transient failures and retains attempt evidence", () => {
  let calls = 0;
  const sleeps = [];
  const result = retryUninstallStep("codex_config", "Codex config", () => {
    calls += 1;
    return calls < 3 ? { ok: false, detail: `locked ${calls}` } : { ok: true, removed: true };
  }, {
    attempts: 3,
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.history.length, 3);
  assert.deepEqual(sleeps, [150, 300]);
});

test("an already-absent MCP registration is success, while a real CLI failure is not", () => {
  assert.equal(mcpCliRemovalResult({ ok: false, out: "No MCP server found with name: relay" }).ok, true);
  assert.equal(mcpCliRemovalResult({ ok: false, out: "No MCP server named 'relay' found." }).ok, true);
  assert.equal(mcpCliRemovalResult({ ok: false, missing: true, out: "ENOENT" }).ok, true);
  const denied = mcpCliRemovalResult({ ok: false, status: 1, out: "Access denied" });
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /Access denied/);
});

test("uninstall output never claims success when retries are exhausted", () => {
  const failure = retryUninstallStep("claude_hooks", "Claude Code's Relay hooks", () => ({
    ok: false,
    detail: "settings.json is locked",
  }), { attempts: 3, sleep: () => {} });
  const lines = uninstallResultLines({ ok: false, failures: [failure] });
  assert.match(lines.join("\n"), /uninstall is incomplete/i);
  assert.match(lines.join("\n"), /after 3 attempts/i);
  assert.match(lines.join("\n"), /settings\.json is locked/i);
  assert.doesNotMatch(lines.join("\n"), /^Removed Relay/m);
});

test("successful uninstall explains the open-session context boundary", () => {
  const lines = uninstallResultLines({ ok: true, failures: [] });
  assert.match(lines.join("\n"), /disconnected live Relay MCP processes/i);
  assert.match(lines.join("\n"), /cannot retract Relay instructions/i);
  assert.match(lines.join("\n"), /makes those instructions inert/i);
});

test("relay CLI emits structured uninstall results and fails its exit status when incomplete", () => {
  const source = fs.readFileSync(new URL("../bin/relay.js", import.meta.url), "utf8");
  assert.match(source, /uninstallResultLines\(uninstalled\)/);
  assert.match(source, /if \(!uninstalled\.ok\) process\.exitCode = 1/);
  assert.match(source, /uninstallManagedCompanionPackage/);
  assert.match(source, /if \(!purged\.ok\)[\s\S]*process\.exitCode = 1/);
  assert.doesNotMatch(source, /console\.log\("Removed Relay from Claude Code, Codex, and Claude Desktop/);
});

// ---- Windows: uninstall must actually stop the services ---------------------

import { stopPosixMcpBrokers, stopWindowsRelayServices, WINDOWS_STOP_RELAY_SERVICES_PS } from "../src/install.js";

/**
 * The PowerShell sweep matches by command line. Reproduce its two -match
 * patterns in JS against real command lines captured on 2026-08-18, so a
 * future edit that stops matching the daemon or pill is caught here rather
 * than by the next person whose uninstall silently un-does itself.
 */
function psSweepMatches(commandLine) {
  const patterns = [...WINDOWS_STOP_RELAY_SERVICES_PS.matchAll(/-match '([^']+)'/g)].map((m) => m[1]);
  assert.equal(patterns.length, 5, "one installed-tree boundary and four Relay process identities in the sweep");
  // PowerShell single-quoted regex → JS: unescape the doubled backslashes the
  // JS string literal carries for PowerShell's benefit.
  const matches = patterns.map((p) => new RegExp(p.replace(/\\/g, "\\")).test(commandLine));
  return matches[0] && matches.slice(1).some(Boolean);
}

test("the Windows service sweep matches the daemon and pill by identity, and nothing else", () => {
  const daemon = String.raw`"C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node.exe"  "--max-old-space-size=128" "C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\relay-companion\bin\relay.js" "daemon" "--messages-only"`;
  const pill = String.raw`"C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\electron\dist\electron.exe"  "C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\relay-companion\overlay\main.cjs" "--messages-only"`;
  const pillCmdWrapper = String.raw`"C:\Windows\system32\cmd.exe"  /d /s /c ""C:\Users\shane\.relay\runtime\releases\0.1.272-x\node_modules\electron\dist\electron.exe" "C:\Users\shane\.relay\runtime\releases\0.1.272-x\node_modules\relay-companion\overlay\main.cjs" "--messages-only" >> "C:\Users\shane\.relay\pill.log" 2>&1"`;
  const mcpServer = String.raw`C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node.exe --max-old-space-size=96 C:\Users\shane\.relay\runtime\releases\0.1.269-x\node_modules\relay-companion\bin\relay.js mcp --messages-only`;
  const uninstallItself = String.raw`node.exe C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node_modules\relay-companion\bin\relay.js uninstall --purge`;
  const daemonLog = String.raw`notepad.exe C:\Users\shane\.relay\daemon.log`;
  const devCheckout = String.raw`node.exe C:\Users\shane\src\relay\packages\companion\bin\relay.js daemon`;

  assert.equal(psSweepMatches(daemon), true, "daemon matched");
  assert.equal(psSweepMatches(pill), true, "pill matched");
  assert.equal(psSweepMatches(pillCmdWrapper), true, "pill's cmd wrapper matched (it names main.cjs)");
  assert.equal(psSweepMatches(mcpServer), true, "open-session MCP servers are disconnected during uninstall");
  const broker = String.raw`C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node.exe --max-old-space-size=512 C:\Users\shane\.relay\runtime\releases\0.1.292-x\node_modules\relay-companion\src\mcp-broker-entry.js --domain=abc`;
  assert.equal(psSweepMatches(broker), true, "the shared broker is swept during uninstall");
  assert.equal(psSweepMatches(uninstallItself), false, "never terminates the uninstall that is running");
  assert.equal(psSweepMatches(daemonLog), false, "a file path is not a process identity");
  assert.equal(psSweepMatches(devCheckout), false, "a developer checkout is outside the installed-tree boundary");
});

test("stopWindowsRelayServices ends both tasks, then sweeps survivors by identity", () => {
  const calls = [];
  const res = stopWindowsRelayServices({
    runCommand: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { ok: true, status: 0, out: "" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.swept, true);
  assert.deepEqual(calls[0], ["schtasks", "/End", "/TN", "Relay Companion Daemon"]);
  assert.deepEqual(calls[1], ["schtasks", "/End", "/TN", "Relay Companion Pill"]);
  assert.equal(calls[2][0], "powershell.exe");
  assert.ok(calls[2].includes(WINDOWS_STOP_RELAY_SERVICES_PS), "sweep runs after /End, because /End alone leaves grandchildren alive");
  assert.ok(calls[2].includes("-NonInteractive"));
});

test("POSIX uninstall stops only same-account installed and exact-runtime brokers", () => {
  const killed = [];
  const scope = "scope123";
  const result = stopPosixMcpBrokers({
    userId: 501,
    processId: 999,
    configScopeId: scope,
    runCommand: () => ({
      ok: true,
      out: [
        `501 101 /usr/bin/node /Users/ada/.relay/runtime/node_modules/relay-companion/src/mcp-broker-entry.js --config-scope=${scope}`,
        `501 102 /usr/bin/node /Users/ada/src/relay/packages/companion/src/mcp-broker-entry.js --config-scope=${scope}`,
        "501 103 /usr/bin/node /Users/ada/.relay/runtime/node_modules/relay-companion/src/mcp-broker-entry.js --config-scope=other",
        `502 104 /usr/bin/node /Users/other/.relay/runtime/node_modules/relay-companion/src/mcp-broker-entry.js --config-scope=${scope}`,
        `501 105 /usr/bin/node /tmp/mcp-broker-entry.js --config-scope=${scope}`,
      ].join("\n"),
    }),
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [[101, "SIGTERM"], [102, "SIGTERM"]]);
});

test("macOS uninstall process sweep also terminates live MCP children", () => {
  let alive = true;
  const killed = [];
  const result = stopMacRelayProcesses({
    sleep: () => {},
    processId: 999,
    userId: 501,
    runCommand(command, args) {
      if (command === "/bin/ps") {
        return {
          ok: true,
          out: alive
            ? " 501 321 node /Users/x/.relay/runtime/releases/1/node_modules/relay-companion/bin/relay.js mcp\n"
            : "",
        };
      }
      if (command === "/bin/kill") {
        killed.push(args);
        alive = false;
      }
      return { ok: true, out: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [["-TERM", "321"]]);
});
