import assert from "node:assert/strict";
import test from "node:test";
import { validateInputs, assertDisposable, verifyCandidate, clickInstallButton } from "./verify-mac-installer.mjs";

const input = { version: "0.1.567", sourceSha: "a".repeat(40), baseline: "0.1.565", mode: "leftover" };
test("successful relocation may close the renderer before mouse-up is acknowledged", async () => {
  const release = Promise.withResolvers(), calls = [];
  let sent = false;
  const click = clickInstallButton({ send: async (_method, params) => {
    calls.push(params.type);
    if (params.type === "mouseReleased") return release.promise;
  } }, { x: 20, y: 40 }, () => { sent = true; });
  await Promise.resolve();
  assert.deepEqual(calls, ["mousePressed", "mouseReleased"]);
  assert.equal(sent, true, "native postconditions must still be checked after the renderer exits");
  release.reject(Error("CDP disconnected during app relaunch"));
  await assert.rejects(click, /disconnected/);
  let pressed = false;
  await assert.rejects(clickInstallButton({ send: async () => { throw Error("not connected"); } },
    { x: 20, y: 40 }, () => { pressed = true; }));
  assert.equal(pressed, false);
});
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

test("retained Dev candidates require the exact public build identity as well as private source", () => {
  const manifest = { version: "0.1.568", sourceSha: "a".repeat(40), publicSourceSha: "b".repeat(40), channel: "dev",
    runtime: { version: "0.1.567", sourceSha: "c".repeat(40) } };
  const candidate = { appId: "work.relay.application", distribution: "application", activationEnabled: true,
    desktopOnboarding: true, platform: "darwin-x64", applicationVersion: manifest.version,
    packagingSourceSha: manifest.sourceSha, packagingPublicSourceSha: manifest.publicSourceSha, packagingSourceDirty: false,
    channel: "dev", version: manifest.runtime.version, runtimeSourceSha: manifest.runtime.sourceSha };
  verifyCandidate(candidate, manifest, "darwin-x64");
  for (const change of [{ packagingPublicSourceSha: undefined }, { packagingPublicSourceSha: "d".repeat(40) },
    { channel: "stable" }, { channel: undefined }, { version: manifest.version }])
    assert.throws(() => verifyCandidate({ ...candidate, ...change }, manifest, "darwin-x64"));
});
