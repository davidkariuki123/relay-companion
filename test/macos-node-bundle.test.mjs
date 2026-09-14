import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const { relayOwnedNodePath } = require("../bootstrap/owned-node-runtime.cjs");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mach-o-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "brew with spaces");
  fs.mkdirSync(path.join(original, "bin"), { recursive: true });
  fs.mkdirSync(path.join(original, "lib"));
  fs.writeFileSync(path.join(root, "leaf.c"), 'const char *version(void) { return "26.0.0"; }');
  fs.writeFileSync(path.join(root, "middle.c"), 'extern const char *version(void); const char *node_version(void) { return version(); }');
  fs.writeFileSync(path.join(root, "main.c"), '#include <stdio.h>\nextern const char *node_version(void); int main(void) { puts(node_version()); return 0; }');
  const leaf = path.join(original, "lib", "leaf.dylib");
  const middle = path.join(original, "lib", "libnode.dylib");
  const node = path.join(original, "bin", "node");
  run("/usr/bin/cc", ["-dynamiclib", path.join(root, "leaf.c"), "-o", leaf, "-Wl,-headerpad_max_install_names", `-Wl,-install_name,${leaf}`]);
  run("/usr/bin/cc", ["-dynamiclib", path.join(root, "middle.c"), leaf, "-o", middle, "-Wl,-headerpad_max_install_names", "-Wl,-install_name,@rpath/libnode.dylib"]);
  run("/usr/bin/cc", [path.join(root, "main.c"), middle, "-o", node, "-Wl,-headerpad_max_install_names", "-Wl,-rpath,@loader_path/../lib"]);
  return { root, original, node, leaf, options: { runtimeRoot: path.join(root, "relay"), isTemporary: () => true } };
}

test("macOS preservation owns rpath and transitive absolute dependencies, even after Homebrew disappears", { skip: process.platform !== "darwin" }, t => {
  const { original, node, options } = fixture(t);
  const owned = relayOwnedNodePath(node, options);
  assert.equal(run(owned, ["-p", "process.versions.node"]), "26.0.0");
  assert.equal(relayOwnedNodePath(node, options), owned, "an intact generation is reused");
  fs.renameSync(original, `${original}.hidden`);
  assert.equal(run(owned, ["-p", "process.versions.node"]), "26.0.0", "must not load any original library");
});

test("corrupt bundle repair publishes a new generation and does not erase the registered executable", { skip: process.platform !== "darwin" }, t => {
  const { node, options } = fixture(t);
  const owned = relayOwnedNodePath(node, options);
  const libs = path.join(path.dirname(owned), "lib");
  const damaged = path.join(libs, fs.readdirSync(libs)[0]);
  fs.writeFileSync(damaged, "corrupt");
  const repaired = relayOwnedNodePath(node, options);
  assert.notEqual(repaired, owned);
  assert.equal(fs.existsSync(owned), true);
  assert.equal(fs.readFileSync(damaged, "utf8"), "corrupt");
  assert.equal(run(repaired, []), "26.0.0");
});

test("a changed dependency invalidates reuse even when the Node executable is unchanged", { skip: process.platform !== "darwin" }, t => {
  const { root, node, leaf, options } = fixture(t);
  const owned = relayOwnedNodePath(node, options);
  const before = fs.readFileSync(node);
  fs.writeFileSync(path.join(root, "leaf.c"), 'const char *version(void) { return "26.0.1"; }');
  run("/usr/bin/cc", ["-dynamiclib", path.join(root, "leaf.c"), "-o", leaf, "-Wl,-headerpad_max_install_names", `-Wl,-install_name,${leaf}`]);
  const upgraded = relayOwnedNodePath(node, options);
  assert.deepEqual(fs.readFileSync(node), before);
  assert.notEqual(upgraded, owned);
  assert.equal(run(upgraded, []), "26.0.1");
  assert.equal(run(owned, []), "26.0.0");
});

test("bundle publication failure preserves the previous registered generation", { skip: process.platform !== "darwin" }, t => {
  const { node, options } = fixture(t);
  const owned = relayOwnedNodePath(node, options);
  const parent = path.dirname(path.dirname(owned));
  fs.unlinkSync(path.join(parent, fs.readdirSync(parent).find(name => name.endsWith(".bundle.json"))));
  assert.throws(() => relayOwnedNodePath(node, { ...options, fsImpl: { ...fs,
    renameSync: () => { throw new Error("interrupted publication"); },
  } }), /interrupted publication/);
  assert.equal(run(owned, []), "26.0.0");
  assert.equal(fs.readdirSync(parent).some(name => name.startsWith(".")), false, "staging files cleaned up");
});

test("missing macOS tooling fails closed with the loader error and concrete repair failure", { skip: process.platform !== "darwin" }, t => {
  const { node, options } = fixture(t);
  assert.throws(() => relayOwnedNodePath(node, { ...options, runCommand(command, args, settings) {
    if (command === "/usr/bin/otool") return { status: 1, stderr: "developer tools unavailable" };
    return spawnSync(command, args, settings);
  } }), /Library not loaded:[\s\S]*otool failed: developer tools unavailable/);
});
