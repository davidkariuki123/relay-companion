import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const background = require("../bootstrap/relay-background-install.cjs");
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupEntry = path.resolve(testDirectory, "../bootstrap/relay-setup.cjs");
const backgroundEntry = path.resolve(testDirectory, "../bootstrap/relay-background-install.cjs");

test("background Companion install returns immediately and writes observable state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-background-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let invocation = null;
  let unrefCalled = false;
  const fakeChild = { pid: process.pid, unref() { unrefCalled = true; } };
  const result = background.startBackgroundInstall({
    homeDir: root,
    entry: setupEntry,
    spawnImpl(command, args, options) { invocation = { command, args, options }; return fakeChild; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(unrefCalled, true);
  assert.deepEqual(invocation.args.slice(0, 2), [backgroundEntry, "--worker"]);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.windowsHide, true);
  const state = background.readStatus({ homeDir: root });
  assert.equal(state.status, "starting");
  assert.equal(state.logPath, path.join(root, ".relay", "companion-install.log"));
});

test("background worker command uses the no-MCP agent protocol install path", () => {
  const source = fs.readFileSync(new URL("../bootstrap/relay-background-install.cjs", import.meta.url), "utf8");
  assert.match(source, /\[entry, "setup", "--agent-protocol"\]/);
  assert.match(source, /stdio: \["ignore", output, output\]/);
});
