"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { verifyReleaseEnvelope } = require("./release-signature.cjs");
const trust = require("./trust.json");
const release = require("./application-release.cjs");
const { applicationOwner } = require("./application-owner.cjs");
const { handoffApplication, updateConsent, read, write } = require("./application-handoff.cjs");
const { versionCompare } = require("./application-install.cjs");
const bootstrap = require("./relay-setup.cjs");
const rollout = require("./application-rollout.cjs");
const CHECK_MS = 6 * 60 * 60_000;

async function readOffer({ fetchImpl = globalThis.fetch, trustStore = trust, channel = "stable" } = {}) {
  const response = await fetchImpl(release.applicationManifestUrl(channel), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "Cache-Control": "no-cache" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Native application offer unavailable (${response.status})`);
  let bytes = 0; const chunks = [];
  if (!response.body) throw new Error("Missing native release manifest");
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 64 * 1024) throw new Error("Native release manifest too large"); chunks.push(Buffer.from(chunk)); }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const payload = JSON.parse(verifyReleaseEnvelope(envelope, trustStore).toString("utf8"));
  release.validateApplicationRelease(payload, { version: payload.version, sourceSha: payload.sourceSha, channel });
  return { envelope, payload };
}

function rolloutDecision(payload, { owner, deviceId, now = Date.now() }) {
  const policy = payload.rollout;
  if (payload.schema !== 2 || !policy) return "rollout-policy-required";
  if (policy.expiresAt <= now || policy.expiresAt > now + 31 * 86400_000) return "rollout-policy-expired";
  if (owner) return policy.nativeUpdates ? null : "native-updates-paused";
  return deviceId && policy.migrateDeviceIds.includes(deviceId) ? null : "migration-not-selected";
}

async function checkApplicationUpdate({ activationEnabled = rollout.enabled, homeDir = os.homedir(), platform = process.platform,
  arch = process.arch, env = process.env, now = Date.now, fetchImpl = globalThis.fetch, trustStore = trust,
  download = bootstrap.downloadVerifiedArtifact, handoff = handoffApplication } = {}) {
  if (activationEnabled !== true) return { state: "disabled", changed: false };
  const root = path.join(homeDir, ".relay"), statusFile = path.join(root, "application-update.json");
  const consent = updateConsent({ homeDir, env });
  if (!consent.ok) return { state: consent.reason, changed: false };
  const previous = read(statusFile);
  if (previous?.nextCheckAt > now() && previous.nextCheckAt - now() <= CHECK_MS) return { state: "backoff", changed: false };
  // A disabled/unhealthy legacy installation is not enrolled by a background check.
  const current = read(path.join(root, "runtime", "current.json"));
  if (!current?.active || current.state !== "active" || !/^\d+\.\d+\.\d+$/.test(current.version || "")) return { state: "existing-runtime-needs-repair", changed: false };
  const checkLock = bootstrap.acquireCanonicalLock(path.join(root, "application-update.lock"));
  try {
    const offer = await readOffer({ fetchImpl, trustStore, channel: consent.channel });
    if (!offer) {
      const result = { schema: 1, at: now(), nextCheckAt: now() + CHECK_MS, state: "no-offer", changed: false };
      write(statusFile, result); return result;
    }
    const { envelope, payload } = offer;
    const owner = applicationOwner({ homeDir, platform });
    const denied = rolloutDecision(payload, { owner, deviceId: consent.deviceId, now: now() });
    if (denied) {
      const result = { schema: 1, at: now(), nextCheckAt: now() + CHECK_MS, state: denied, version: payload.version, sourceSha: payload.sourceSha, changed: false };
      write(statusFile, result); return result;
    }
    if (owner?.installedPackageVersion === payload.version && owner.installedPackagingSourceSha !== payload.sourceSha) throw new Error("An application version cannot change its source identity");
    let result;
    if (owner && (versionCompare(owner.installedPackageVersion, payload.version) > 0
      || ((owner.applicationVersion || owner.version) === payload.version && owner.packagingSourceSha === payload.sourceSha))) result = { state: "current", changed: false };
    else if (versionCompare(current.version, payload.runtime.version) > 0) result = { state: "older-runtime-refused", changed: false };
    else {
      const platformKey = `${platform}-${arch}`;
      const kind = platform === "darwin" ? "zip" : platform === "win32" ? "exe"
        : fs.existsSync("/usr/bin/dpkg") ? "deb" : "rpm";
      const artifact = payload.artifacts[platformKey]?.find(item => item.kind === kind);
      if (!artifact) throw new Error("No native package for this host");
      const directory = path.join(root, "application-packages", `${payload.version}-${payload.sourceSha}-${platformKey}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `installer.${kind}`);
      if (!fs.existsSync(file)) await download(artifact.url, file, artifact);
      await release.verifyApplicationArtifact(file, artifact);
      // Recheck the live signed policy after a potentially slow download. A
      // withdrawn offer must not start a new transaction from a cached plan.
      const latest = await readOffer({ fetchImpl, trustStore, channel: consent.channel });
      if (!latest || latest.payload.version !== payload.version || latest.payload.sourceSha !== payload.sourceSha
        || rolloutDecision(latest.payload, { owner, deviceId: consent.deviceId, now: now() })) return { state: "offer-withdrawn", changed: false };
      write(path.join(directory, "manifest.json"), envelope);
      write(statusFile, { schema: 1, at: now(), state: "installing", version: payload.version, sourceSha: payload.sourceSha });
      result = await handoff({ activationEnabled: true, envelope, version: payload.version, sourceSha: payload.sourceSha,
        homeDir, platform, arch, env, file, trustStore });
      const action = read(path.join(directory, "action.json"));
      if (action?.state === "installer-action-required" && result.state !== "complete") result = { ...action, bridgeState: result.state };
    }
    write(statusFile, { schema: 1, at: now(), nextCheckAt: now() + CHECK_MS,
      version: payload.version, sourceSha: payload.sourceSha, ...result });
    return result;
  } catch (error) {
    write(statusFile, { schema: 1, at: now(), nextCheckAt: now() + 5 * 60_000, state: "failed", detail: String(error.message).slice(0, 500) });
    throw error;
  } finally { checkLock.release(); }
}
module.exports = { checkApplicationUpdate, readOffer, rolloutDecision, CHECK_MS };
if (require.main === module) checkApplicationUpdate().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
