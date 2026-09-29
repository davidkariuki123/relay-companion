// Run only on a disposable public GitHub Mac. The downloaded application is
// never patched. CDP observes the renderer and sends ordinary mouse input;
// relocation, relaunch and activation execute through the shipped UI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrap = fs.existsSync(path.join(repo, "bootstrap/application-release.cjs"))
  ? path.join(repo, "bootstrap") : path.join(repo, "packages/companion/bootstrap");
const release = require(path.join(bootstrap, "application-release.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

export function validateInputs({ version, sourceSha, baseline, mode }) {
  assert.match(version || "", /^\d+\.\d+\.\d+$/);
  assert.match(sourceSha || "", /^[a-f0-9]{40}$/);
  assert.ok(["fresh", "leftover"].includes(mode), "Choose fresh or leftover mode");
  if (mode === "leftover") {
    assert.match(baseline || "", /^\d+\.\d+\.\d+$/);
    const a = baseline.split(".").map(BigInt), b = version.split(".").map(BigInt);
    const different = a.findIndex((n, i) => n !== b[i]);
    assert.ok(different === -1 || a[different] < b[different], "Baseline cannot be newer than candidate");
  }
}

export function assertDisposable(env = process.env, platform = process.platform) {
  assert.equal(platform, "darwin", "Use a disposable Mac runner");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(env.GITHUB_REPOSITORY, "davidkariuki123/relay-companion");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP));
}

export function verifyCandidate(candidate, manifest, platform) {
  assert.equal(candidate.appId, "work.relay.application");
  assert.equal(candidate.distribution, "application");
  assert.equal(candidate.activationEnabled, true);
  assert.equal(candidate.desktopOnboarding, true);
  assert.equal(candidate.platform, platform);
  assert.equal(candidate.applicationVersion || candidate.version, manifest.version);
  assert.equal(candidate.packagingSourceSha, manifest.sourceSha);
  assert.equal(candidate.packagingSourceDirty, false);
  assert.equal(candidate.version, manifest.runtime.version);
  assert.equal(candidate.runtimeSourceSha, manifest.runtime.sourceSha);
  assert.equal(candidate.channel || "stable", "stable");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map();
  let serial = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error("CDP connection timed out")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("CDP connection failed")); }, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error("CDP disconnected during app relaunch")); }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const domState = `(() => {
  const e = document.querySelector('#install');
  const r = e?.getBoundingClientRect();
  const notice = document.querySelector('.notice');
  return { text: document.body.innerText, notice: notice && !notice.hidden ? notice.innerText : '',
    button: e && !e.disabled && r.width > 0 ? { x:r.x+r.width/2, y:r.y+r.height/2 } : null };
})()`;

async function installerPage(port) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
    return targets.find(item => item.type === "page" && /^relay-setup:\/\/app\/native-(install|bootstrap)\.html$/.test(item.url));
  } catch { return null; }
}

export async function main(inputs) {
  validateInputs(inputs); assertDisposable();
  const platform = `darwin-${process.arch}`;
  assert.ok(["darwin-arm64", "darwin-x64"].includes(platform));
  const relayRoot = path.join(os.homedir(), ".relay"), destination = "/Applications/Relay.app";
  for (const file of [relayRoot, destination, path.join(os.homedir(), "Applications/Relay.app"),
    path.join(os.homedir(), ".relay-companion"), path.join(os.homedir(), "Library/Application Support/Relay Application")]) {
    assert.equal(fs.existsSync(file), false, `Refusing existing runner state: ${file}`);
  }
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "relay-mac-proof-"));
  const evidence = path.resolve("mac-installer-evidence");
  fs.mkdirSync(evidence, { recursive: true });
  const proof = { schema: 1, ...inputs, platform, workflowSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    ok: false, checks: [], browserDownloadTested: false, quarantineLaunchTested: false,
    signInTested: false, rebootTested: false, interaction: "CDP mouse input in stock signed renderer" };
  const mounts = [];
  let lastText = "", phase = "verify-download";
  const record = name => { proof.checks.push(name); console.log(`PASS ${name}`); };
  async function download(version, sourceSha, name) {
    const response = await fetch(`https://api.sendrelays.com/v1/application-releases/v${version}/manifest.json`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert.equal(response.ok, true, `No immutable signed installer manifest for ${version}`);
    const envelope = await response.json();
    // Baseline source is authenticated by the same committed trust roots.
    const identity = sourceSha || JSON.parse(Buffer.from(envelope.payload, "base64")).sourceSha;
    const manifest = release.verifyApplicationRelease(envelope, { version, sourceSha: identity, channel: "stable" });
    const artifact = manifest.artifacts[platform].find(item => item.kind === "dmg");
    const dmg = path.join(work, `${name}.dmg`);
    run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--max-time", "180", artifact.url, "--output", dmg], { timeout: 190_000 });
    await release.verifyApplicationArtifact(dmg, artifact);
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dmg]);
    run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
    const mount = path.join(work, name);
    run("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
    mounts.push(mount);
    const app = path.join(mount, "Relay.app");
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    const candidate = read(path.join(app, "Contents/Resources/candidate.json"));
    verifyCandidate(candidate, manifest, platform);
    return { app, candidate, manifest, artifact };
  }
  try {
    const target = await download(inputs.version, inputs.sourceSha, "candidate");
    proof.artifact = target.artifact; proof.runtime = target.manifest.runtime;
    record("signed-manifest-and-exact-dmg"); record("codesign-staple-and-gatekeeper-assessment");
    if (inputs.mode === "leftover") {
      const baseline = await download(inputs.baseline, null, "baseline");
      run("/usr/bin/ditto", [baseline.app, destination]);
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
      fs.mkdirSync(relayRoot, { recursive: true });
      fs.writeFileSync(path.join(relayRoot, "application-migration.json"), JSON.stringify({
        schema: 1, state: "rolled-back", previous: null, failure: "CI fixture: prior first setup failed", at: Date.now(),
      }));
      proof.baselineArtifact = baseline.artifact;
      proof.leftoverState = "Stock signed old app plus rolled-back journal; no runtime or recovery Node";
      record("leftover-failed-install-fixture");
    }
    // Keep GitHub's development tools out of the application's search path,
    // including its LaunchServices relaunch. The harness keeps its own Node.
    const appEnv = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "RELAY_CONFIG_DIR", "RELAY_HOME", "RELAY_COMPANION_HOME"]) {
      delete appEnv[name]; run("/bin/launchctl", ["unsetenv", name]);
    }
    run("/bin/launchctl", ["setenv", "PATH", appEnv.PATH]);
    assert.equal(fs.existsSync(path.join(relayRoot, "runtime/current.json")), false);
    assert.equal(fs.existsSync(path.join(relayRoot, "recovery")), false);
    const port = 19347;
    phase = "open-installer-ui";
    run("/usr/bin/open", ["-n", "-a", target.app, "--args", `--remote-debugging-port=${port}`], { env: appEnv });
    const openedAt = Date.now(), deadline = openedAt + 8 * 60_000;
    let clicked = false, firstHeartbeat;
    while (Date.now() < deadline) {
      const page = await installerPage(port);
      if (page) {
        let client;
        try {
          client = await cdp(page.webSocketDebuggerUrl);
          const state = (await client.send("Runtime.evaluate", { expression: domState, returnByValue: true })).result?.value;
          if (state?.text && state.text !== lastText) {
            lastText = state.text;
            fs.writeFileSync(path.join(evidence, "last-ui.txt"), lastText);
            console.log(`UI: ${lastText.slice(0, 1200)}`);
            const screenshot = await client.send("Page.captureScreenshot");
            fs.writeFileSync(path.join(evidence, "last-ui.png"), Buffer.from(screenshot.data, "base64"));
          }
          if (state?.notice) throw Object.assign(Error(`Installer UI: ${state.notice}`), { installerFailure: true });
          if (!clicked && state?.button && page.url.endsWith("native-install.html")) {
            record("stock-installer-ui-opened");
            // Ordinary renderer input; never call the privileged preload bridge.
            await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...state.button, button: "left", clickCount: 1 });
            await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...state.button, button: "left", clickCount: 1 });
            clicked = true; phase = "relocate-and-activate"; record("install-button-clicked");
          }
        } catch (error) {
          if (error.installerFailure) throw error;
          // Moving the app closes its renderer. Poll the relaunched app and
          // filesystem next; a timeout is a failure, never a skipped success.
          proof.lastObserverError = error.message;
        } finally { client?.close(); }
      }
      if (clicked && fs.existsSync(path.join(relayRoot, "runtime/current.json"))) {
        const current = read(path.join(relayRoot, "runtime/current.json"));
        const journal = read(path.join(relayRoot, "application-migration.json"));
        if (current.active && journal.state === "complete") {
          assert.equal(current.version, target.manifest.runtime.version);
          assert.equal(current.releaseId, journal.releaseId);
          assert.equal(read(path.join(current.packageRoot, "package.json")).version, target.manifest.runtime.version);
          verifyCandidate(read(path.join(destination, "Contents/Resources/candidate.json")), target.manifest, platform);
          const { exactRuntimeHealth } = require(path.join(current.packageRoot, "bootstrap/runtime-health.cjs"));
          const health = await exactRuntimeHealth(current);
          if (health.ok) {
            const heartbeat = read(path.join(relayRoot, "recovery/daemon.json"));
            if (!firstHeartbeat) firstHeartbeat = heartbeat.at;
            if (heartbeat.at > firstHeartbeat && Date.now() - heartbeat.at < 30_000) {
              const { applicationOwner } = require(path.join(current.packageRoot, "bootstrap/application-owner.cjs"));
              const owner = applicationOwner();
              assert.equal(owner?.installedPackagingSourceSha, inputs.sourceSha);
              assert.equal(owner?.root, destination);
              run("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
              proof.health = health;
              proof.bundledNodeSha256 = createHash("sha256").update(fs.readFileSync(path.join(destination, "Contents/Resources/node"))).digest("hex");
              assert.equal(proof.bundledNodeSha256, target.candidate.nodeSha256);
              assert.equal(createHash("sha256").update(fs.readFileSync(current.node)).digest("hex"), proof.bundledNodeSha256,
                "The active runtime must use the installer-owned Node bytes");
              record("relocated-stock-signed-app"); record("exact-active-runtime-and-complete-journal");
              record("native-ownership-and-live-services"); record("advancing-daemon-heartbeat");
              proof.ok = true; return proof;
            }
          }
        }
      }
      if (!clicked && Date.now() - openedAt > 90_000) throw Error(`Installer UI could not be driven: ${lastText || proof.lastObserverError || "No renderer available"}`);
      await sleep(1500);
    }
    throw Error(`Timed out at ${phase}. Last UI: ${lastText || "No installer renderer available"}`);
  } catch (error) {
    proof.failure = { phase, message: error.message };
    throw error;
  } finally {
    spawnSync("/usr/sbin/screencapture", ["-x", path.join(evidence, "desktop.png")], { timeout: 10_000 });
    fs.writeFileSync(path.join(evidence, "proof.json"), JSON.stringify(proof, null, 2));
    // Only named diagnostic files from this disposable, never-signed-in user.
    for (const [source, name] of [
      [path.join(os.homedir(), "Library/Logs/Relay/application-setup.log"), "setup.log"],
      [path.join(relayRoot, "application-migration.json"), "migration.json"],
    ]) if (fs.existsSync(source)) fs.copyFileSync(source, path.join(evidence, name));
    for (const mount of mounts.reverse()) spawnSync("/usr/bin/hdiutil", ["detach", mount], { timeout: 15_000 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ version: process.env.INSTALLER_VERSION, sourceSha: process.env.INSTALLER_SOURCE_SHA,
    baseline: process.env.BASELINE_VERSION, mode: process.env.INSTALLER_MODE })
    .then(proof => console.log(JSON.stringify(proof)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
