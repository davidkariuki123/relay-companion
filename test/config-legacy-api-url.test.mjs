import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_API_URL,
  DEFAULT_DEV_API_URL,
  LEGACY_API_URLS,
  apiUrl,
  canonicalizeApiUrl,
  configPath,
  normalizeUpdateChannel,
  readConfig,
  writeConfigObject,
} from "../src/config.js";

const LEGACY_URL = LEGACY_API_URLS[0];

test("release-channel normalization recognizes staging and fails unknown values closed to stable", () => {
  assert.equal(normalizeUpdateChannel("dev"), "dev");
  assert.equal(normalizeUpdateChannel(" STAGING "), "staging");
  assert.equal(normalizeUpdateChannel("stable"), "stable");
  assert.equal(normalizeUpdateChannel("future-channel"), "stable");
});

function withConfigEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-test-"));
  const previousDir = process.env.RELAY_CONFIG_DIR;
  const previousFile = process.env.RELAY_CONFIG;
  const previousApi = process.env.RELAY_API_URL;
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CONFIG;
  delete process.env.RELAY_API_URL;
  try {
    return fn(dir);
  } finally {
    if (previousDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousDir;
    if (previousFile === undefined) delete process.env.RELAY_CONFIG;
    else process.env.RELAY_CONFIG = previousFile;
    if (previousApi === undefined) delete process.env.RELAY_API_URL;
    else process.env.RELAY_API_URL = previousApi;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("canonicalizeApiUrl maps every legacy origin spelling to the canonical URL", () => {
  assert.equal(canonicalizeApiUrl(LEGACY_URL), DEFAULT_API_URL);
  assert.equal(canonicalizeApiUrl(`${LEGACY_URL}/`), DEFAULT_API_URL);
  assert.equal(canonicalizeApiUrl(` ${LEGACY_URL.toUpperCase()} `), DEFAULT_API_URL);
});

test("canonicalizeApiUrl passes non-legacy values through untouched", () => {
  assert.equal(canonicalizeApiUrl("https://staging.example.com"), "https://staging.example.com");
  assert.equal(canonicalizeApiUrl(DEFAULT_API_URL), DEFAULT_API_URL);
  assert.equal(canonicalizeApiUrl(""), "");
  assert.equal(canonicalizeApiUrl(undefined), undefined);
});

// This test must observe the FIRST legacy read in the process: the persisted
// heal is attempted once per process, so it runs before any other apiUrl()
// call against a legacy config.
test("apiUrl heals a stored legacy origin and preserves every other key", () => {
  withConfigEnv(() => {
    writeConfigObject({
      apiUrl: LEGACY_URL,
      webUrl: "https://sendrelays.com",
      deviceToken: "dev_keepme",
      user: { id: "usr_1", name: "David" },
    });

    assert.equal(apiUrl(), DEFAULT_API_URL);

    const healed = readConfig();
    assert.equal(healed.apiUrl, DEFAULT_API_URL, "config.json should be rewritten to the canonical host");
    assert.equal(healed.deviceToken, "dev_keepme", "the heal must never drop the pairing credential");
    assert.equal(healed.webUrl, "https://sendrelays.com");
    assert.deepEqual(healed.user, { id: "usr_1", name: "David" });

    // Stable on repeat: the healed file now short-circuits the rewrite path.
    assert.equal(apiUrl(), DEFAULT_API_URL);
    assert.equal(fs.readFileSync(configPath(), "utf8").includes("awsapprunner"), false);
  });
});

test("apiUrl leaves a custom (staging/local) origin alone", () => {
  withConfigEnv(() => {
    writeConfigObject({ apiUrl: "http://localhost:4000", deviceToken: "dev_local" });
    assert.equal(apiUrl(), "http://localhost:4000");
    assert.equal(readConfig().apiUrl, "http://localhost:4000");
  });
});

test("apiUrl respects an explicit env override without rewriting the file", () => {
  withConfigEnv(() => {
    writeConfigObject({ apiUrl: LEGACY_URL });
    process.env.RELAY_API_URL = "http://localhost:4100";
    try {
      assert.equal(apiUrl(), "http://localhost:4100");
      assert.equal(readConfig().apiUrl, LEGACY_URL, "env override must not touch the stored config");
    } finally {
      delete process.env.RELAY_API_URL;
    }
  });
});

test("apiUrl falls back to the canonical default when nothing is stored", () => {
  withConfigEnv(() => {
    assert.equal(apiUrl(), DEFAULT_API_URL);
  });
});

test("apiUrl repairs a dev-channel install that still points at production", () => {
  withConfigEnv(() => {
    writeConfigObject({
      apiUrl: DEFAULT_API_URL,
      updateChannel: "dev",
      deviceToken: "dev_keepme",
      user: { id: "usr_dev", name: "Sven" },
    });

    assert.equal(apiUrl(), DEFAULT_DEV_API_URL);
    const healed = readConfig();
    assert.equal(healed.apiUrl, DEFAULT_DEV_API_URL);
    assert.equal(healed.devApiUrl, DEFAULT_DEV_API_URL);
    assert.equal(healed.updateChannel, "dev");
    assert.equal(healed.deviceToken, "dev_keepme");
    assert.deepEqual(healed.user, { id: "usr_dev", name: "Sven" });
  });
});

test("apiUrl preserves an explicit custom origin on the dev channel", () => {
  withConfigEnv(() => {
    writeConfigObject({ apiUrl: "http://localhost:4000", updateChannel: "dev" });
    assert.equal(apiUrl(), "http://localhost:4000");
    assert.equal(readConfig().apiUrl, "http://localhost:4000");
  });
});
