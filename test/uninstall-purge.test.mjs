import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localStateDirs,
  pathContains,
  purgeLocalState,
  removeClaudeDesktopMcpConfig,
  runningPackageRoot,
} from "../src/install.js";

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

// ---- Windows: uninstall must actually stop the services ---------------------

import { stopWindowsRelayServices, WINDOWS_STOP_RELAY_SERVICES_PS } from "../src/install.js";

/**
 * The PowerShell sweep matches by command line. Reproduce its two -match
 * patterns in JS against real command lines captured on 2026-08-18, so a
 * future edit that stops matching the daemon or pill is caught here rather
 * than by the next person whose uninstall silently un-does itself.
 */
function psSweepMatches(commandLine) {
  const patterns = [...WINDOWS_STOP_RELAY_SERVICES_PS.matchAll(/-match '([^']+)'/g)].map((m) => m[1]);
  assert.equal(patterns.length, 2, "two identity patterns in the sweep");
  // PowerShell single-quoted regex → JS: unescape the doubled backslashes the
  // JS string literal carries for PowerShell's benefit.
  return patterns.some((p) => new RegExp(p.replace(/\\/g, "\\")).test(commandLine));
}

test("the Windows service sweep matches the daemon and pill by identity, and nothing else", () => {
  const daemon = String.raw`"C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node.exe"  "--max-old-space-size=128" "C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\relay-companion\bin\relay.js" "daemon" "--messages-only"`;
  const pill = String.raw`"C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\electron\dist\electron.exe"  "C:\Users\shane\.relay\runtime\releases\0.1.272-1787054239986-10780-afd23d73ca272\node_modules\relay-companion\overlay\main.cjs" "--messages-only"`;
  const pillCmdWrapper = String.raw`"C:\Windows\system32\cmd.exe"  /d /s /c ""C:\Users\shane\.relay\runtime\releases\0.1.272-x\node_modules\electron\dist\electron.exe" "C:\Users\shane\.relay\runtime\releases\0.1.272-x\node_modules\relay-companion\overlay\main.cjs" "--messages-only" >> "C:\Users\shane\.relay\pill.log" 2>&1"`;
  const mcpServer = String.raw`C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node.exe --max-old-space-size=96 C:\Users\shane\.relay\runtime\releases\0.1.269-x\node_modules\relay-companion\bin\relay.js mcp --messages-only`;
  const uninstallItself = String.raw`node.exe C:\Users\shane\.granular-devtools\node-v22.13.0-win-x64\node_modules\relay-companion\bin\relay.js uninstall --purge`;
  const daemonLog = String.raw`notepad.exe C:\Users\shane\.relay\daemon.log`;

  assert.equal(psSweepMatches(daemon), true, "daemon matched");
  assert.equal(psSweepMatches(pill), true, "pill matched");
  assert.equal(psSweepMatches(pillCmdWrapper), true, "pill's cmd wrapper matched (it names main.cjs)");
  assert.equal(psSweepMatches(mcpServer), false, "MCP servers belong to editor sessions; not the sweep's business");
  assert.equal(psSweepMatches(uninstallItself), false, "never terminates the uninstall that is running");
  assert.equal(psSweepMatches(daemonLog), false, "a file path is not a process identity");
});

test("stopWindowsRelayServices ends both tasks, then sweeps survivors by identity", () => {
  const calls = [];
  const res = stopWindowsRelayServices({
    runCommand: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { ok: true, status: 0, out: "" };
    },
  });
  assert.equal(res.swept, true);
  assert.deepEqual(calls[0], ["schtasks", "/End", "/TN", "Relay Companion Daemon"]);
  assert.deepEqual(calls[1], ["schtasks", "/End", "/TN", "Relay Companion Pill"]);
  assert.equal(calls[2][0], "powershell.exe");
  assert.ok(calls[2].includes(WINDOWS_STOP_RELAY_SERVICES_PS), "sweep runs after /End, because /End alone leaves grandchildren alive");
  assert.ok(calls[2].includes("-NonInteractive"));
});
