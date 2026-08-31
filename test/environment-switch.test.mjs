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
  delete env.RELAY_WEB_URL;
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
  assert.equal(stored.webUrl, "https://8epdrqim29.us-east-1.awsapprunner.com");
  assert.equal(stored.stagingWebUrl, stored.webUrl);
  assert.equal(stored.updateChannel, "staging");

  const shown = runRelay(dir, "env");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /env: staging/);
  assert.match(shown.stdout, /update channel: staging/);
});

test("relay env staging selects the retained staging API and web origins without flags", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staging-env-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runRelay(dir, "env", "staging");
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(stored.apiUrl, "https://cti37jd7vx.us-east-1.awsapprunner.com");
  assert.equal(stored.webUrl, "https://8epdrqim29.us-east-1.awsapprunner.com");
  assert.equal(stored.updateChannel, "staging");
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
  assert.equal(stored.webUrl, "https://ujvrds7yxv.us-east-1.awsapprunner.com");
  assert.equal(stored.devWebUrl, stored.webUrl);

  const restored = runRelay(dir, "update-channel", "stable");
  assert.equal(restored.status, 0, restored.stderr);
  const production = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(production.updateChannel, "stable");
  assert.equal(production.apiUrl, "https://api.sendrelays.com");
  assert.equal(production.webUrl, "https://sendrelays.com");
});

test("relay env staging accepts and persists an explicit matching web origin", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staging-web-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const switched = runRelay(
    dir,
    "env",
    "staging",
    "--api",
    "https://staging-api.example.com/",
    "--web",
    "https://staging.example.com/",
  );
  assert.equal(switched.status, 0, switched.stderr);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(stored.webUrl, "https://staging.example.com");
  assert.equal(stored.stagingWebUrl, "https://staging.example.com");
});
