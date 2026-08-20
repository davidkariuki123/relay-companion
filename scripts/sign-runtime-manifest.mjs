#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

export const RELEASE_ALGORITHM = "ED25519_SHA_512";
export const KMS_RAW_MESSAGE_MAX_BYTES = 4096;

export function runtimeManifestPayload({ fragments } = {}) {
  if (!fragments?.length) throw new Error("At least one runtime artifact is required");
  const [{ version, sourceSha }] = fragments;
  const required = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
  const present = new Set(fragments.map((fragment) => fragment.platform));
  const missing = required.filter((platform) => !present.has(platform));
  if (missing.length) throw new Error(`Runtime manifest is missing verified platform artifacts: ${missing.join(", ")}`);
  if (fragments.some((fragment) => fragment.version !== version || fragment.sourceSha !== sourceSha)) {
    throw new Error("Runtime artifact fragments do not identify one exact release");
  }
  const dependencyLocks = new Set(fragments.map((fragment) => fragment.dependencyLockSha512));
  if (
    dependencyLocks.size !== 1 ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(String(fragments[0].dependencyLockSha512 || ""))
  ) {
    throw new Error("Runtime artifacts were not built from one committed dependency lock");
  }
  const artifacts = {};
  for (const fragment of [...fragments].sort((left, right) => left.platform.localeCompare(right.platform))) {
    artifacts[fragment.platform] = {
      url: `https://api.sendrelays.com/v1/companion-releases/v${version}/${fragment.filename}`,
      bytes: fragment.bytes,
      sha512: fragment.sha512,
      dependencyLockSha512: fragment.dependencyLockSha512,
      sbom: {
        url: `https://api.sendrelays.com/v1/companion-releases/v${version}/${fragment.sbom.filename}`,
        bytes: fragment.sbom.bytes,
        sha512: fragment.sbom.sha512,
      },
    };
  }
  const payload = Buffer.from(JSON.stringify({ schema: 1, product: "Relay", version, sourceSha, artifacts }));
  if (payload.length > KMS_RAW_MESSAGE_MAX_BYTES) {
    throw new Error(`Runtime manifest payload exceeds the ${KMS_RAW_MESSAGE_MAX_BYTES}-byte KMS RAW signing limit`);
  }
  return payload;
}

export function signedManifestEnvelope({ payload, signature, keyId, algorithm = RELEASE_ALGORITHM } = {}) {
  if (!Buffer.isBuffer(payload) || !payload.length || !Buffer.isBuffer(signature) || signature.length !== 64) {
    throw new Error("Exact payload bytes and a 64-byte Ed25519 signature are required");
  }
  if (!/^relay-runtime-release-v\d+$/.test(String(keyId || "")) || algorithm !== RELEASE_ALGORITHM) {
    throw new Error("A known logical release key id and ED25519_SHA_512 are required");
  }
  return {
    schema: 1,
    algorithm,
    keyId,
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
  };
}

export function readRuntimeFragments(fragmentsDir) {
  return fs.readdirSync(fragmentsDir)
    // Only the four fragment documents are inputs. SBOM filenames also contain
    // a platform and end in .json; accepting a broad glob made their completely
    // different shape look like a fifth runtime artifact.
    .filter((name) => /^(?:darwin-arm64|darwin-x64|win32-arm64|win32-x64)\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(fragmentsDir, name), "utf8")));
}

function main() {
  const payloadOutput = option("--payload-output");
  if (payloadOutput) {
    const fragments = readRuntimeFragments(path.resolve(option("--fragments")));
    fs.writeFileSync(path.resolve(payloadOutput), runtimeManifestPayload({ fragments }), { mode: 0o600 });
    return;
  }
  const payload = fs.readFileSync(path.resolve(option("--payload")));
  const signature = fs.readFileSync(path.resolve(option("--signature")));
  const manifest = signedManifestEnvelope({ payload, signature, keyId: option("--key-id") });
  fs.writeFileSync(path.resolve(option("--output")), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
