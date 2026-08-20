#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "relay-companion";
export const PUBLIC_REPOSITORY = "https://github.com/davidkariuki123/relay-companion";
export const PUBLIC_REGISTRY = "https://registry.npmjs.org";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const GITHUB_WORKFLOW_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const RELAY_DISTRIBUTIONS = new Set(["bridge-runtime", "thin-installer"]);

function exactVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid exact version: ${version || "missing"}`);
  return version;
}

function exactSourceSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid source commit SHA: ${sha || "missing"}`);
  return sha;
}

function repositoryUrl(value) {
  return String(typeof value === "string" ? value : value?.url || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

export function validatePublishedMetadata(metadata, { version, sourceSha } = {}) {
  const expectedVersion = exactVersion(version);
  const expectedSha = exactSourceSha(sourceSha);
  if (metadata?.name !== PACKAGE_NAME) throw new Error(`Registry package name is not ${PACKAGE_NAME}`);
  if (metadata?.version !== expectedVersion) throw new Error(`Registry version does not equal ${expectedVersion}`);
  const gitHead = String(metadata?.gitHead || "").toLowerCase();
  if (gitHead && gitHead !== expectedSha) {
    throw new Error(`Published package gitHead does not equal ${expectedSha}`);
  }
  if (repositoryUrl(metadata?.repository) !== PUBLIC_REPOSITORY) {
    throw new Error(`Published package does not identify ${PUBLIC_REPOSITORY} as its source`);
  }
  if (!String(metadata?.dist?.tarball || "").startsWith(`${PUBLIC_REGISTRY}/`)) {
    throw new Error("Published tarball is not served by the public npm registry");
  }
  const integrity = String(metadata?.dist?.integrity || "");
  if (!integrity.startsWith("sha512-")) throw new Error("Published package has no sha512 integrity digest");
  const provenance = metadata?.dist?.attestations?.provenance;
  if (provenance?.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error("Published package has no npm SLSA provenance attestation");
  }
  const attestationUrl = String(metadata?.dist?.attestations?.url || "");
  if (!attestationUrl.startsWith(`${PUBLIC_REGISTRY}/-/npm/v1/attestations/`)) {
    throw new Error("Published package has no public npm attestation endpoint");
  }
  const distribution = String(metadata?.relayDistribution || "");
  if (!RELAY_DISTRIBUTIONS.has(distribution)) throw new Error("Published package has no recognized Relay distribution shape");
  return { integrity, tarball: metadata.dist.tarball, attestationUrl, distribution, expectedVersion, expectedSha };
}

export function validatePublicSourcePackage(sourcePackage) {
  if (sourcePackage?.name !== PACKAGE_NAME) throw new Error("Public source package name does not match");
  if (repositoryUrl(sourcePackage?.repository) !== PUBLIC_REPOSITORY) {
    throw new Error("Public source package repository metadata does not match");
  }
  if (sourcePackage?.scripts?.preinstall || sourcePackage?.scripts?.install || sourcePackage?.scripts?.postinstall) {
    throw new Error("Public source package executes an npm install lifecycle");
  }
  if (sourcePackage?.publishConfig?.provenance !== true || sourcePackage?.publishConfig?.access !== "public") {
    throw new Error("Public source package is not configured for public provenance publishing");
  }
  return true;
}

function strictBase64(value, label) {
  const encoded = String(value || "");
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function integritySha512Hex(integrity) {
  const [algorithm, encoded] = String(integrity || "").split("-", 2);
  if (algorithm !== "sha512") throw new Error("Unsupported package integrity digest");
  const bytes = strictBase64(encoded, "Package integrity");
  if (bytes.length !== 64) throw new Error("Package integrity is not SHA-512");
  return bytes.toString("hex");
}

/**
 * npm itself verifies the Sigstore certificate, DSSE signature, and Rekor
 * inclusion proof. This policy check then binds that verified statement to the
 * exact Relay package, public workflow, and public source commit we selected.
 */
export function validateNpmAuditResult(audit, { version, sourceSha, integrity } = {}) {
  const expectedVersion = exactVersion(version);
  const expectedSha = exactSourceSha(sourceSha);
  if (!Array.isArray(audit?.invalid) || audit.invalid.length) throw new Error("npm found an invalid registry signature or attestation");
  if (!Array.isArray(audit?.missing) || audit.missing.length) throw new Error("npm found a missing registry signature or attestation");
  const verified = Array.isArray(audit?.verified) ? audit.verified : [];
  const item = verified.find((entry) => entry?.name === PACKAGE_NAME && entry?.version === expectedVersion);
  if (!item) throw new Error("npm did not cryptographically verify the exact Relay package");
  if (item?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error("npm did not verify Relay's SLSA provenance attestation");
  }
  const provenance = item.attestationBundles?.find((entry) => entry?.predicateType === SLSA_PROVENANCE_V1);
  const envelope = provenance?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json") {
    throw new Error("Relay provenance has an unexpected DSSE payload type");
  }
  const statement = JSON.parse(strictBase64(envelope.payload, "Relay provenance payload").toString("utf8"));
  if (statement?._type !== "https://in-toto.io/Statement/v1" || statement?.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error("Relay provenance statement is not SLSA v1");
  }
  const expectedSubject = `pkg:npm/${PACKAGE_NAME}@${expectedVersion}`;
  const expectedDigest = integritySha512Hex(integrity);
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  if (subjects.length !== 1 || subjects[0]?.name !== expectedSubject || subjects[0]?.digest?.sha512 !== expectedDigest) {
    throw new Error("Relay provenance subject does not match the exact npm tarball");
  }
  const build = statement?.predicate?.buildDefinition;
  const workflow = build?.externalParameters?.workflow;
  if (
    build?.buildType !== GITHUB_WORKFLOW_BUILD_TYPE ||
    repositoryUrl(workflow?.repository) !== PUBLIC_REPOSITORY ||
    workflow?.path !== RELEASE_WORKFLOW_PATH
  ) {
    throw new Error("Relay provenance does not identify the protected public release workflow");
  }
  const dependency = build?.resolvedDependencies?.find((entry) =>
    repositoryUrl(String(entry?.uri || "").replace(/^git\+/, "").split("@")[0]) === PUBLIC_REPOSITORY
  );
  if (String(dependency?.digest?.gitCommit || "").toLowerCase() !== expectedSha) {
    throw new Error("Relay provenance does not bind the selected public source commit");
  }
  if (statement?.predicate?.runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted") {
    throw new Error("Relay provenance was not produced by a GitHub-hosted runner");
  }
  return statement;
}

export function validateInstalledPackageShape(packageRoot, { version, distribution } = {}) {
  const exact = exactVersion(version);
  if (!RELAY_DISTRIBUTIONS.has(distribution)) throw new Error("Unknown Relay distribution shape");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== exact || packageJson.relayDistribution !== distribution) {
    throw new Error("Installed package identity does not match the selected Relay release");
  }
  validatePublicSourcePackage(packageJson);
  const scripts = packageJson.scripts || {};
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (scripts[lifecycle]) throw new Error(`Installed package defines forbidden ${lifecycle}`);
  }
  if (distribution === "thin-installer") {
    if (packageJson.bin?.relay !== "bootstrap/relay-setup.cjs" || Object.keys(packageJson.dependencies || {}).length) {
      throw new Error("Thin installer is not dependency-free first contact");
    }
    const topLevel = fs.readdirSync(packageRoot).filter((name) => !/^(?:readme|license)(?:\..*)?$/i.test(name)).sort();
    if (JSON.stringify(topLevel) !== JSON.stringify(["bootstrap", "package.json"])) {
      throw new Error("Thin installer contains files outside the reviewed bootstrap");
    }
    const bootstrapFiles = fs.readdirSync(path.join(packageRoot, "bootstrap")).sort();
    if (JSON.stringify(bootstrapFiles) !== JSON.stringify([
      "relay-setup.cjs",
      "release-signature.cjs",
      "runtime-health.cjs",
      "trust.json",
    ])) {
      throw new Error("Thin installer bootstrap contents do not match the reviewed shape");
    }
  } else {
    if (packageJson.bin?.relay !== "bin/relay.js" || !Object.keys(packageJson.dependencies || {}).length) {
      throw new Error("Bridge runtime package shape is incomplete");
    }
    if (!fs.existsSync(path.join(packageRoot, "npm-shrinkwrap.json"))) {
      throw new Error("Bridge runtime does not ship its exact dependency lock");
    }
  }
  return packageJson;
}

export function verifyTarballIntegrity(bytes, integrity) {
  const [algorithm, expected] = String(integrity || "").split("-", 2);
  if (algorithm !== "sha512" || !expected) throw new Error("Unsupported package integrity digest");
  const actual = crypto.createHash("sha512").update(bytes).digest("base64");
  if (actual !== expected) throw new Error("Public npm tarball does not match its integrity digest");
  return true;
}

async function checkedFetch(fetchImpl, url, label) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

export function npmInvocation(args, { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform === "win32") {
    return { command: comspec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  }
  return { command: "npm", args };
}

function runNpm(args, { cwd } = {}) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "npm command failed").slice(0, 4000);
    throw new Error(`npm ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

export function verifyWithNpmCli({ version, sourceSha, integrity, distribution } = {}) {
  const exact = exactVersion(version);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-release-audit-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
      name: "relay-release-audit",
      version: "1.0.0",
      private: true,
      dependencies: { [PACKAGE_NAME]: exact },
    })}\n`);
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true"], { cwd: root });
    const audit = JSON.parse(runNpm(["audit", "signatures", "--json", "--include-attestations"], { cwd: root }));
    validateNpmAuditResult(audit, { version: exact, sourceSha, integrity });
    validateInstalledPackageShape(path.join(root, "node_modules", PACKAGE_NAME), { version: exact, distribution });
    return true;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function verifyPublishedRelease({
  version,
  sourceSha,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const expectedVersion = exactVersion(version);
  const expectedSha = exactSourceSha(sourceSha);
  const metadataResponse = await checkedFetch(
    fetchImpl,
    `${PUBLIC_REGISTRY}/${PACKAGE_NAME}/${expectedVersion}`,
    "npm release metadata",
  );
  const metadata = await metadataResponse.json();
  const release = validatePublishedMetadata(metadata, { version: expectedVersion, sourceSha: expectedSha });

  const sourceResponse = await checkedFetch(
    fetchImpl,
    `https://raw.githubusercontent.com/davidkariuki123/relay-companion/${expectedSha}/package.json`,
    "public source",
  );
  validatePublicSourcePackage(await sourceResponse.json());

  const tarballResponse = await checkedFetch(fetchImpl, release.tarball, "npm tarball");
  verifyTarballIntegrity(Buffer.from(await tarballResponse.arrayBuffer()), release.integrity);
  return { ok: true, version: expectedVersion, sourceSha: expectedSha, ...release };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const result = await verifyPublishedRelease({ version: option("--version"), sourceSha: option("--source-sha") });
  verifyWithNpmCli(result);
  console.log(`Verified public source, provenance, and integrity for ${PACKAGE_NAME}@${result.version} (${result.sourceSha}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
