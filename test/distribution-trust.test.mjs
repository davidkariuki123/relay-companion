import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { exactCompanionSpec, npmInstallArgs } from "../src/install.js";
import {
  PUBLIC_REGISTRY,
  SLSA_PROVENANCE_V1,
  validateInstalledPackageShape,
  validateNpmAuditResult,
  npmInvocation,
  validatePublicSourcePackage,
  validatePublishedMetadata,
  verifyTarballIntegrity,
} from "../scripts/verify-published-release.mjs";
import {
  readRuntimeFragments,
  runtimeManifestPayload,
  signedManifestEnvelope,
} from "../scripts/sign-runtime-manifest.mjs";
import { verifyRuntimeManifestEnvelope } from "../scripts/verify-runtime-manifest.mjs";
import {
  captureInternalLinks,
  createDeterministicArchive,
  deterministicSbomSerial,
  npmRuntimeInvocation,
} from "../scripts/build-runtime-artifact.mjs";
import { bridgeShrinkwrap, publishPackageJson } from "../scripts/prepare-publish-package.mjs";
import { assertMonotonicVersion, compareExactVersions } from "../scripts/assert-monotonic-version.mjs";

const {
  activateRuntime,
  acquireCanonicalLock,
  assertCompatibleNode,
  restoreRuntimeLinks,
  stageVerifiedRuntime,
  tarInvocation,
  validateArchiveEntries,
} = createRequire(import.meta.url)("../bootstrap/relay-setup.cjs");
const credentialStore = createRequire(import.meta.url)("../src/credential-store.cjs");

const version = "1.2.3";
const sourceSha = "a".repeat(40);

test("release channels are monotonic and rollback is a higher roll-forward version", () => {
  assert.equal(compareExactVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactVersions("1.2.3", "1.2.3"), 0);
  assert.equal(assertMonotonicVersion("1.2.4", "1.2.3", "npm installer"), true);
  assert.equal(assertMonotonicVersion("1.2.4", "", "new channel"), true);
  assert.throws(() => assertMonotonicVersion("1.2.2", "1.2.3", "npm installer"), /cannot move backward/);
});

test("npm provenance audit uses an executable command shape on Windows and Unix", () => {
  assert.deepEqual(npmInvocation(["audit", "signatures"], { platform: "linux" }), {
    command: "npm",
    args: ["audit", "signatures"],
  });
  assert.deepEqual(npmInvocation(["audit", "signatures"], { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "audit", "signatures"],
  });
});

test("runtime builds invoke npm through an executable Node or shell entrypoint", () => {
  assert.deepEqual(npmRuntimeInvocation(["ci"], {
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    execPath: "/opt/node/bin/node",
    existsSync: () => true,
  }), {
    command: "/opt/node/bin/node",
    args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", "ci"],
  });
  assert.deepEqual(npmRuntimeInvocation(["ci"], {
    platform: "win32",
    npmExecPath: "",
    comspec: "C:\\Windows\\System32\\cmd.exe",
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "ci"],
  });
});

test("first contact persists the exact reviewed version without lifecycle scripts", () => {
  assert.equal(exactCompanionSpec(version), "relay-companion@1.2.3");
  assert.throws(() => exactCompanionSpec("latest"), /exact published version/);
  const args = npmInstallArgs({ version, global: true });
  assert.deepEqual(args, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "-g", "relay-companion@1.2.3"]);
  assert.equal(args.some((entry) => entry.includes("latest")), false);
});

test("bootstrap fails before download on incompatible Node instead of switching runtimes", () => {
  assert.equal(assertCompatibleNode("22.12.0"), true);
  assert.equal(assertCompatibleNode("23.0.0"), true);
  assert.throws(() => assertCompatibleNode("22.11.9"), /requires Node\.js 22\.12 or newer/);
  assert.throws(() => assertCompatibleNode("20.19.0"), /will not switch runtimes automatically/);
});

test("published release identity requires public source, integrity, and npm provenance", () => {
  const bytes = Buffer.from("relay tarball fixture");
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const metadata = {
    name: "relay-companion",
    version,
    relayDistribution: "thin-installer",
    gitHead: sourceSha,
    repository: { url: "git+https://github.com/davidkariuki123/relay-companion.git" },
    dist: {
      tarball: `${PUBLIC_REGISTRY}/relay-companion/-/relay-companion-1.2.3.tgz`,
      integrity,
      attestations: {
        url: `${PUBLIC_REGISTRY}/-/npm/v1/attestations/relay-companion@1.2.3`,
        provenance: { predicateType: SLSA_PROVENANCE_V1 },
      },
    },
  };
  assert.equal(validatePublishedMetadata(metadata, { version, sourceSha }).integrity, integrity);
  assert.equal(verifyTarballIntegrity(bytes, integrity), true);
  assert.throws(
    () => validatePublishedMetadata({ ...metadata, gitHead: "b".repeat(40) }, { version, sourceSha }),
    /gitHead/,
  );
});

test("public source manifest is script-free and provenance-enabled", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(validatePublicSourcePackage(packageJson), true);
  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.throws(() => validatePublicSourcePackage({ ...packageJson, scripts: { preinstall: "node nope.js" } }), /install lifecycle/);
  assert.equal(packageJson.publishConfig.provenance, true);
  assert.equal(packageJson.publishConfig.access, "public");
  if (packageJson.relayDistribution === "bridge-runtime") {
    const runtimeDependencies = JSON.parse(
      fs.readFileSync(new URL("../runtime-dependencies.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(packageJson.dependencies, runtimeDependencies);
    assert.equal(packageJson.bin.relay, "bin/relay.js");
    assert.equal(fs.existsSync(new URL("../npm-shrinkwrap.json", import.meta.url)), true);
  } else {
    assert.deepEqual(packageJson.dependencies, {});
    assert.equal(packageJson.bin.relay, "bootstrap/relay-setup.cjs");
  }
  assert.match(packageJson.description, /Claude Code, Cowork, and Codex/);
});

test("verified npm provenance is bound to exact public workflow, source, and tarball", () => {
  const digest = Buffer.alloc(64, 7);
  const integrity = `sha512-${digest.toString("base64")}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/relay-companion@${version}`, digest: { sha512: digest.toString("hex") } }],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/davidkariuki123/relay-companion",
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [{
          uri: "git+https://github.com/davidkariuki123/relay-companion@refs/heads/main",
          digest: { gitCommit: sourceSha },
        }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  const item = {
    name: "relay-companion",
    version,
    attestations: { provenance: { predicateType: SLSA_PROVENANCE_V1 } },
    attestationBundles: [{
      predicateType: SLSA_PROVENANCE_V1,
      bundle: {
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        },
      },
    }],
  };
  assert.deepEqual(validateNpmAuditResult({ invalid: [], missing: [], verified: [item] }, {
    version,
    sourceSha,
    integrity,
  }), statement);
  const wrongSource = structuredClone(item);
  const wrongStatement = structuredClone(statement);
  wrongStatement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
  wrongSource.attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(wrongStatement)).toString("base64");
  assert.throws(() => validateNpmAuditResult({ invalid: [], missing: [], verified: [wrongSource] }, {
    version,
    sourceSha,
    integrity,
  }), /selected public source commit/);
});

test("packed thin installer contains only the reviewed dependency-free bootstrap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-shape-"));
  try {
    fs.mkdirSync(path.join(root, "bootstrap"), { recursive: true });
    fs.writeFileSync(path.join(root, "bootstrap", "relay-setup.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "release-signature.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "runtime-health.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "trust.json"), "{}\n");
    fs.writeFileSync(path.join(root, "README.md"), "Relay\n");
    fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "relay-companion",
      version,
      relayDistribution: "thin-installer",
      repository: "https://github.com/davidkariuki123/relay-companion",
      publishConfig: { access: "public", provenance: true },
      scripts: {},
      dependencies: {},
      bin: { relay: "bootstrap/relay-setup.cjs" },
    }));
    assert.equal(validateInstalledPackageShape(root, { version, distribution: "thin-installer" }).version, version);
    fs.writeFileSync(path.join(root, "postinstall.js"), "throw new Error('must never ship')\n");
    assert.throws(() => validateInstalledPackageShape(root, { version, distribution: "thin-installer" }), /outside the reviewed bootstrap/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native runtime dependency graph is exact, integrity-locked, and reproducible", () => {
  const dependencies = JSON.parse(fs.readFileSync(new URL("../runtime-dependencies.json", import.meta.url), "utf8"));
  const lockedPackage = JSON.parse(fs.readFileSync(new URL("../runtime-lock/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(fs.readFileSync(new URL("../runtime-lock/package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lockedPackage.dependencies, dependencies);
  assert.deepEqual(lock.packages[""].dependencies, dependencies);
  for (const spec of Object.values(dependencies)) assert.match(spec, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (!location || metadata.link) continue;
    assert.match(metadata.version, /^\d+\.\d+\.\d+/, `${location} has an exact version`);
    assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\//, `${location} has an immutable source`);
    assert.match(metadata.integrity, /^sha512-/, `${location} has an integrity digest`);
  }
  const builder = fs.readFileSync(new URL("../scripts/build-runtime-artifact.mjs", import.meta.url), "utf8");
  assert.match(builder, /"ci", "--ignore-scripts"/);
  assert.doesNotMatch(builder, /--package-lock=false/);
});

test("release dependency locks retain identical bytes on every build platform", () => {
  const attributes = fs.readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
  for (const relative of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "runtime-dependencies.json",
    "runtime-lock/package.json",
    "runtime-lock/package-lock.json",
  ]) {
    assert.match(attributes, new RegExp(`${relative.replaceAll("/", "\\/")} text eol=lf`));
  }
});

test("the migration bridge publishes an exact npm shrinkwrap for its full graph", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = JSON.parse(fs.readFileSync(new URL("../runtime-dependencies.json", import.meta.url), "utf8"));
  const runtimeLock = JSON.parse(fs.readFileSync(new URL("../runtime-lock/package-lock.json", import.meta.url), "utf8"));
  const bridgePackage = publishPackageJson(packageJson, { mode: "bridge", version, runtimeDependencies: dependencies });
  const shrinkwrap = bridgeShrinkwrap(runtimeLock, { version, runtimeDependencies: dependencies });
  assert.equal(bridgePackage.relayDistribution, "bridge-runtime");
  assert.ok(bridgePackage.files.includes("npm-shrinkwrap.json"), "the packed bridge carries its transitive lock");
  assert.equal(shrinkwrap.name, bridgePackage.name);
  assert.equal(shrinkwrap.version, bridgePackage.version);
  assert.deepEqual(shrinkwrap.packages[""].dependencies, bridgePackage.dependencies);
  assert.ok(Object.keys(shrinkwrap.packages).length > 100, "the transitive graph is locked, not only direct dependencies");
  for (const [location, metadata] of Object.entries(shrinkwrap.packages)) {
    if (!location || metadata.link) continue;
    assert.match(metadata.integrity, /^sha512-/, `${location} is integrity locked`);
  }
});

test("runtime manifest signature binds all platform artifacts and SBOMs to one source", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const platforms = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
  const fragments = platforms.map((platform) => ({
    platform,
    version,
    sourceSha,
    filename: `relay-runtime-${version}-${platform}.tar.gz`,
    bytes: 123,
    sha512: `sha512-${Buffer.alloc(64).toString("base64")}`,
    dependencyLockSha512: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
    sbom: {
      filename: `relay-runtime-${version}-${platform}.sbom.cdx.json`,
      bytes: 456,
      sha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    },
  }));
  const payload = runtimeManifestPayload({ fragments });
  const envelope = signedManifestEnvelope({
    payload,
    signature: crypto.sign(null, payload, privateKey),
    keyId: "relay-runtime-release-v2",
  });
  const verifiedPayload = verifyRuntimeManifestEnvelope(envelope, {
    version,
    sourceSha,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.deepEqual(Object.keys(verifiedPayload.artifacts).sort(), platforms.sort());
  assert.throws(() => runtimeManifestPayload({ fragments: fragments.slice(1) }), /missing verified platform/);
});

test("runtime manifest payload fails closed above the KMS RAW signing limit", () => {
  const oversizedFilename = `relay-runtime-${"x".repeat(4096)}.tar.gz`;
  const fragments = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"].map((platform) => ({
    platform,
    version,
    sourceSha,
    filename: oversizedFilename,
    bytes: 1,
    sha512: `sha512-${Buffer.alloc(64).toString("base64")}`,
    dependencyLockSha512: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
    sbom: {
      filename: `relay-runtime-${version}-${platform}.sbom.cdx.json`,
      bytes: 1,
      sha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    },
  }));
  assert.throws(() => runtimeManifestPayload({ fragments }), /4096-byte KMS RAW signing limit/);
});

test("release keyring accepts current and overlap keys but rejects unknown ids and algorithms", () => {
  const current = crypto.generateKeyPairSync("ed25519");
  const previous = crypto.generateKeyPairSync("ed25519");
  const fragments = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"].map((platform) => ({
    platform,
    version,
    sourceSha,
    filename: `relay-runtime-${version}-${platform}.tar.gz`,
    bytes: 1,
    sha512: `sha512-${Buffer.alloc(64).toString("base64")}`,
    dependencyLockSha512: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
    sbom: {
      filename: `relay-runtime-${version}-${platform}.sbom.cdx.json`,
      bytes: 1,
      sha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    },
  }));
  const payload = runtimeManifestPayload({ fragments });
  const trustStore = {
    schema: 2,
    activeKeyId: "relay-runtime-release-v2",
    keys: [
      { keyId: "relay-runtime-release-v2", algorithm: "ED25519_SHA_512", publicKeyPem: current.publicKey.export({ type: "spki", format: "pem" }) },
      { keyId: "relay-runtime-release-v1", algorithm: "ED25519_SHA_512", publicKeyPem: previous.publicKey.export({ type: "spki", format: "pem" }) },
    ],
  };
  const envelope = (keyId, privateKey) => signedManifestEnvelope({
    payload,
    signature: crypto.sign(null, payload, privateKey),
    keyId,
  });
  assert.equal(verifyRuntimeManifestEnvelope(envelope("relay-runtime-release-v2", current.privateKey), { version, sourceSha, trustStore }).version, version);
  assert.equal(verifyRuntimeManifestEnvelope(envelope("relay-runtime-release-v1", previous.privateKey), { version, sourceSha, trustStore }).version, version);
  assert.throws(
    () => verifyRuntimeManifestEnvelope({ ...envelope("relay-runtime-release-v2", current.privateKey), keyId: "relay-runtime-release-v99" }, { version, sourceSha, trustStore }),
    /unknown key/,
  );
  assert.throws(
    () => verifyRuntimeManifestEnvelope({ ...envelope("relay-runtime-release-v2", current.privateKey), algorithm: "ED25519_PH_SHA_512" }, { version, sourceSha, trustStore }),
    /unsupported signed-envelope/,
  );
  assert.throws(
    () => verifyRuntimeManifestEnvelope({ ...envelope("relay-runtime-release-v2", current.privateKey), signature: "not-base64" }, { version, sourceSha, trustStore }),
    /malformed signed bytes/,
  );
  assert.throws(
    () => verifyRuntimeManifestEnvelope(envelope("relay-runtime-release-v2", current.privateKey), {
      version,
      sourceSha,
      trustStore: { ...trustStore, activeKeyId: "relay-runtime-release-v99" },
    }),
    /no active key/,
  );
  assert.throws(
    () => verifyRuntimeManifestEnvelope(envelope("relay-runtime-release-v2", current.privateKey), {
      version,
      sourceSha,
      trustStore: { ...trustStore, keys: [...trustStore.keys, trustStore.keys[0]] },
    }),
    /keyring is invalid/,
  );
});

test("manifest assembly reads platform fragments but never ingests SBOM JSON as an artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-fragments-"));
  try {
    for (const platform of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
      fs.writeFileSync(path.join(root, `${platform}.json`), JSON.stringify({ platform }));
      fs.writeFileSync(path.join(root, `relay-runtime-${version}-${platform}.sbom.cdx.json`), JSON.stringify({ bomFormat: "CycloneDX" }));
    }
    assert.deepEqual(readRuntimeFragments(root).map((fragment) => fragment.platform).sort(), [
      "darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive validation rejects traversal, links, devices, and FIFOs", () => {
  assert.equal(validateArchiveEntries(["node_modules/relay-companion/bin/relay.js"], ["-rw-r--r-- user group 1 Jan 1 relay.js"]), true);
  assert.throws(() => validateArchiveEntries(["../outside"], ["-rw-r--r-- x"]), /unsafe path/);
  assert.throws(() => validateArchiveEntries(["safe"], ["lrwxr-xr-x link -> outside"]), /regular files and directories only/);
  assert.throws(() => validateArchiveEntries(["safe"], ["prw------- fifo"]), /regular files and directories only/);
  assert.throws(() => validateArchiveEntries(["safe"], ["crw------- device"]), /regular files and directories only/);
});

test("Windows tar receives local relative paths instead of drive-letter remote names", () => {
  assert.deepEqual(tarInvocation({
    archivePath: "D:\\release\\runtime.tar.gz",
    destination: "D:\\release\\smoke",
    mode: "extract",
    pathImpl: path.win32,
  }), {
    command: "tar",
    args: ["-xzf", "runtime.tar.gz", "-C", "smoke"],
    cwd: "D:\\release",
  });
  assert.deepEqual(tarInvocation({
    archivePath: "C:\\relay\\runtime.tar.gz",
    mode: "list-names",
    pathImpl: path.win32,
  }), {
    command: "tar",
    args: ["-tzf", "runtime.tar.gz"],
    cwd: "C:\\relay",
  });
  assert.throws(() => tarInvocation({
    archivePath: "C:\\relay\\runtime.tar.gz",
    destination: "D:\\relay\\root",
    mode: "extract",
    pathImpl: path.win32,
  }), /share a local volume/);
});

test("artifact construction signs a compact internal-link map and refuses escaping links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-links-"));
  try {
    const packageRoot = path.join(root, "node_modules", "relay-companion");
    fs.mkdirSync(path.join(packageRoot, "real"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "real", "runtime.bin"), "verified bytes");
    fs.symlinkSync("real", path.join(packageRoot, "Current"), "dir");
    const links = captureInternalLinks(root, { platform: "darwin" });
    assert.equal(links.length, 1);
    assert.equal(links[0].path, "node_modules/relay-companion/Current");
    assert.equal(fs.existsSync(path.join(packageRoot, "Current")), false);
    fs.writeFileSync(path.join(packageRoot, "runtime-links.json"), JSON.stringify({ schema: 1, links }));
    assert.equal(restoreRuntimeLinks(root), 1);
    assert.equal(fs.lstatSync(path.join(packageRoot, "Current")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(packageRoot, "Current", "runtime.bin"), "utf8"), "verified bytes");

    fs.rmSync(path.join(packageRoot, "Current"));
    fs.symlinkSync(path.dirname(root), path.join(root, "escape"), "dir");
    assert.throws(() => captureInternalLinks(root, { platform: "darwin" }), /escapes the locked install/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rejects traversal, preseeded destinations, missing targets, and cycles in a signed link map", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-link-map-"));
  try {
    const packageRoot = path.join(root, "node_modules", "relay-companion");
    fs.mkdirSync(packageRoot, { recursive: true });
    const writeMap = (links) => fs.writeFileSync(
      path.join(packageRoot, "runtime-links.json"),
      JSON.stringify({ schema: 1, links }),
    );
    writeMap([{ path: "node_modules/relay-companion/escape", target: "../../../../outside", type: "file" }]);
    assert.throws(() => restoreRuntimeLinks(root), /escapes or duplicates/);

    writeMap([{ path: "node_modules/relay-companion/missing", target: "real", type: "file" }]);
    assert.throws(() => restoreRuntimeLinks(root), /absent or has the wrong type/);

    fs.writeFileSync(path.join(packageRoot, "already"), "preseeded");
    writeMap([{ path: "node_modules/relay-companion/already", target: "runtime-links.json", type: "file" }]);
    assert.throws(() => restoreRuntimeLinks(root), /unexpectedly present/);

    fs.rmSync(path.join(packageRoot, "already"));
    writeMap([
      { path: "node_modules/relay-companion/a", target: "b", type: "file" },
      { path: "node_modules/relay-companion/b", target: "a", type: "file" },
    ]);
    assert.throws(() => restoreRuntimeLinks(root), /cycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same runtime tree builds byte-identical archives and SBOM identities twice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-deterministic-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules", "relay-companion", "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "relay-companion", "bin", "relay.js"), "console.log('relay')\n");
    fs.writeFileSync(path.join(root, "node_modules", "relay-companion", "package.json"), JSON.stringify({ version }));
    const first = path.join(root, "first.tar.gz");
    const second = path.join(root, "second.tar.gz");
    createDeterministicArchive({ sourceRoot: root, outputPath: first });
    fs.utimesSync(path.join(root, "node_modules", "relay-companion", "bin", "relay.js"), new Date(), new Date());
    createDeterministicArchive({ sourceRoot: root, outputPath: second });
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
    const listed = spawnSync("tar", ["-tzf", first], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /node_modules\/relay-companion\/bin\/relay\.js/);
    const identity = { version, platformKey: "darwin-arm64", sourceSha, dependencyLockSha512: "sha512-lock" };
    assert.equal(deterministicSbomSerial(identity), deterministicSbomSerial(identity));
    const builder = fs.readFileSync(new URL("../scripts/build-runtime-artifact.mjs", import.meta.url), "utf8");
    assert.match(builder, /captureInternalLinks\(temporary,/);
    assert.match(builder, /300 \* 1024 \* 1024/);
    assert.doesNotMatch(builder, /randomUUID\(|new Date\(\)\.toISOString/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime staging never trusts a pre-existing destination", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preseeded-runtime-"));
  try {
    await assert.rejects(
      stageVerifiedRuntime({ version, platformKey: "darwin-arm64", destination: root }),
      /refused to reuse a pre-existing runtime destination/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup lock has no missing-owner race between contenders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-lock-"));
  const lockPath = path.join(root, "transaction.lock");
  let contenderError = null;
  let intercepted = false;
  try {
    const winner = acquireCanonicalLock(lockPath, {
      writeFileSync: (file, bytes, options) => {
        if (!intercepted) {
          intercepted = true;
          try { acquireCanonicalLock(lockPath); } catch (error) { contenderError = error; }
        }
        fs.writeFileSync(file, bytes, options);
      },
    });
    assert.equal(intercepted, true);
    assert.match(contenderError?.message || "", /already in progress/);
    assert.ok(fs.existsSync(path.join(lockPath, "owner.json")));
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);

    fs.mkdirSync(lockPath);
    const now = Date.now();
    fs.utimesSync(lockPath, now / 1000, now / 1000);
    assert.throws(() => acquireCanonicalLock(lockPath, { now: () => now }), /already in progress/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS and Windows credential commands use the native OS vault", () => {
  const macCalls = [];
  const mac = credentialStore.writeDeviceToken("secret-mac", {
    platform: "darwin",
    run: (command, args, options) => { macCalls.push({ command, args, options }); return { status: 0, stdout: "" }; },
  });
  assert.equal(mac.ok, true);
  assert.equal(macCalls[0].command, "/usr/bin/security");
  assert.ok(macCalls[0].args.includes("add-generic-password"));
  assert.equal(macCalls[0].args.includes("secret-mac"), false, "the token is not exposed in macOS argv");
  assert.equal(Object.values(macCalls[0].options.env).includes("secret-mac"), false, "the token is not exposed in macOS env");
  assert.equal(macCalls[0].options.input, "secret-mac", "the token is delivered over the child stdin pipe");
  const macRead = credentialStore.readDeviceToken({
    platform: "darwin",
    run: () => ({ status: 0, stdout: "secret-mac\n" }),
  });
  assert.deepEqual(macRead, { ok: true, value: "secret-mac", detail: "" });
  assert.equal(credentialStore.deleteDeviceToken({ platform: "darwin", run: () => ({ status: 0 }) }).ok, true);

  const windowsCalls = [];
  const windows = credentialStore.writeDeviceToken("secret-windows", {
    platform: "win32",
    run: (command, args, options) => { windowsCalls.push({ command, args, options }); return { status: 0, stdout: "" }; },
  });
  assert.equal(windows.ok, true);
  assert.equal(windowsCalls[0].command, "powershell.exe");
  assert.equal(windowsCalls[0].args.includes("secret-windows"), false, "the secret is not placed on the Windows command line");
  assert.equal(Object.values(windowsCalls[0].options.env).includes("secret-windows"), false, "the token is not placed in the Windows environment");
  assert.equal(windowsCalls[0].options.input, "secret-windows", "the token is delivered over the child stdin pipe");
  const windowsRead = credentialStore.readDeviceToken({
    platform: "win32",
    run: () => ({ status: 0, stdout: "secret-windows" }),
  });
  assert.equal(windowsRead.value, "secret-windows");
  assert.equal(credentialStore.deleteDeviceToken({ platform: "win32", run: () => ({ status: 0 }) }).ok, true);
});

test("canonical updater installs the signed artifact and does not recursively npm-install Relay", () => {
  const updater = fs.readFileSync(new URL("../src/canonical-updater.js", import.meta.url), "utf8");
  const bootstrap = fs.readFileSync(new URL("../bootstrap/relay-setup.cjs", import.meta.url), "utf8");
  assert.match(updater, /installSignedRuntimeCandidate/);
  assert.match(updater, /stageVerifiedRuntime/);
  assert.doesNotMatch(bootstrap, /npm\s+(?:install|i)\b/);
});

test("bootstrap writes the active pointer only after setup and exact-root health succeed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-pointer-"));
  try {
    const oldBin = path.join(root, "old", "relay.js");
    const nextBin = path.join(root, "next", "relay.js");
    const pointerPath = path.join(root, "current.json");
    fs.mkdirSync(path.dirname(oldBin), { recursive: true });
    fs.mkdirSync(path.dirname(nextBin), { recursive: true });
    fs.writeFileSync(oldBin, "// old");
    fs.writeFileSync(nextBin, "// next");
    fs.writeFileSync(pointerPath, JSON.stringify({ schema: 1, active: true, state: "active", version: "1.2.2", bin: oldBin }));
    const calls = [];
    await assert.rejects(() => activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(nextBin)) },
      { bin: nextBin, packageRoot: path.dirname(path.dirname(nextBin)) },
      version,
      { spawnImpl: (_command, args) => {
        calls.push(args);
        if (calls.length === 1) {
          const journal = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
          assert.equal(journal.state, "activating");
          assert.ok(journal.preparedAt > 0, "the daemon can distinguish live activation from abandoned recovery");
          assert.equal(journal.candidate.preparedAt, journal.preparedAt);
        }
        return { status: calls.length === 1 ? 1 : 0 };
      }, healthCheck: () => ({ ok: true }) },
    ), /activation failed/);
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, "1.2.2");
    assert.ok(calls.some((args) => args.includes("repair-runtime")), "failed setup repairs the prior runtime");

    await activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(nextBin)) },
      { bin: nextBin, packageRoot: path.dirname(path.dirname(nextBin)) },
      version,
      { spawnImpl: () => ({ status: 0 }), healthCheck: () => ({ ok: true }) },
    );
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, version);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap leaves a recovery journal when both activation and prior-runtime repair fail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-recovery-"));
  try {
    const oldBin = path.join(root, "old", "relay.js");
    const nextBin = path.join(root, "next", "relay.js");
    const pointerPath = path.join(root, "current.json");
    fs.mkdirSync(path.dirname(oldBin), { recursive: true });
    fs.mkdirSync(path.dirname(nextBin), { recursive: true });
    fs.writeFileSync(oldBin, "// old");
    fs.writeFileSync(nextBin, "// next");
    fs.writeFileSync(pointerPath, JSON.stringify({ schema: 1, active: true, state: "active", version: "1.2.2", bin: oldBin }));
    await assert.rejects(() => activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(nextBin)) },
      { bin: nextBin, packageRoot: path.dirname(path.dirname(nextBin)) },
      version,
      { spawnImpl: () => ({ status: 1 }), healthCheck: () => ({ ok: true }) },
    ), /Rollback failed/);
    const journal = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    assert.equal(journal.active, false);
    assert.equal(journal.state, "recovery-required");
    assert.equal(journal.failure.reason, "activation-and-rollback-failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rolls back when registered services never become healthy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-health-"));
  try {
    const oldBin = path.join(root, "old", "relay.js");
    const nextPackageRoot = path.join(root, "next", "node_modules", "relay-companion");
    const nextBin = path.join(nextPackageRoot, "bin", "relay.js");
    const pointerPath = path.join(root, "current.json");
    fs.mkdirSync(path.dirname(oldBin), { recursive: true });
    fs.mkdirSync(path.dirname(nextBin), { recursive: true });
    fs.writeFileSync(oldBin, "// old");
    fs.writeFileSync(nextBin, "// next");
    fs.writeFileSync(pointerPath, JSON.stringify({ schema: 1, active: true, state: "active", version: "1.2.2", bin: oldBin }));
    const calls = [];
    await assert.rejects(() => activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(nextPackageRoot)) },
      { bin: nextBin, packageRoot: nextPackageRoot },
      version,
      {
        spawnImpl: (_command, args) => { calls.push(args); return { status: 0 }; },
        healthCheck: () => ({ ok: false, daemon: true, pill: false }),
        healthAttempts: 2,
        healthIntervalMs: 0,
        sleep: async () => {},
      },
    ), /pill did not start/);
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, "1.2.2");
    assert.ok(calls.some((args) => args.includes("repair-runtime")), "failed health restores the prior runtime");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new setup documentation has one exact-version command and no pairing code", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /npx --yes relay-companion@<EXACT_VERSION> setup/);
  assert.doesNotMatch(readme, /relay-companion@latest setup/);
  assert.doesNotMatch(readme, /setup --code <PAIRING_CODE>/);
});

test("public release owns immutable publication while private promotion owns fleet activation", () => {
  const localPublicWorkflow = new URL("../.github/workflows/release.yml", import.meta.url);
  const templatedPublicWorkflow = new URL("../public-release/.github/workflows/release.yml", import.meta.url);
  const publish = fs.readFileSync(fs.existsSync(localPublicWorkflow) ? localPublicWorkflow : templatedPublicWorkflow, "utf8");
  assert.match(publish, /workflow_dispatch/);
  assert.doesNotMatch(publish, /\n\s*push:/);
  assert.match(publish, /s3api put-object/);
  assert.match(publish, /--if-none-match '\*'/);
  assert.match(publish, /npm publish .*--provenance/);
  assert.match(publish, /existing npm version has different bytes/);
  assert.match(publish, /tar -tzf "\$tarball" > "\$RUNNER_TEMP\/pack-files\.txt"/);
  assert.doesNotMatch(publish, /tar -tzf "\$tarball" \| grep/);
  assert.doesNotMatch(publish, /companion-releases\/stable\/manifest\.json/);
  const privatePromotion = new URL("../../../.github/workflows/promote-prod.yml", import.meta.url);
  if (fs.existsSync(privatePromotion)) {
    const promote = fs.readFileSync(privatePromotion, "utf8");
    assert.match(promote, /thin-installer\) TAG=installer/);
    assert.match(promote, /thin installer must never replace bridge latest/);
    assert.match(promote, /companion-releases\/stable\/manifest\.json/);
    assert.match(promote, /--key "companion-releases\/stable\/manifest\.json"/);
    assert.doesNotMatch(promote, /CURRENT_STABLE="\$\(curl/);
    assert.match(promote, /s3api get-object[\s\S]{0,1600}elif grep -q 'NoSuchKey'/);
    assert.match(promote, /could not read the authoritative stable runtime pointer/);
    assert.doesNotMatch(promote, /if \[ "\$TAG" = "latest" \][\s\S]{0,300}stable\/manifest/);
  }
});

test("public export includes every script its release security suite imports", () => {
  assert.equal(fs.existsSync(new URL("../scripts/assert-monotonic-version.mjs", import.meta.url)), true);
});
