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

test("background installation status and log follow the selected Relay directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-background-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { homeDir: root, env: { RELAY_CONFIG_DIR: path.join(root, "dev-relay") } };
  background.startBackgroundInstall({ ...options, entry: setupEntry, spawnImpl: () => ({ pid: process.pid, unref() {} }) });
  assert.equal(background.statusPath(options), path.join(root, "dev-relay", "companion-install.json"));
  assert.equal(background.readStatus(options).logPath, path.join(root, "dev-relay", "companion-install.log"));
  assert.equal(fs.existsSync(path.join(root, ".relay")), false);
});

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

test("background worker command uses the browser-approved agent setup path", () => {
  const source = fs.readFileSync(new URL("../bootstrap/relay-background-install.cjs", import.meta.url), "utf8");
  assert.match(source, /\[entry, "setup", "--agent-protocol"\]/);
  assert.match(source, /stdio: \["ignore", output, output\]/);
});

function authorizationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-background-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    RELAY_CONFIG_DIR: root,
    RELAY_AGENT_CONFIG: path.join(root, "custom-credential.json"),
    RELAY_AGENT_AUTHORIZATION: path.join(root, "custom-pending.json"),
  };
  background.atomicWriteJson(background.statusPath({ env }), {
    version: 1, status: "installing", pid: process.pid,
  });
  return { env, credential: env.RELAY_AGENT_CONFIG, pending: env.RELAY_AGENT_AUTHORIZATION };
}

test("a prepared Companion waits through approval renewal and the complete credential handoff", async (t) => {
  const { env, credential, pending } = authorizationFixture(t);
  fs.writeFileSync(pending, "first approval");
  let elapsed = 0;
  let polls = 0;
  await background.waitForAgentAuthorization({
    env, now: () => elapsed, timeoutMs: 10_000,
    sleep: async (ms) => {
      elapsed += ms;
      polls++;
      assert.equal(background.installationStatus({ env }).status, "waiting_authorization");
      const duplicate = background.startBackgroundInstall({ env, spawnImpl: () => assert.fail("must not start a second installer") });
      assert.equal(duplicate.alreadyRunning, true);
      if (polls === 1) fs.writeFileSync(pending, "renewed approval");
      if (polls === 2) fs.writeFileSync(credential, "private credential contents are not read here");
      if (polls === 3) fs.rmSync(pending);
    },
  });
  assert.equal(polls, 3, "credential creation alone is not a completed handoff");
  assert.equal(background.installationStatus({ env }).status, "installing");
});

test("approval completed during download needs no wait", async (t) => {
  const { env, credential } = authorizationFixture(t);
  fs.writeFileSync(credential, "adoption validates this later");
  await background.waitForAgentAuthorization({ env, sleep: () => assert.fail("already approved") });
  assert.equal(background.installationStatus({ env }).status, "installing");
});

test("a missing approval times out without creating credentials or starting account adoption", async (t) => {
  const { env, credential } = authorizationFixture(t);
  let elapsed = 0;
  await assert.rejects(background.waitForAgentAuthorization({
    env, now: () => elapsed, timeoutMs: 2500,
    sleep: async (ms) => { elapsed += ms; },
  }), /Finish the Relay connection, then retry background-install/);
  assert.equal(elapsed, 2500);
  assert.equal(fs.existsSync(credential), false);
});

test("a stopped installer awaiting authorization is reported as failed", (t) => {
  const { env } = authorizationFixture(t);
  background.atomicWriteJson(background.statusPath({ env }), { version: 1, status: "waiting_authorization", pid: 0 });
  assert.equal(background.installationStatus({ env }).status, "failed");
  assert.equal(background.installationStatus({ env }).reason, "installer_stopped");
});

test("background setup waits after verified staging and before runtime activation", () => {
  const source = fs.readFileSync(setupEntry, "utf8");
  const staging = source.indexOf("const runtime = await stageVerifiedRuntime");
  const waiting = source.indexOf(".waitForAgentAuthorization()", staging);
  const activation = source.indexOf("const activated = await activateRuntime", staging);
  assert.ok(staging >= 0 && waiting > staging && activation > waiting);
  assert.match(source.slice(staging, waiting), /setupCompatibilityArgs.includes\("--agent-protocol"\).*RELAY_BACKGROUND_INSTALL_WORKER === "1"/);
});
