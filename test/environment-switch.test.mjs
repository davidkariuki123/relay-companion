import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const companionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relayBin = path.join(companionRoot, "bin", "relay.js");

function isolatedEnv(configDir) {
  const env = { ...process.env, RELAY_CONFIG_DIR: configDir, RELAY_HOME: path.join(configDir, "runtime") };
  delete env.RELAY_CONFIG;
  delete env.RELAY_API_URL;
  delete env.RELAY_UPDATE_CHANNEL;
  return env;
}

function runRelay(configDir, ...args) {
  return spawnSync(process.execPath, [relayBin, ...args, "--no-trampoline"], {
    cwd: companionRoot,
    env: isolatedEnv(configDir),
    encoding: "utf8",
  });
}

test("relay env staging atomically selects the staging API and release channel", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staging-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const switched = runRelay(dir, "env", "staging", "--api", "https://staging-api.example.com/");
  assert.equal(switched.status, 0, switched.stderr);
  assert.match(switched.stdout, /env set to staging/);
  assert.match(switched.stdout, /production feature set/);

  const stored = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(stored.apiUrl, "https://staging-api.example.com");
  assert.equal(stored.stagingApiUrl, "https://staging-api.example.com");
  assert.equal(stored.updateChannel, "staging");

  const shown = runRelay(dir, "env");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /env: staging/);
  assert.match(shown.stdout, /update channel: staging/);
});

test("relay env staging refuses to switch until an endpoint is explicitly known", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staging-env-missing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runRelay(dir, "env", "staging");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staging API URL is not known yet/);
  assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
});

test("the legacy update-channel command switches API and release code atomically", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-channel-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(runRelay(dir, "env", "prod").status, 0);
  const switched = runRelay(dir, "update-channel", "dev");
  assert.equal(switched.status, 0, switched.stderr);

  const stored = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(stored.updateChannel, "dev");
  assert.equal(stored.apiUrl, "https://dev-api.sendrelays.com");
  assert.equal(stored.devApiUrl, stored.apiUrl);

  const restored = runRelay(dir, "update-channel", "stable");
  assert.equal(restored.status, 0, restored.stderr);
  const production = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(production.updateChannel, "stable");
  assert.equal(production.apiUrl, "https://api.sendrelays.com");
});
