import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import locks from "../bootstrap/recovery-launcher.cjs";
import lifecycle from "../bootstrap/lifecycle-ownership.cjs";
import contract from "../bootstrap/node-contract.cjs";
import client from "../bootstrap/recovery-client.cjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ownership-"));
  t.after(() => { assert.equal(path.dirname(homeDir), os.tmpdir()); fs.rmSync(homeDir, { recursive: true, force: true }); });
  return homeDir;
}
test("Electron and aliases to Electron are rejected without executing a GUI", () => {
  for (const executable of ["/a/Electron.app/Contents/MacOS/Electron", "/a/Relay.app/Contents/MacOS/Relay", "C:\\a\\electron.exe", "C:\\a\\Relay.exe", "/alias"]) {
    assert.equal(contract.verifyNode(executable, { realpath: () => "/a/Electron", run: () => assert.fail("GUI executed") }).ok, false);
  }
  const result = contract.verifyNode("/node", { realpath: x => x, env: { NODE_OPTIONS: "--require evil", ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "evil", SAFE: "yes" },
    run: (_file, args, options) => { assert.match(args[1], /versions.electron/); assert.deepEqual(options.env, { SAFE: "yes" }); return { status: 0, stdout: "22.12.0" }; } });
  assert.equal(result.ok, true);
});
test("a live delegated worker prevents parent release and dead-parent reclamation", t => {
  const homeDir = fixture(t), dir = path.join(homeDir, ".relay", "runtime", "transaction.lock");
  const parent = locks.acquireCanonicalLock(dir);
  const original = JSON.parse(fs.readFileSync(path.join(dir, "owner.json")));
  const member = path.join(dir, `participant-${process.pid}-abcdef.json`);
  fs.writeFileSync(member, JSON.stringify({ nonce: original.nonce, pid: process.pid }));
  parent.release();
  assert.equal(fs.existsSync(dir), true);
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ ...original, pid: 99999999 }));
  assert.throws(() => locks.acquireCanonicalLock(dir), /already in progress/);
  fs.unlinkSync(member);
  const successor = locks.acquireCanonicalLock(dir);
  parent.release();
  assert.equal(fs.existsSync(dir), true, "old release must not remove successor");
  successor.release();
});
test("stale delegated capability cannot join after the owner dies", t => {
  const homeDir = fixture(t), dir = path.join(homeDir, ".relay", "runtime", "transaction.lock");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: 99999999, nonce: "a".repeat(32) }));
  assert.throws(() => lifecycle.lifecycleOwnership({ homeDir, env: { RELAY_LIFECYCLE_OWNER: `99999999:${"a".repeat(32)}` } }), /owner-ended/);
});
test("a real repair child remains fenced after its parent exits", async t => {
  const homeDir = fixture(t), dir = path.join(homeDir, ".relay", "runtime", "transaction.lock");
  const modulePath = fileURLToPath(new URL("../bootstrap/lifecycle-ownership.cjs", import.meta.url));
  const childCode = `const fs=require('node:fs'); const l=require(${JSON.stringify(modulePath)}).lifecycleOwnership({homeDir:${JSON.stringify(homeDir)}}); fs.writeFileSync(${JSON.stringify(path.join(homeDir, "joined"))},'ok'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(homeDir, 'finish'))})){l.assert();l.release();clearInterval(t);}},100);setTimeout(()=>process.exit(2),20000).unref();`;
  const parentCode = `const fs=require('node:fs');const l=require(${JSON.stringify(modulePath)}).lifecycleOwnership({homeDir:${JSON.stringify(homeDir)}});const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{env:l.env,stdio:'ignore',windowsHide:true,detached:true});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(homeDir, "joined"))})){clearInterval(t);process.exit(0);}},20);`;
  const parent = spawn(process.execPath, ["-e", parentCode], { windowsHide: true, stdio: "pipe" });
  let errors = ""; parent.stderr.on("data", data => { errors += data; });
  assert.equal(await new Promise(resolve => parent.once("exit", resolve)), 0, errors);
  assert.throws(() => locks.acquireCanonicalLock(dir), /already in progress/);
  fs.writeFileSync(path.join(homeDir, "finish"), "ok");
  let reclaimed;
  for (let i = 0; i < 60; i++) {
    try { reclaimed = locks.acquireCanonicalLock(dir); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(reclaimed, "dead parent and completed worker must not strand the generation");
  reclaimed.release();
});
test("recovery requests never kill a running controller or rewrite application services", t => {
  const homeDir = fixture(t), calls = [];
  const result = client.requestRecovery({ homeDir, platform: "darwin", userId: 123,
    run: (command, args) => { calls.push([command, ...args]); return { status: 0 }; },
    install: () => assert.fail("controller exists") });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], ["/bin/launchctl", "kickstart", "gui/123/work.relay.companion.recovery"]);
});
test("unavailable supervisor is not mistaken for a missing registration", t => {
  const result = client.requestRecovery({ homeDir: fixture(t), platform: "darwin", packageRoot: "/candidate",
    run: () => ({ error: Error("timeout") }), install: () => assert.fail("must not overwrite") });
  assert.equal(result.reason, "recovery-registration-unavailable");
});
