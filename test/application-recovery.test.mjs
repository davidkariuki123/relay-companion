import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import recovery from "../bootstrap/application-recovery.cjs";
import { resetApplication } from "../src/application-recovery.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installer-recovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const releaseRoot = path.join(homeDir, ".relay/runtime/releases/candidate");
  const write = (relative, value = "keep") => {
    const file = path.join(homeDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
  };
  write(".relay/runtime/releases/candidate/node_modules/relay-companion/src/application-recovery.js");
  write(".relay/runtime/transaction.lock/owner.json");
  write(".relay/runtime/transaction.lock/participant.json");
  write(".relay/config.json", '{"deviceToken":"do-not-log"}');
  write(".relay/runtime/current.json");
  write(".relay/runtime/releases/old/node_modules/relay-companion/bin/relay.js");
  write(".relay-companion/outbox.json");
  write("unrelated/notes.txt");
  recovery.writeJournal(homeDir, { schema: 1, state: "cleaning", releaseRoot });
  return { homeDir, releaseRoot, write };
}

test("reset preserves candidate, lease and journal while removing only Relay state", t => {
  const f = fixture(t);
  recovery.resetState(f);
  for (const file of [".relay/runtime/releases/candidate/node_modules/relay-companion/src/application-recovery.js", ".relay/runtime/transaction.lock/owner.json", ".relay/runtime/transaction.lock/participant.json", ".relay/runtime/installer-recovery.json", "unrelated/notes.txt"]) assert.ok(fs.existsSync(path.join(f.homeDir, file)), file);
  for (const file of [".relay/config.json", ".relay/runtime/current.json", ".relay/runtime/releases/old", ".relay-companion"]) assert.equal(fs.existsSync(path.join(f.homeDir, file)), false, file);
  recovery.resetState(f); // Idempotent after interruption or repeat cleanup.
});

test("redirected roots and candidates outside releases fail before cleanup", t => {
  const f = fixture(t);
  assert.throws(() => recovery.resetState({ ...f, releaseRoot: path.join(f.homeDir, "unrelated") }), /candidate root/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-unrelated-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "notes.txt"), "untouched");
  const link = path.join(f.homeDir, "profile");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => recovery.resetState({ ...f, profileDirs: [link] }), /redirected/);
  assert.ok(fs.existsSync(path.join(f.homeDir, ".relay/config.json")));
  assert.equal(fs.readFileSync(path.join(outside, "notes.txt"), "utf8"), "untouched");
});

test("symlinks inside cleared state never delete their targets", t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.homeDir, "unrelated"), path.join(f.homeDir, ".relay/linked"), process.platform === "win32" ? "junction" : "dir");
  recovery.resetState(f);
  assert.equal(fs.readFileSync(path.join(f.homeDir, "unrelated/notes.txt"), "utf8"), "keep");
});

function operations(f, events) {
  return { ...f,
    lease: () => ({ delegated: true, env: {}, assert: () => {}, release: () => events.push("release") }),
    profiles: () => [], config: () => ({ deviceToken: "do-not-log" }),
    uninstall: () => { events.push("stop"); return { ok: true }; },
    revoke: async () => { events.push("revoke"); },
    deleteToken: () => { events.push("credential"); return { ok: true }; },
    deleteAuthorizations: () => ({ ok: true }),
    reset: args => { events.push("reset"); recovery.resetState(args); },
  };
}

test("new runtime stops services, retires credentials then resets with a live lease", async t => {
  const f = fixture(t), events = [];
  await resetApplication(operations(f, events));
  assert.deepEqual(events, ["stop", "revoke", "credential", "reset", "release"]);
  const text = fs.readFileSync(recovery.journalPath(f.homeDir), "utf8");
  assert.ok(!text.includes("do-not-log"));
  assert.equal(JSON.parse(text).deviceRetirement, "revoked");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.homeDir, ".relay/desktop-onboarding.json"))).accountId, null);
});

test("recovery keeps the native installer's Start Menu shortcut", async t => {
  const f = fixture(t), options = operations(f, []);
  let uninstallOptions;
  options.uninstall = args => { uninstallOptions = args; return { ok: true }; };
  await resetApplication(options);
  assert.equal(uninstallOptions.keepWindowsShortcut, true);
});

test("failed services or credential removal prevents clearing account state", async t => {
  for (const step of ["services", "credentials", "lease"]) {
    const f = fixture(t), events = [], options = operations(f, events);
    if (step === "services") options.uninstall = () => ({ ok: false, failures: [{ id: "service" }] });
    if (step === "credentials") options.deleteToken = () => ({ ok: false });
    if (step === "lease") options.lease = () => ({ delegated: false, release() {} });
    await assert.rejects(resetApplication(options));
    assert.ok(!events.includes("reset"));
    assert.ok(fs.existsSync(path.join(f.homeDir, ".relay/config.json")));
  }
});

test("offline device retirement is recorded without blocking local recovery", async t => {
  const f = fixture(t), options = operations(f, []);
  options.revoke = async () => { throw Error("offline"); };
  await resetApplication(options);
  assert.equal(recovery.marker(recovery.journalPath(f.homeDir)).deviceRetirement, "needs-account-review");
});

test("candidate cleanup never launches an old CLI or inherits custom state overrides", t => {
  const f = fixture(t), calls = [];
  const runtime = { packageRoot: path.join(f.releaseRoot, "node_modules/relay-companion") };
  recovery.recoverWithCandidate({ ...f, runtime, bundle: { node: "/new/bundled-node" },
    run: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; } });
  assert.equal(calls[0].command, "/new/bundled-node");
  assert.equal(calls[0].args[0], path.join(runtime.packageRoot, "src/application-recovery.js"));
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(calls[0].options.env.RELAY_CONFIG_DIR, undefined);
});
