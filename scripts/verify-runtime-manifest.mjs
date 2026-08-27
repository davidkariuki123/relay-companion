#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const RELEASE_BASE = "https://api.sendrelays.com/v1/companion-releases";
const REQUIRED_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
  "linux-arm64",
  "linux-x64",
];
const require = createRequire(import.meta.url);
const defaultTrust = require("../bootstrap/trust.json");
const { RELEASE_ALGORITHM, verifyReleaseEnvelope } = require("../bootstrap/release-signature.cjs");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

export function verifyRuntimeManifestEnvelope(envelope, { version, sourceSha, publicKeyPem, trustStore = defaultTrust } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "") || !/^[0-9a-f]{40}$/i.test(sourceSha || "")) {
    throw new Error("Exact version and source SHA are required");
  }
  if (publicKeyPem) {
    trustStore = {
      schema: 2,
      activeKeyId: envelope?.keyId,
      keys: [{ keyId: envelope?.keyId, algorithm: RELEASE_ALGORITHM, publicKeyPem }],
    };
  }
  const payloadBytes = verifyReleaseEnvelope(envelope, trustStore);
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  if (payload.product !== "Relay" || payload.version !== version || payload.sourceSha !== sourceSha.toLowerCase()) {
    throw new Error("Runtime manifest release identity does not match");
  }
  const dependencyLocks = new Set();
  for (const platform of REQUIRED_PLATFORMS) {
    const artifact = payload.artifacts?.[platform];
    if (!artifact || !Number.isSafeInteger(artifact.bytes) || !/^sha512-/.test(artifact.sha512 || "")) {
      throw new Error(`Runtime manifest is missing ${platform}`);
    }
    const expected = `${RELEASE_BASE}/v${version}/relay-runtime-${version}-${platform}.tar.gz`;
    if (artifact.url !== expected) throw new Error(`Runtime manifest has an unexpected ${platform} URL`);
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(String(artifact.dependencyLockSha512 || ""))) {
      throw new Error(`Runtime manifest does not bind ${platform} to a dependency lock`);
    }
    dependencyLocks.add(artifact.dependencyLockSha512);
    const expectedSbom = `${RELEASE_BASE}/v${version}/relay-runtime-${version}-${platform}.sbom.cdx.json`;
    if (artifact.sbom?.url !== expectedSbom || !Number.isSafeInteger(artifact.sbom?.bytes) || !/^sha512-/.test(artifact.sbom?.sha512 || "")) {
      throw new Error(`Runtime manifest has no signed source-bound ${platform} SBOM`);
    }
  }
  if (dependencyLocks.size !== 1) throw new Error("Runtime platforms were built from different dependency locks");
  return payload;
}

export async function verifyRuntimeManifest({ version, sourceSha, publicKeyPem, trustStore, fetchImpl = globalThis.fetch } = {}) {
  const url = `${RELEASE_BASE}/v${version}/manifest.json`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Runtime manifest returned HTTP ${response.status}`);
  return verifyRuntimeManifestEnvelope(await response.json(), { version, sourceSha, publicKeyPem, trustStore });
}

export async function verifyRuntimeArtifactFile(file, artifact) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== artifact.bytes) throw new Error("Runtime artifact file size does not match signed manifest");
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const actual = `sha512-${hash.digest("base64")}`;
  if (actual.length !== artifact.sha512.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(artifact.sha512))) {
    throw new Error("Runtime artifact file digest does not match signed manifest");
  }
  return true;
}

async function main() {
  const version = option("--version");
  const sourceSha = option("--source-sha");
  const payload = await verifyRuntimeManifest({ version, sourceSha });
  const artifactPath = option("--artifact");
  const platform = option("--platform");
  if (artifactPath || platform) {
    if (!artifactPath || !payload.artifacts?.[platform]) throw new Error("--artifact and a signed --platform are required together");
    await verifyRuntimeArtifactFile(artifactPath, payload.artifacts[platform]);
  }
  console.log(`Verified signed runtime manifest for Relay ${version} (${sourceSha}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
