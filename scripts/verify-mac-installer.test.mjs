import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateInputs, assertDisposable, verifyCandidate, installingOnItsOwn, installEvidence, installerModes, recoveryVersions, pairsDuringSetup, selectStockChannel } from "./verify-mac-installer.mjs";

test("a Dev candidate's stock baseline is moved to Dev by its own CLI before any damage", t => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mac-channel-"));
  t.after(() => fs.rmSync(relayRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(relayRoot, "runtime"));
  fs.writeFileSync(path.join(relayRoot, "config.json"), "{}");
  fs.writeFileSync(path.join(relayRoot, "runtime/current.json"), JSON.stringify({ version: "0.1.440" }));
  const calls = [];
  const env = (updateChannel, version = "0.1.440") => (command, args) => {
    calls.push([command, ...args]);
    fs.writeFileSync(path.join(relayRoot, "config.json"), JSON.stringify({ updateChannel }));
    fs.writeFileSync(path.join(relayRoot, "runtime/current.json"), JSON.stringify({ version }));
  };
  const options = { cli: ["/node", "/stock/bin/relay.js"], relayRoot, baselineVersion: "0.1.440" };
  assert.equal(selectStockChannel({ ...options, channel: "stable", runCommand: env("dev") }), false);
  assert.equal(selectStockChannel({ ...options, runCommand: env("dev") }), false);
  assert.deepEqual(calls, [], "a Stable candidate leaves the stock channel alone");
  assert.equal(selectStockChannel({ ...options, channel: "dev", runCommand: env("dev") }), true);
  assert.deepEqual(calls, [["/node", "/stock/bin/relay.js", "env", "dev"]]);
  assert.throws(() => selectStockChannel({ ...options, channel: "dev", runCommand: env("stable") }), /Dev channel/);
  assert.throws(() => selectStockChannel({ ...options, channel: "dev", runCommand: env("dev", "0.1.568") }), /advanced/);
});

const input = { version: "0.1.567", sourceSha: "a".repeat(40), baseline: "0.1.565", mode: "leftover" };
test("native recovery coverage includes every agreed stock starting version and broken state", () => {
  assert.deepEqual(recoveryVersions, ["0.1.267", "0.1.326", "0.1.413", "0.1.440", "0.1.454", "0.1.490"]);
  for (const version of recoveryVersions) for (const prefix of ["legacy", "broken"]) {
    const mode = `${prefix}-${version}`;
    assert.ok(installerModes.includes(mode));
    validateInputs({ ...input, mode });
  }
  assert.throws(() => validateInputs({ ...input, mode: "legacy-latest" }));
});
// Founder, 0.1.624 (2026-10-10): the proof installs as a person now does, by
// opening Relay from the disk image, with nothing to click.
test("the proof sends no input: it only watches the stock app install itself", () => {
  assert.equal(installingOnItsOwn("relay-setup://app/native-install.html", "Install Relay\nInstalling Relay…\nMoving Relay into your Applications folder."), true);
  assert.equal(installingOnItsOwn("relay-setup://app/native-bootstrap.html", "Installing Relay…"), false);
  assert.equal(installingOnItsOwn("relay-setup://app/native-install.html", "Drag Relay to Applications."), false);
  assert.equal(installingOnItsOwn(undefined, "Installing Relay…"), false);
  const source = fs.readFileSync(new URL("./verify-mac-installer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Input\.dispatch|migration\.relocate/, "no clicks and no privileged bridge");
  const seen = source.indexOf('mark("stock-installer-ui-opened"); mark("install-started-without-input")');
  const screenshot = source.indexOf('client.send("Page.captureScreenshot")');
  assert.ok(seen > 0 && seen < screenshot, "a CDP sighting is recorded before the move can close the renderer");
  assert.match(source, /assertVolumeLayout\(path\.dirname\(target\.app\), \{ volumeName: DMG_VOLUME_NAME,/, "the signed image is the Install Relay window");
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

test("only the stock versions that pair during setup start from the paired-settings fixture", () => {
  // 0.1.267 and 0.1.326 stop setup for a typed pairing code; 0.1.413 onwards set up unattended.
  assert.deepEqual(pairsDuringSetup, ["0.1.267", "0.1.326"]);
  for (const version of pairsDuringSetup) assert.ok(recoveryVersions.includes(version));
  const source = fs.readFileSync(new URL("./verify-mac-installer.mjs", import.meta.url), "utf8");
  assert.match(source, /deviceToken: "relay-ci-placeholder-not-a-credential"/);
  assert.match(source, /apiUrl: "https:\/\/127\.0\.0\.1:9"/, "a placeholder credential never reaches a Relay server");
  assert.match(source, /\[path\.join\(packageRoot, bin\), "install"\][\s\S]*record\("paired-settings-fixture"\)/);
});

test("stock baselines are frozen like a stuck user's Relay, and the candidate runs with updates on", () => {
  const source = fs.readFileSync(new URL("./verify-mac-installer.mjs", import.meta.url), "utf8");
  const freeze = source.indexOf('["setenv", "RELAY_AUTO_UPDATE", "off"]');
  const stockSetup = source.indexOf('const baselineDirectory = path.join(work, "stock-baseline");');
  const release = source.indexOf('["unsetenv", "RELAY_AUTO_UPDATE"]');
  const candidateUi = source.indexOf('mark("stock-installer-ui-opened")');
  assert.ok(freeze > 0 && freeze < stockSetup, "updates are paused before the stock services first start");
  assert.ok(release > stockSetup && release < candidateUi, "and allowed again before the candidate installs");
});

// 0.1.627 and 0.1.629 (2026-10-10): the move and relaunch finished before the
// observer caught the "Installing Relay…" frame, and the proof failed with
// "Installer UI was not seen installing" although nothing was wrong.
test("the app's install log proves the window opened and the move began, without catching a frame", () => {
  const sourceSha = "a".repeat(40), version = "0.1.629", since = Date.parse("2026-10-10T18:49:00Z");
  const line = (event, extra = {}) => JSON.stringify({ at: "2026-10-10T18:49:40.000Z", event, applicationVersion: version, packagingSourceSha: sourceSha,
    root: "/Volumes/Install Relay/Relay.app", ...extra });
  const log = [
    line("install-window-shown"),
    "not json",
    line("relocation-started", { destination: "/Applications/Relay.app", plan: "move" }),
    line("relaunched-from-applications", { root: "/Applications/Relay.app" }),
  ].join("\n");
  const found = installEvidence(log, { since, sourceSha, version });
  assert.deepEqual([found.windowShown, found.relocationStarted, found.relaunched, found.failure], [true, true, true, null]);
  assert.deepEqual(found.events.map(event => event.event), ["install-window-shown", "relocation-started", "relaunched-from-applications"]);
  for (const options of [{ since: since + 60_000, sourceSha, version }, { since, sourceSha: "b".repeat(40), version }, { since, sourceSha, version: "0.1.628" }]) {
    const other = installEvidence(log, options);
    assert.deepEqual([other.windowShown, other.relocationStarted, other.relaunched], [false, false, false], "another build's or an earlier run's lines");
  }
  const elsewhere = installEvidence(line("relaunched-from-applications", { root: "/Users/runner/Applications/Relay.app" }), { since, sourceSha, version });
  assert.equal(elsewhere.relaunched, false, "only a relaunch from /Applications/Relay.app counts");
  const failed = installEvidence(line("relocation-failed", { message: "Another app named Relay is in Applications." }), { since, sourceSha, version });
  assert.equal(failed.failure, "Another app named Relay is in Applications.");
  assert.equal(installEvidence("", { since, sourceSha, version }).relocationStarted, false);
});

test("once the move began, CDP going away is expected and the postconditions decide", () => {
  const source = fs.readFileSync(new URL("./verify-mac-installer.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(install\.relocationStarted\) mark\("install-started-without-input"\);/);
  assert.match(source, /const page = started \? null : await installerPage\(port\);/, "no CDP polling of a process the move replaced");
  assert.match(source, /current\.active && journal\.state === "complete" && install\.relaunched/, "setup finished in the copy reopened from Applications");
  assert.match(source, /verifyCandidate\(read\(path\.join\(destination, "Contents\/Resources\/candidate\.json"\)\), target\.manifest, platform\);/, "the candidate version is in /Applications");
  assert.doesNotMatch(source, /Error\(`Installer UI was not seen installing/, "no failure for missing a frame");
});
