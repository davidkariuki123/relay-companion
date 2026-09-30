// Host-independent regressions for the interpreter shipped inside Relay.app.
// Run the whole file in Linux CI; test titles are not a selection API.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import contract from "../bootstrap/node-contract.cjs";
import bootstrap from "../bootstrap/relay-setup.cjs";
import { stableNodePath } from "../src/install.js";

const bundled = "/Applications/Relay.app/Contents/Resources/node";
function freshHome(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mac-node-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  // Bootstrap's fallback also defaults to os.homedir(). A broken classifier
  // must never find the developer's real recovery Node and mask the failure.
  t.mock.method(os, "homedir", () => homeDir);
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

test("bundled Node paths and their aliases are accepted, while app executables are rejected", () => {
  for (const executable of [bundled, "/Volumes/Relay Installer/Relay.app/Contents/Resources/node",
    "/Users/A Person/Applications/Relay.app/Contents/Resources/node",
    "C:\\Program Files\\Relay\\resources\\node.exe", "/opt/Relay/resources/node"]) {
    assert.equal(contract.isElectronExecutable(executable, { realpath: x => x }), false, executable);
    assert.equal(contract.isElectronExecutable("/alias/node", { realpath: () => executable }), false, executable);
  }
  for (const executable of ["/Applications/Relay.app", "/Applications/Relay.app/", "/opt/Relay/relay", "/a/Relay Helper.app/Contents/MacOS/Relay Helper"]) {
    assert.equal(contract.isElectronExecutable(executable, { realpath: x => x }), true, executable);
  }
});

test("a fresh home and a failed first-install home resolve to the verified bundled Node", t => {
  const homeDir = freshHome(t);
  const run = file => file === bundled ? { status: 0, stdout: "24.18.0\n" } : assert.fail(`unexpected ${file}`);
  assert.equal(contract.resolveManagedNode({ homeDir, node: bundled, run }), bundled);
  fs.mkdirSync(path.join(homeDir, ".relay"));
  fs.writeFileSync(path.join(homeDir, ".relay", "application-migration.json"), JSON.stringify({ schema: 1, state: "rolled-back" }));
  assert.equal(contract.resolveManagedNode({ homeDir, node: bundled, run }), bundled);
  assert.equal(fs.existsSync(path.join(homeDir, ".relay", "runtime", "current.json")), false);
});

test("both setup entry points select bundled Node with no PATH or recovery fallback", t => {
  const homeDir = freshHome(t);
  const options = {
    homeDir, platform: "darwin", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    existsSync: file => file === bundled,
    realpath: file => file, realpathSync: file => file,
    spawnImpl: () => assert.fail("bundled Node must not search for another interpreter"),
    runCommand: () => assert.fail("bundled Node must not search for another interpreter"),
  };
  assert.equal(bootstrap.stableNodePath(bundled, options), bundled);
  assert.equal(stableNodePath(bundled, options), bundled);
});

test("an unusable bundled interpreter cannot make a fresh installation look healthy", t => {
  const homeDir = freshHome(t);
  for (const result of [{ status: 1, stderr: "cannot execute" }, { status: 0, stdout: "20.0.0" }, { status: 0, stdout: "" }]) {
    assert.throws(() => contract.resolveManagedNode({ homeDir, node: bundled, run: () => result }), /No verified Relay Node/);
  }
});
