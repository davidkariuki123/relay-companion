#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { ensureCandidateElectronRuntime, verifyCanonicalCandidate } from "../src/canonical-runtime.js";

export function electronVersionArgs(platform = process.platform) {
  // This process only prints Electron's embedded version and exits. Runtime
  // archives deliberately preserve ordinary file ownership, so the temporary
  // Linux smoke tree cannot satisfy Chromium's root-owned setuid helper check.
  // Relay's real desktop launch does not use this flag.
  return platform === "linux" ? ["--no-sandbox", "--version"] : ["--version"];
}

export async function verifyInstalledRuntime({ packageRoot, version, platform = process.platform } = {}) {
  const root = path.resolve(String(packageRoot || ""));
  const expectedVersion = String(version || "").trim();
  if (!root || !fs.existsSync(root)) throw new Error(`Installed package root is missing: ${root}`);
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error(`Invalid exact version: ${expectedVersion || "missing"}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest?.scripts?.install || manifest?.scripts?.postinstall) {
    throw new Error("Installed Relay package executes an npm install lifecycle");
  }
  const prepared = ensureCandidateElectronRuntime(root, { platform });
  if (!prepared.ok) throw new Error(`Electron runtime preparation failed: ${prepared.reason}`);
  const verified = verifyCanonicalCandidate(root, expectedVersion, { platform });
  if (!verified.ok) throw new Error(`Runtime verification failed: ${verified.reason}${verified.detail ? ` (${verified.detail})` : ""}`);
  const expectedElectron = String(manifest.dependencies?.electron || "");
  if (!/^\d+\.\d+\.\d+$/.test(expectedElectron)) throw new Error("Runtime does not pin one exact Electron version");
  const launched = spawnSync(verified.electronPath, electronVersionArgs(platform), {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const launchedVersion = String(launched.stdout || launched.stderr || "").trim().replace(/^v/, "");
  if (launched.error || launched.status !== 0 || launchedVersion !== expectedElectron) {
    throw new Error(`Pinned Electron launch failed (${launched.error?.message || launchedVersion || launched.status}).`);
  }

  const bootstrapTrust = JSON.parse(fs.readFileSync(path.join(root, "bootstrap", "trust.json"), "utf8"));
  const runtimeTrust = JSON.parse(fs.readFileSync(path.join(root, "src", "release-trust.json"), "utf8"));
  if (
    bootstrapTrust.schema !== 2 ||
    JSON.stringify(bootstrapTrust) !== JSON.stringify(runtimeTrust) ||
    !bootstrapTrust.activeKeyId ||
    !Array.isArray(bootstrapTrust.keys) ||
    !bootstrapTrust.keys.length
  ) {
    throw new Error("Runtime release trust root is missing or inconsistent");
  }
  for (const entry of bootstrapTrust.keys) {
    if (entry.algorithm !== "ED25519_SHA_512" || crypto.createPublicKey(entry.publicKeyPem).asymmetricKeyType !== "ed25519") {
      throw new Error("Runtime release trust root is not Ed25519");
    }
  }

  // Import from the BUILT tree. This catches files omitted from npm `files` or
  // artifact construction (notably bootstrap/relay-setup.cjs), rather than
  // accidentally proving the checkout beside this verifier can import itself.
  const updater = await import(`${pathToFileURL(path.join(root, "src", "canonical-updater.js")).href}?verify=${Date.now()}`);
  if (typeof updater.installSignedRuntimeCandidate !== "function") {
    throw new Error("Built runtime cannot load its signed canonical updater");
  }

  // Exercise the built bootstrap's signature path with a generated fixture.
  // Pinned-key identity is checked above; an ephemeral private key lets this
  // public CI job prove the shipped parser actually enforces Ed25519 without
  // exposing Relay's release private key to platform build runners.
  const requireFromRuntime = createRequire(pathToFileURL(path.join(root, "package.json")));
  const builtBootstrap = requireFromRuntime(path.join(root, "bootstrap", "relay-setup.cjs"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const platformKey = `${platform}-${process.arch}`;
  const artifact = {
    url: `https://api.sendrelays.com/v1/companion-releases/v${expectedVersion}/relay-runtime-${expectedVersion}-${platformKey}.tar.gz`,
    bytes: 1,
    sha512: `sha512-${Buffer.alloc(64).toString("base64")}`,
    dependencyLockSha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  };
  const payloadBytes = Buffer.from(JSON.stringify({
    schema: 1,
    product: "Relay",
    version: expectedVersion,
    sourceSha: "a".repeat(40),
    artifacts: { [platformKey]: artifact },
  }));
  const fixture = Buffer.from(JSON.stringify({
    schema: 1,
    algorithm: "ED25519_SHA_512",
    keyId: "relay-runtime-release-v2",
    payload: payloadBytes.toString("base64"),
    signature: crypto.sign(null, payloadBytes, privateKey).toString("base64"),
  }));
  const parsed = builtBootstrap.parseSignedManifest(fixture, {
    version: expectedVersion,
    platformKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  if (parsed.artifact.url !== artifact.url) throw new Error("Built runtime rejected its signed release fixture");
  return verified;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const verified = await verifyInstalledRuntime({ packageRoot: option("--package-root"), version: option("--version") });
  console.log(`Verified Relay ${verified.version} runtime at ${verified.packageRoot}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
