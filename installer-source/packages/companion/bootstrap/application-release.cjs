"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { verifyReleaseEnvelope } = require("./release-signature.cjs");
const trust = require("./trust.json");
const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"];
const CHANNEL_ORIGINS = Object.freeze({ stable: "https://api.sendrelays.com", dev: "https://dev-api.sendrelays.com" });
function applicationReleaseBase(channel = "stable") {
  if (!CHANNEL_ORIGINS[channel]) throw new Error("Unsupported native release channel");
  return `${CHANNEL_ORIGINS[channel]}/v1/application-releases${channel === "stable" ? "" : `/${channel}`}`;
}

function applicationManifestUrl(channel = "stable") {
  return `${applicationReleaseBase(channel)}/${channel === "stable" ? "stable-v3/" : ""}manifest.json`;
}

function validateApplicationRelease(payload, { version, sourceSha, channel } = {}) {
  if (![1, 2].includes(payload?.schema) || payload.product !== "Relay Application" || payload.version !== version
    || payload.sourceSha !== sourceSha || !/^\d+\.\d+\.\d+$/.test(version || "") || !/^[a-f0-9]{40}$/.test(sourceSha || "")
    || !/^\d+\.\d+\.\d+$/.test(payload.runtime?.version || "") || !/^[a-f0-9]{40}$/.test(payload.runtime?.sourceSha || "")) {
    throw new Error("Application release identity mismatch");
  }
  const releaseChannel = payload.schema === 1 ? "stable" : payload.channel;
  const base = applicationReleaseBase(releaseChannel);
  if (channel && releaseChannel !== channel) throw new Error("Application release channel mismatch");
  const targets = payload.schema === 2 && releaseChannel === "dev" ? Object.keys(payload.artifacts || {}) : PLATFORMS;
  if (!targets.length || Object.keys(payload.artifacts || {}).some(key => !PLATFORMS.includes(key))) throw new Error("Invalid native platform selection");
  if (payload.schema === 2) {
    const policy = payload.rollout;
    if (!policy || typeof policy.nativeUpdates !== "boolean" || !Array.isArray(policy.migrateDeviceIds)
      || policy.migrateDeviceIds.length > 50 || policy.migrateDeviceIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(id))
      || !Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= 0) throw new Error("Invalid native rollout policy");
  }
  for (const platform of targets) {
    const artifacts = payload.artifacts?.[platform];
    const required = platform.startsWith("darwin") ? ["dmg", "zip"] : platform.startsWith("win32") ? ["exe"] : ["deb", "rpm"];
    if (!Array.isArray(artifacts) || artifacts.length !== required.length) throw new Error(`Incomplete native release: ${platform}`);
    const seen = new Set();
    for (const artifact of artifacts) {
      if (!required.includes(artifact.kind) || seen.has(artifact.kind) || !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes <= 0 || artifact.bytes > 4 * 1024 ** 3
        || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.sha512 || "")) throw new Error("Invalid application artifact");
      const url = new URL(artifact.url);
      if (url.origin !== CHANNEL_ORIGINS[releaseChannel] || url.username || url.password || url.search || url.hash
        || artifact.url !== `${base}/v${version}/Relay-${version}-${platform}.${artifact.kind}`
        || url.pathname.includes("%")) throw new Error("Application artifacts require immutable branded URLs");
      seen.add(artifact.kind);
    }
  }
  return payload;
}

function verifyApplicationRelease(envelope, { trustStore = trust, ...identity } = {}) {
  return validateApplicationRelease(JSON.parse(verifyReleaseEnvelope(envelope, trustStore).toString("utf8")), identity);
}

async function verifyApplicationArtifact(file, artifact) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes) throw new Error("Application artifact size mismatch");
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (`sha512-${hash.digest("base64")}` !== artifact.sha512) throw new Error("Application artifact digest mismatch");
  return true;
}

module.exports = { PLATFORMS, CHANNEL_ORIGINS, applicationReleaseBase, applicationManifestUrl, validateApplicationRelease, verifyApplicationRelease, verifyApplicationArtifact };
