import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRecovery } from "../bootstrap/recovery-install.cjs";

for (const platform of ["win32", "darwin", "linux"]) test(`independent ${platform} registration uses a Relay-owned node and survives an older rollback`, t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-registration-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const options = { homeDir, platform, packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => path.join(homeDir, ".relay", "recovery", "node", "node"),
    runCommand: (command, args) => { calls.push([command, args]); return { status: 0 }; } };
  const result = installRecovery(options);
  assert.equal(result.ok, true, result.detail);
  const root = path.join(homeDir, ".relay", "recovery");
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "current.json")));
  assert.ok(pointer.node.startsWith(root));
  assert.ok(fs.existsSync(path.join(pointer.bundle, "bootstrap", "recovery-runner.cjs")));
  assert.ok(calls.some(([command]) => command === ({win32:"schtasks.exe",darwin:"launchctl",linux:"systemctl"})[platform]));
  // Simulate a newer *published* bundle for the monotonic-selection check.
  const pkg = JSON.parse(fs.readFileSync(path.join(pointer.bundle, "package.json")));
  pkg.version = "99.0.0"; fs.writeFileSync(path.join(pointer.bundle, "package.json"), JSON.stringify(pkg));
  pointer.version = pkg.version; fs.writeFileSync(path.join(root, "current.json"), JSON.stringify(pointer));
  assert.equal(installRecovery(options).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "current.json"))).version, "99.0.0");
});
