import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountDriftMessage, compareAccountIdentity, persistPairedAccount, persistSignedOutAccount } from "../src/account.js";
import { accountIdentity, writeConfigObject } from "../src/config.js";
import { RelayClient } from "../src/client.js";
import { accountDriftRefusal } from "../src/mcp.js";
import { accountRestartLines, restartRelayServices, windowsRestartServiceScript } from "../src/install.js";

// Every Relay process that outlives a pairing — the daemon, and the `relay mcp`
// server inside each agent session — must notice when config.json moves to a
// different person underneath it. Observed 2026-08-18: after Switch Account in
// the pill, an open Claude Code session kept answering from the PREVIOUS
// account's inbox, and the daemon (whose restart had silently failed) staged
// the previous account's Relays into the store the pill had just wiped.

const OLD = { deviceToken: "dev_old", deviceId: "dev_1", user: { id: "usr_old", name: "Old", email: "old@example.com" } };
const NEW = { deviceToken: "dev_new", deviceId: "dev_2", user: { id: "usr_new", name: "New", email: "new@example.com" } };

function withConfigEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-identity-test-"));
  const prev = { dir: process.env.RELAY_CONFIG_DIR, file: process.env.RELAY_CONFIG, token: process.env.RELAY_DEVICE_TOKEN };
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CONFIG;
  delete process.env.RELAY_DEVICE_TOKEN;
  try {
    return fn(dir);
  } finally {
    for (const [key, name] of [["dir", "RELAY_CONFIG_DIR"], ["file", "RELAY_CONFIG"], ["token", "RELAY_DEVICE_TOKEN"]]) {
      if (prev[key] === undefined) delete process.env[name];
      else process.env[name] = prev[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("compareAccountIdentity names the four ways the account on disk can relate to a bound one", () => {
  const bound = { userId: "usr_a", deviceId: "dev_1", deviceToken: "t1" };
  assert.equal(compareAccountIdentity(bound, { ...bound }), "same");
  assert.equal(compareAccountIdentity(bound, { userId: "usr_a", deviceId: "dev_9", deviceToken: "t2" }), "rotated", "same person, re-paired");
  assert.equal(compareAccountIdentity(bound, { userId: "usr_b", deviceId: "dev_9", deviceToken: "t2" }), "changed", "a different person");
  assert.equal(compareAccountIdentity(bound, { userId: "", deviceId: "", deviceToken: "" }), "signed_out");
  // A process that started unpaired and then sees a pairing has nothing to
  // protect: adopting is right, and it is "rotated", not "changed".
  assert.equal(compareAccountIdentity({ userId: "", deviceId: "", deviceToken: "" }, { userId: "usr_a", deviceId: "dev_1", deviceToken: "t1" }), "rotated");
  assert.equal(compareAccountIdentity(null, undefined), "same");
});

test("RelayClient binds the account at construction and reports drift against config.json", () => {
  withConfigEnv(() => {
    writeConfigObject(OLD);
    const client = new RelayClient();
    assert.equal(client.token, "dev_old");
    assert.equal(client.identity.email, "old@example.com");
    assert.equal(client.accountDrift().status, "same");

    persistPairedAccount({ registration: NEW });
    const drift = client.accountDrift();
    assert.equal(drift.status, "changed");
    assert.equal(drift.bound.email, "old@example.com");
    assert.equal(drift.current.email, "new@example.com");
    // Until told otherwise the client still speaks for the OLD account: that
    // is the whole point — nothing follows the file by accident.
    assert.equal(client.token, "dev_old");

    client.rebindToCurrentAccount();
    assert.equal(client.token, "dev_new");
    assert.equal(client.identity.userId, "usr_new");
    assert.equal(client.accountDrift().status, "same");

    persistSignedOutAccount();
    assert.equal(client.accountDrift().status, "signed_out");
  });
});

test("a client given its own token is pinned: it never follows config.json", () => {
  withConfigEnv(() => {
    writeConfigObject(OLD);
    const pinned = new RelayClient({ url: "https://example.test", token: "dev_pinned" });
    persistPairedAccount({ registration: NEW });
    assert.equal(pinned.accountDrift().status, "same");
    pinned.rebindToCurrentAccount();
    assert.equal(pinned.token, "dev_pinned");
  });
});

test("RELAY_DEVICE_TOKEN wins over the file for identity, as it does for the token", () => {
  withConfigEnv(() => {
    writeConfigObject(OLD);
    process.env.RELAY_DEVICE_TOKEN = "dev_env";
    assert.equal(accountIdentity().deviceToken, "dev_env");
    const client = new RelayClient();
    assert.equal(client.token, "dev_env");
    persistPairedAccount({ registration: NEW });
    assert.equal(client.accountDrift().status, "same", "an env-pinned process is not re-bound by pairing");
  });
});

test("the MCP server adopts a same-user re-pair silently and refuses a changed or signed-out account", () => {
  withConfigEnv(() => {
    writeConfigObject(OLD);
    const client = new RelayClient();
    assert.equal(accountDriftRefusal(client), null, "nothing moved");

    // Same person, new credential: adopt in place, no refusal.
    persistPairedAccount({ registration: { ...OLD, deviceToken: "dev_old_2", deviceId: "dev_1b" } });
    assert.equal(accountDriftRefusal(client), null);
    assert.equal(client.token, "dev_old_2", "the rotated token is adopted");

    // A different person: refuse, name both accounts, say what fixes it.
    persistPairedAccount({ registration: NEW });
    const refusal = accountDriftRefusal(client);
    assert.ok(refusal && refusal.isError, "a changed account is a tool-level error, not a silent switch");
    const text = refusal.content[0].text;
    assert.match(text, /old@example\.com/);
    assert.match(text, /new@example\.com/);
    assert.match(text, /Restart this agent session/i);
    assert.match(text, /Nothing was sent or read/i);
    assert.equal(client.token, "dev_old_2", "the refusing client did NOT adopt the other person's token");

    // Signed out: same shape, different words.
    persistSignedOutAccount();
    const signedOut = accountDriftRefusal(client);
    assert.ok(signedOut && signedOut.isError);
    assert.match(signedOut.content[0].text, /signed out/i);
    assert.match(signedOut.content[0].text, /old@example\.com/);
  });
});

test("accountDriftMessage degrades to ids when the config carries no email", () => {
  assert.match(accountDriftMessage("changed", { bound: { userId: "usr_a" }, current: { userId: "usr_b" } }), /usr_a.*usr_b/s);
  assert.match(accountDriftMessage("signed_out", { bound: {} }), /the previous account/);
});

test("the Windows restart script stops by process identity, starts via the task, and waits for the real process", () => {
  const script = windowsRestartServiceScript("daemon", { waitSeconds: 7 });
  // Identity, not task tree: `schtasks /End` kills the wscript wrapper and
  // leaves node alive (install.js WINDOWS_STOP_RELAY_SERVICES_PS).
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /node\\\.exe\.\*\[\\\\\/\]relay\\\.js\.\*\\bdaemon\\b/, "anchored on node.exe so the cmd wrapper cannot pass for the daemon");
  assert.match(script, /\$_\.ProcessId -ne \$PID/, "never terminates itself");
  assert.match(script, /schtasks \/Query \/TN \$Task/);
  assert.match(script, /Write-Output 'not_installed'/);
  assert.match(script, /Stop-Process -Id \$P\.ProcessId -Force/);
  assert.match(script, /schtasks \/Run \/TN \$Task/);
  // /Run reports success when the ACTION starts, not when the program survives.
  assert.match(script, /AddSeconds\(7\)/);
  assert.match(script, /Write-Output 'restarted'/);
  assert.match(script, /Write-Output 'failed'/);
  const pill = windowsRestartServiceScript("pill");
  assert.match(pill, /Relay Companion Pill/);
  assert.match(pill, /electron\\\.exe/);
  assert.throws(() => windowsRestartServiceScript("nope"), /unknown Relay service/);
});

test("restartRelayServices reports what each platform actually did and never throws", async () => {
  // darwin: a service launchd does not know is not_installed; a kickstart
  // that fails is failed; the pill is left alone unless asked for.
  const darwinCalls = [];
  const darwin = await restartRelayServices({
    platform: "darwin",
    services: ["daemon", "pill"],
    runCommand: (cmd, args) => {
      darwinCalls.push([cmd, ...args].join(" "));
      if (args[0] === "print") return { ok: args[1].endsWith("work.relay.companion") };
      if (args[0] === "kickstart") return { ok: false, out: "kickstart failed" };
      return { ok: false };
    },
  });
  assert.equal(darwin.daemon, "failed");
  assert.equal(darwin.pill, "not_installed");
  assert.equal(darwin.detail.daemon, "kickstart failed");
  assert.ok(darwinCalls.some((c) => c.includes("kickstart -k") && c.endsWith("work.relay.companion")));
  assert.ok(!darwinCalls.some((c) => c.includes("kickstart -k") && c.endsWith("work.relay.companion.pill")), "no kickstart for an unloaded pill");

  // win32: the script's single status word is the answer, wherever it lands in
  // the output; an unparseable output is a failure, not a success.
  const win = await restartRelayServices({
    platform: "win32",
    services: ["daemon"],
    runCommand: () => ({ ok: true, out: "some noise\nrestarted\n" }),
  });
  assert.equal(win.daemon, "restarted");
  assert.equal(win.pill, "skipped");
  const garbled = await restartRelayServices({ platform: "win32", services: ["daemon"], runCommand: () => ({ ok: true, out: "" }) });
  assert.equal(garbled.daemon, "failed");
  assert.equal(garbled.detail.daemon, "no output");

  // an async runner (the pill's) is awaited like a sync one
  const asyncRun = await restartRelayServices({ platform: "win32", services: ["daemon"], runCommand: async () => ({ ok: true, out: "not_installed" }) });
  assert.equal(asyncRun.daemon, "not_installed");

  // a throwing runner is contained
  const thrown = await restartRelayServices({ platform: "darwin", services: ["daemon"], runCommand: () => { throw new Error("boom"); } });
  assert.equal(thrown.daemon, "failed");
  assert.equal(thrown.detail.daemon, "boom");

  // an unknown platform has no supervisor to ask
  const other = await restartRelayServices({ platform: "linux", services: ["daemon"] });
  assert.equal(other.daemon, "not_installed");
});

test("accountRestartLines tells the truth and always names the sessions Relay cannot restart", () => {
  assert.deepEqual(accountRestartLines({ daemon: "not_installed", pill: "not_installed", detail: {} }), [], "a first setup says nothing");
  const ok = accountRestartLines({ daemon: "restarted", pill: "restarted", detail: {} });
  assert.equal(ok.length, 2);
  assert.match(ok[0], /Restarted the background service and Relay app/);
  assert.match(ok[1], /Restart any open Claude Code or Codex sessions/);
  const bad = accountRestartLines({ daemon: "failed", pill: "skipped", detail: { daemon: "no output" } });
  assert.match(bad[0], /background service did not restart \(no output\); run `relay repair-desktop`/);
  assert.match(bad[1], /still on the previous account/);
});
