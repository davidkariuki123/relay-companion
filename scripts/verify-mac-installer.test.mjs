import assert from "node:assert/strict";
import test from "node:test";
import { validateInputs, assertDisposable, verifyCandidate } from "./verify-mac-installer.mjs";

const input = { version: "0.1.567", sourceSha: "a".repeat(40), baseline: "0.1.565", mode: "leftover" };
test("installer proof requires exact identity and never prepares a newer baseline", () => {
  validateInputs(input);
  validateInputs({ ...input, baseline: "0.1.567" });
  validateInputs({ ...input, baseline: "0.1.99" });
  for (const change of [{ version: "latest" }, { sourceSha: "main" }, { baseline: "0.1.568" },
    { baseline: "1.0.0" }, { baseline: "../file" }, { mode: "skip" }]) {
    assert.throws(() => validateInputs({ ...input, ...change }));
  }
});

test("native installer mutations refuse local machines, private jobs and other refs", () => {
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "davidkariuki123/relay-companion", GITHUB_REF: "refs/heads/main", RUNNER_TEMP: process.cwd() };
  assertDisposable(env, "darwin");
  for (const field of Object.keys(env)) assert.throws(() => assertDisposable({ ...env, [field]: "" }, "darwin"));
  assert.throws(() => assertDisposable(env, "win32"));
  assert.throws(() => assertDisposable({ ...env, RUNNER_ENVIRONMENT: "self-hosted" }, "darwin"));
});

test("embedded receipt must match both signed application and runtime identities", () => {
  const manifest = { version: input.version, sourceSha: input.sourceSha, runtime: { version: "0.1.566", sourceSha: "b".repeat(40) } };
  const candidate = { appId: "work.relay.application", distribution: "application", activationEnabled: true,
    desktopOnboarding: true, platform: "darwin-arm64", applicationVersion: manifest.version,
    packagingSourceSha: manifest.sourceSha, packagingSourceDirty: false,
    version: manifest.runtime.version, runtimeSourceSha: manifest.runtime.sourceSha, channel: "stable" };
  verifyCandidate(candidate, manifest, "darwin-arm64");
  for (const change of [{ appId: "other" }, { distribution: "application-preview" }, { activationEnabled: false },
    { desktopOnboarding: false }, { platform: "darwin-x64" }, { applicationVersion: "0.1.568" },
    { packagingSourceSha: "c".repeat(40) }, { packagingSourceDirty: true }, { version: "0.1.565" },
    { runtimeSourceSha: "c".repeat(40) }, { channel: "dev" }]) {
    assert.throws(() => verifyCandidate({ ...candidate, ...change }, manifest, "darwin-arm64"));
  }
});
