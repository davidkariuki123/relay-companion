import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";

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
import { electronVersionArgs } from "../scripts/verify-installed-runtime.mjs";
import {
  installLinuxElectronSandboxAsRoot,
  linuxElectronSandboxPlan,
  prepareLinuxElectronSandbox,
} from "../scripts/prepare-linux-electron-sandbox.mjs";
import { verifyThinSetupUninstalled } from "../scripts/verify-thin-setup-canary.mjs";

const posixFsTest = process.platform === "win32" ? test.skip : test;

const {
  activeCanonicalCli,
  activateRuntime,
  acquireCanonicalLock,
  assertCompatibleNode,
  downloadVerifiedArtifact,
  durableNodePath,
  forwardActiveCanonicalCli,
  installCanonicalCliLauncher,
  processAlive,
  removeAbandonedRuntimeDownloads,
  restoreRuntimeLinks,
  stageVerifiedRuntime,
  tarInvocation,
  validateSetupCompatibilityArgs,
  validateArchiveEntries,
} = createRequire(import.meta.url)("../bootstrap/relay-setup.cjs");
const credentialStore = createRequire(import.meta.url)("../src/credential-store.cjs");
const {
  repairRuntimeExecutablePermissions,
  runtimeExecutableInventory,
  verifyRuntimeExecutables,
} = createRequire(import.meta.url)("../bootstrap/runtime-executables.cjs");

const version = "1.2.3";
const sourceSha = "a".repeat(40);
const WEBSITE_SETUP_ARGS = [
  "--code", "PAIR123",
  "--api", "https://aia6vj5pgp.us-east-1.awsapprunner.com",
  "--web", "https://sendrelays.com",
  "--open-relay", "open_tok",
  "--host", "codex",
];

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

test("every release smoke keeps Electron's production sandbox enabled", () => {
  assert.deepEqual(electronVersionArgs("linux"), ["--version"]);
  assert.deepEqual(electronVersionArgs("darwin"), ["--version"]);
  assert.deepEqual(electronVersionArgs("win32"), ["--version"]);
});

test("Linux release smoke provisions only the exact content-addressed Electron sandbox helper", () => {
  const electronPath = path.resolve("/runtime/node_modules/electron/dist/electron");
  const source = path.join(path.dirname(electronPath), "chrome-sandbox");
  const helperBytes = Buffer.from("pinned-electron-sandbox-helper");
  const digest = crypto.createHash("sha256").update(helperBytes).digest("hex");
  const destinationRoot = path.resolve("/trusted/relay/chromium-sandboxes");
  const destination = path.join(destinationRoot, digest, "chrome-sandbox");
  let installed = false;
  const stat = (file) => {
    if (file === electronPath) return { isFile: () => true, isSymbolicLink: () => false, size: 100, uid: 1000, mode: 0o100755 };
    if (file === source) return { isFile: () => true, isSymbolicLink: () => false, size: helperBytes.length, uid: 1000, mode: 0o100755 };
    if (file === destination && installed) return { isFile: () => true, isSymbolicLink: () => false, size: helperBytes.length, uid: 0, mode: 0o104755 };
    throw new Error("missing");
  };
  const fsImpl = {
    lstatSync: stat,
    realpathSync: (file) => file,
    readFileSync: (file) => {
      if (file === source || (file === destination && installed)) return helperBytes;
      throw new Error("missing");
    },
  };
  const plan = linuxElectronSandboxPlan(electronPath, {
    platform: "linux",
    destinationRoot,
    ...fsImpl,
  });
  assert.equal(plan.destination, destination);
  assert.throws(
    () => installLinuxElectronSandboxAsRoot(plan, {
      uid: 0,
      fsImpl,
      expectedSha256: "0".repeat(64),
    }),
    /changed before installation/,
    "the privileged half refuses a source swapped after the unprivileged digest was chosen",
  );

  const calls = [];
  const links = [];
  const env = {};
  const prepared = prepareLinuxElectronSandbox({
    electronPath,
    platform: "linux",
    destinationRoot,
    uid: 1000,
    fsImpl,
    execPath: "/opt/node/bin/node",
    scriptPath: "/checkout/scripts/prepare-linux-electron-sandbox.mjs",
    env,
    linkSandbox: (sandboxPlan) => links.push([sandboxPlan.source, sandboxPlan.destination]),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      installed = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(prepared.destination, destination);
  assert.equal(env.CHROME_DEVEL_SANDBOX, destination);
  assert.deepEqual(links, [[source, destination]]);
  assert.deepEqual(calls[0].args, [
    "--", "/opt/node/bin/node", "/checkout/scripts/prepare-linux-electron-sandbox.mjs",
    "--install-root", "--electron-path", electronPath, "--expected-sha256", digest,
  ]);
  assert.equal(calls[0].command, "sudo");
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.ok(!calls[0].args.includes("sh") && !calls[0].args.includes("-c"), "elevation never executes a shell command");
});

test("macOS target-site verification covers every Electron process executable and fails closed on a bad helper", () => {
  const inventory = runtimeExecutableInventory("/runtime/node_modules/relay-companion", {
    platform: "darwin",
    existsSync: () => true,
  });
  assert.equal(inventory.ok, true);
  assert.deepEqual(inventory.paths.map((entry) => entry.role), [
    "electron",
    "helper:Electron Helper",
    "helper:Electron Helper (GPU)",
    "helper:Electron Helper (Plugin)",
    "helper:Electron Helper (Renderer)",
    "helper:chrome_crashpad_handler",
  ]);
  const rejected = verifyRuntimeExecutables("/runtime/node_modules/relay-companion", {
    platform: "darwin",
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
    accessSync: (file) => {
      if (file.includes("Electron Helper (GPU)")) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
    },
  });
  assert.deepEqual(rejected, {
    ok: false,
    reason: "candidate-not-executable",
    detail: "helper:Electron Helper (GPU)",
  });
});

test("signed runtime preflight repairs only the known CLI and Electron executable inventory", () => {
  const root = "/runtime/node_modules/relay-companion";
  const executable = new Set();
  const chmods = [];
  const result = repairRuntimeExecutablePermissions(root, {
    platform: "darwin-arm64",
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
    accessSync: (file) => {
      if (!executable.has(file)) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
    },
    chmodSync: (file, mode) => {
      chmods.push({ file, mode });
      executable.add(file);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.repaired, [
    "relay-cli",
    "electron",
    "helper:Electron Helper",
    "helper:Electron Helper (GPU)",
    "helper:Electron Helper (Plugin)",
    "helper:Electron Helper (Renderer)",
    "helper:chrome_crashpad_handler",
  ]);
  assert.equal(chmods.length, result.repaired.length);
  assert.equal(chmods.every(({ file, mode }) => file.startsWith(root) && mode === 0o700), true);
});

test("runtime permission repair fails closed before chmod for an unexpected file type", () => {
  let chmodded = false;
  const result = repairRuntimeExecutablePermissions("/runtime/node_modules/relay-companion", {
    platform: "darwin",
    existsSync: () => true,
    statSync: () => ({ isFile: () => false }),
    accessSync: () => {},
    chmodSync: () => { chmodded = true; },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "candidate-executable-invalid",
    detail: "relay-cli",
  });
  assert.equal(chmodded, false);
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

function fakeArtifactGet(responses, requests) {
  return (_url, options, callback) => {
    requests.push(options);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    const spec = responses.shift();
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = spec.statusCode;
      response.headers = spec.headers;
      callback(response);
      response.end(spec.body);
    });
    return request;
  };
}

test("artifact download resumes a short first response and verifies the complete SHA-512", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-"));
  const destination = path.join(root, "runtime.tar.gz");
  const bytes = Buffer.from("a signed runtime that survives an interrupted first response");
  const firstBytes = 17;
  const requests = [];
  const artifact = {
    bytes: bytes.length,
    sha512: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
  };
  const get = fakeArtifactGet([
    {
      statusCode: 200,
      headers: { "content-length": String(bytes.length) },
      body: bytes.subarray(0, firstBytes),
    },
    {
      statusCode: 206,
      headers: {
        "content-length": String(bytes.length - firstBytes),
        "content-range": `bytes ${firstBytes}-${bytes.length - 1}/${bytes.length}`,
      },
      body: bytes.subarray(firstBytes),
    },
  ], requests);
  try {
    await downloadVerifiedArtifact(
      "https://api.sendrelays.com/v1/companion-releases/v1.2.3/runtime.tar.gz",
      destination,
      artifact,
      { get, sleep: async () => {}, attempts: 3 },
    );
    assert.deepEqual(fs.readFileSync(destination), bytes);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.range, undefined);
    assert.equal(requests[1].headers.range, `bytes=${firstBytes}-`);
    assert.equal(requests[1].headers["accept-encoding"], "identity");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact resume rejects a mismatched Content-Range without retrying corrupt bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bad-range-"));
  const destination = path.join(root, "runtime.tar.gz");
  const bytes = Buffer.from("signed bytes for strict range validation");
  const firstBytes = 8;
  const requests = [];
  const artifact = {
    bytes: bytes.length,
    sha512: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
  };
  const get = fakeArtifactGet([
    {
      statusCode: 200,
      headers: { "content-length": String(bytes.length) },
      body: bytes.subarray(0, firstBytes),
    },
    {
      statusCode: 206,
      headers: {
        "content-length": String(bytes.length - firstBytes),
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      body: bytes.subarray(firstBytes),
    },
  ], requests);
  try {
    await assert.rejects(
      downloadVerifiedArtifact(
        "https://api.sendrelays.com/v1/companion-releases/v1.2.3/runtime.tar.gz",
        destination,
        artifact,
        { get, sleep: async () => {}, attempts: 3 },
      ),
      /invalid Content-Range/,
    );
    assert.equal(requests.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(validatePublishedMetadata({ ...metadata, gitHead: undefined }, { version, sourceSha }).integrity, integrity);
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
    fs.writeFileSync(path.join(root, "bootstrap", "linux-systemd.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "owned-node-runtime.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "relay-background-install.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "relay-setup.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "relay-skill.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "release-signature.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "runtime-executables.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "runtime-health.cjs"), "module.exports = {}\n");
    fs.writeFileSync(path.join(root, "bootstrap", "trust.json"), "{}\n");
    fs.writeFileSync(path.join(root, "README.md"), "Relay\n");
    fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n");
    fs.cpSync(new URL("../skill", import.meta.url), path.join(root, "skill"), { recursive: true });
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

test("thin runtime health loads with bootstrap files alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-bootstrap-"));
  try {
    const bootstrap = path.join(root, "bootstrap");
    fs.mkdirSync(bootstrap, { recursive: true });
    for (const name of ["linux-systemd.cjs", "runtime-health.cjs"]) {
      fs.copyFileSync(new URL(`../bootstrap/${name}`, import.meta.url), path.join(bootstrap, name));
    }
    const isolatedRequire = createRequire(path.join(root, "smoke.cjs"));
    assert.doesNotThrow(() => isolatedRequire(path.join(bootstrap, "runtime-health.cjs")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux preserves version-managed Node and installs a durable canonical CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-cli-"));
  try {
    const volatileNode = path.join(root, ".nvm", "versions", "node", "v22.13.0", "bin", "node");
    fs.mkdirSync(path.dirname(volatileNode), { recursive: true });
    fs.writeFileSync(volatileNode, "relay-node-bytes", { mode: 0o700 });
    const runtimeRoot = path.join(root, ".relay", "runtime");
    const durable = durableNodePath(volatileNode, { platform: "linux", runtimeRoot });
    assert.match(durable.replaceAll("\\", "/"), /\/\.relay\/runtime\/node\/[a-f0-9]{64}\/node$/);
    assert.equal(fs.readFileSync(durable, "utf8"), "relay-node-bytes");
    fs.rmSync(path.join(root, ".nvm"), { recursive: true, force: true });
    assert.equal(fs.existsSync(durable), true);

    const releaseRoot = path.join(runtimeRoot, "releases", "1-linux-x64-test");
    const packageRoot = path.join(releaseRoot, "node_modules", "relay-companion");
    const bin = path.join(packageRoot, "bin", "relay.cjs");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "console.log('canonical-cli:' + process.argv.slice(2).join(','));\n");
    const pointerPath = path.join(runtimeRoot, "current.json");
    const candidate = { active: true, state: "active", node: process.execPath, bin, packageRoot, releaseRoot };
    const installed = installCanonicalCliLauncher(candidate, {
      platform: "linux",
      homeDir: root,
      pointerPath,
      env: { PATH: path.join(root, ".local", "bin") },
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.pathAvailable, true);
    fs.writeFileSync(pointerPath, JSON.stringify(candidate));
    const invoked = spawnSync(process.execPath, [installed.launcherPath, "doctor"], { encoding: "utf8" });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.equal(invoked.stdout.trim(), "canonical-cli:doctor");

    const repeated = installCanonicalCliLauncher(candidate, {
      platform: "linux",
      homeDir: root,
      pointerPath,
      env: { PATH: path.join(root, ".local", "bin") },
    });
    assert.equal(repeated.ok, true, "an unchanged Relay-owned launcher is safe to reuse");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux canonical CLI setup refuses unrelated launcher and command files without changing either", () => {
  for (const collision of ["launcher", "shim"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `relay-linux-cli-${collision}-`));
    try {
      const pointerPath = path.join(root, ".relay", "runtime", "current.json");
      const launcherPath = path.join(path.dirname(pointerPath), "relay-cli.cjs");
      const shimPath = path.join(root, ".local", "bin", "relay");
      const target = collision === "launcher" ? launcherPath : shimPath;
      const original = collision === "launcher"
        ? "#!/usr/bin/env node\nconsole.log('someone else');\n"
        : "#!/bin/sh\necho someone-else\n";
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, original);

      const installed = installCanonicalCliLauncher({ node: process.execPath }, {
        platform: "linux",
        homeDir: root,
        pointerPath,
        env: {},
      });

      assert.equal(installed.ok, false);
      assert.equal(installed.reason, collision === "launcher" ? "cli_launcher_collision" : "cli_shim_collision");
      assert.equal(fs.readFileSync(target, "utf8"), original, "the unrelated file stays byte-identical");
      const other = collision === "launcher" ? shimPath : launcherPath;
      assert.equal(fs.existsSync(other), false, "preflight fails before writing the other generated file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  const exportedTemplate = new URL("../public-release/.gitattributes", import.meta.url);
  const inMonorepo = fs.existsSync(exportedTemplate);
  const localAttributes = fs.readFileSync(
    inMonorepo ? new URL("../../../.gitattributes", import.meta.url) : new URL("../.gitattributes", import.meta.url),
    "utf8",
  );
  const publicAttributes = fs.readFileSync(inMonorepo ? exportedTemplate : new URL("../.gitattributes", import.meta.url), "utf8");
  for (const relative of [
    "package.json",
    "package-lock.json",
    "runtime-dependencies.json",
    "runtime-lock/package.json",
    "runtime-lock/package-lock.json",
  ]) {
    const localPath = inMonorepo ? `packages/companion/${relative}` : relative;
    assert.match(localAttributes, new RegExp(`${localPath.replaceAll("/", "\\/")} text eol=lf`));
    assert.match(publicAttributes, new RegExp(`${relative.replaceAll("/", "\\/")} text eol=lf`));
  }
  assert.match(publicAttributes, /npm-shrinkwrap\.json text eol=lf/);
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
  const platforms = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"];
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
  const fragments = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"].map((platform) => ({
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
  const fragments = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"].map((platform) => ({
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
    for (const platform of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"]) {
      fs.writeFileSync(path.join(root, `${platform}.json`), JSON.stringify({ platform }));
      fs.writeFileSync(path.join(root, `relay-runtime-${version}-${platform}.sbom.cdx.json`), JSON.stringify({ bomFormat: "CycloneDX" }));
    }
    assert.deepEqual(readRuntimeFragments(root).map((fragment) => fragment.platform).sort(), [
      "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64",
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

test("artifact construction signs a compact internal-link map and refuses escaping links", {
  skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false,
}, () => {
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

test("canonical setup immediately recovers a fresh lock whose process died", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-dead-lock-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "dead-download",
      createdAt: now,
      operation: "bootstrap-setup",
    }));
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      isProcessAlive: () => false,
      processIdentity: () => "",
    });
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.nonce, "dead-download");
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup recovers a valid dead owner when filesystem birth time is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-zero-birth-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "d".repeat(32),
      createdAt: now,
    }));
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      isProcessAlive: () => false,
      processIdentity: () => "",
      statSync: (file, options) => {
        const value = fs.statSync(file, options);
        return { ...value, birthtimeNs: 0n, birthtimeMs: 0 };
      },
    });
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup never steals an old lock from the same live process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-live-lock-"));
  const lockPath = path.join(root, "transaction.lock");
  const original = JSON.stringify({
    pid: process.pid,
    nonce: "live-download",
    createdAt: 1,
    operation: "bootstrap-setup",
    processIdentity: "boot-a:100",
  });
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), original);
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => 10 * 60 * 60_000,
      isProcessAlive: () => true,
      processIdentity: () => "boot-a:100",
    }), /already in progress/);
    assert.equal(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup recognizes Linux PID reuse by process identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-reused-pid-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      nonce: "previous-process",
      createdAt: now,
      operation: "bootstrap-setup",
      processIdentity: "boot-a:100",
    }));
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      isProcessAlive: () => true,
      processIdentity: () => "boot-a:200",
    });
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.notEqual(owner.nonce, "previous-process");
    winner.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup gives incomplete owners a grace period, then recovers them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-orphan-lock-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), "not-json");
    fs.utimesSync(lockPath, new Date(now), new Date(now));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
    }), /already in progress/);

    fs.utimesSync(lockPath, new Date(now - 31_000), new Date(now - 31_000));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
    }), /already in progress/);
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      staleAfterMs: 30_000,
      processIdentity: () => "",
    });
    winner.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup preserves the legacy publication grace during rollout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-legacy-publisher-"));
  const lockPath = path.join(root, "transaction.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const now = Date.now();
  const legacyOwner = JSON.stringify({ pid: process.pid, createdAt: now - 31_000 });
  try {
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, new Date(now - 31_000), new Date(now - 31_000));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
    }), /already in progress/);
    // A shipped bootstrap paused before its non-exclusive owner write can still
    // resume safely because the new contender did not reclaim its directory.
    fs.writeFileSync(ownerPath, legacyOwner);
    assert.equal(fs.readFileSync(ownerPath, "utf8"), legacyOwner);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const readFailureAt of ["initial-owner", "confirmed-owner", "existing-claim"]) {
test(`canonical setup fails closed on ${readFailureAt} filesystem read errors`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-lock-read-error-"));
  const lockPath = path.join(root, "transaction.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const reclaimPath = path.join(lockPath, "reclaim.json");
  const ownerBytes = JSON.stringify({ pid: 4074800, nonce: "d".repeat(32), createdAt: 1 });
  let ownerReads = 0;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPath, ownerBytes);
    if (readFailureAt === "existing-claim") {
      fs.writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, nonce: "a".repeat(32), createdAt: 1 }));
    }
    const readFileSync = (file, options) => {
      const resolved = path.resolve(file);
      if (resolved === path.resolve(ownerPath)) {
        ownerReads += 1;
        if (readFailureAt === "initial-owner" || (readFailureAt === "confirmed-owner" && ownerReads === 2)) {
          const error = new Error("simulated owner read failure");
          error.code = "EIO";
          throw error;
        }
      }
      if (readFailureAt === "existing-claim" && resolved === path.resolve(reclaimPath)) {
        const error = new Error("simulated claim read failure");
        error.code = "EACCES";
        throw error;
      }
      return fs.readFileSync(file, options);
    };
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => Date.now(),
      readFileSync,
      isProcessAlive: () => false,
      processIdentity: () => "",
    }));
    assert.equal(fs.readFileSync(ownerPath, "utf8"), ownerBytes);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("canonical setup preserves an old ownerless lock without filesystem birth time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-ownerless-zero-birth-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, new Date(now - 31_000), new Date(now - 31_000));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
      statSync: (file, options) => {
        const value = fs.statSync(file, options);
        return { ...value, birthtimeNs: 0n, birthtimeMs: 0 };
      },
    }), /already in progress/);
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(path.join(lockPath, "reclaim.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup recovers an old ownerless lock with trustworthy birth time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-ownerless-birth-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, new Date(now - 31_000), new Date(now - 31_000));
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      staleAfterMs: 30_000,
      processIdentity: () => "",
    });
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const incompleteOwner of [null, '{"pid":']) {
test(`canonical setup preserves an ambiguous replacement ${incompleteOwner === null ? "ownerless" : "partial-owner"} lock`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-ownerless-reuse-"));
  const lockPath = path.join(root, "transaction.lock");
  const reclaimPath = path.join(lockPath, "reclaim.json");
  const now = Date.now();
  let replaced = false;
  try {
    fs.mkdirSync(lockPath);
    if (incompleteOwner !== null) fs.writeFileSync(path.join(lockPath, "owner.json"), incompleteOwner);
    fs.utimesSync(lockPath, new Date(now - 31_000), new Date(now - 31_000));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      staleAfterMs: 30_000,
      processIdentity: () => "",
      statSync: (file, options) => {
        const value = fs.statSync(file, options);
        return path.resolve(file) === path.resolve(lockPath)
          ? { ...value, dev: 1n, ino: 2n, birthtimeNs: 0n, birthtimeMs: 0 }
          : value;
      },
      writeFileSync: (file, bytes, options) => {
        fs.writeFileSync(file, bytes, options);
        if (!replaced && path.resolve(file) === path.resolve(reclaimPath)) {
          replaced = true;
          fs.rmSync(lockPath, { recursive: true, force: true });
          fs.mkdirSync(lockPath);
          if (incompleteOwner !== null) fs.writeFileSync(path.join(lockPath, "owner.json"), incompleteOwner);
        }
      },
    }), /already in progress/);
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(reclaimPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("concurrent dead-lock recovery cannot displace the winning installer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-lock-race-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  let winner = null;
  let triggered = false;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "dead-download",
      createdAt: now,
      operation: "bootstrap-setup",
    }));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
      isProcessAlive: (pid) => {
        if (!triggered) {
          triggered = true;
          winner = acquireCanonicalLock(lockPath, {
            now: () => now,
            isProcessAlive: () => false,
            processIdentity: () => "",
          });
        }
        return pid === process.pid;
      },
    }), /already in progress/);
    const ownerBeforeLosingRelease = fs.readFileSync(path.join(lockPath, "owner.json"), "utf8");
    assert.equal(JSON.parse(ownerBeforeLosingRelease).pid, process.pid);
    assert.ok(winner);
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    try { winner?.release(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup detects a replacement even when the filesystem reuses its inode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-inode-reuse-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  let replaced = false;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "dead-download",
      createdAt: now,
    }));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      processIdentity: () => "",
      statSync: () => ({ dev: 1n, ino: 2n, birthtimeNs: 3n, mtimeMs: BigInt(now) }),
      isProcessAlive: () => {
        if (!replaced) {
          replaced = true;
          fs.rmSync(lockPath, { recursive: true, force: true });
          fs.mkdirSync(lockPath);
        }
        return false;
      },
    }), /already in progress/);
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(path.join(lockPath, "reclaim.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a paused setup owner cannot overwrite the successor that reclaimed its empty lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-owner-publish-race-"));
  const lockPath = path.join(root, "transaction.lock");
  const startedAt = Date.now();
  let intercepted = false;
  let winner = null;
  try {
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => startedAt,
      processIdentity: () => "",
      writeFileSync: (file, bytes, options) => {
        if (!intercepted && file === path.join(lockPath, "owner.json")) {
          intercepted = true;
          winner = acquireCanonicalLock(lockPath, {
            now: () => startedAt + 31_000,
            staleAfterMs: 30_000,
            processIdentity: () => "",
          });
        }
        fs.writeFileSync(file, bytes, options);
      },
    }), /already in progress/);
    assert.equal(intercepted, true);
    const successor = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.equal(successor.pid, process.pid);
    assert.ok(winner);
    winner.release();
  } finally {
    try { winner?.release(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup publication yields to a reclaimer that already passed its owner snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-publication-claim-"));
  const lockPath = path.join(root, "transaction.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const reclaimPath = path.join(lockPath, "reclaim.json");
  const claimBytes = JSON.stringify({ pid: process.pid, nonce: "a".repeat(32), createdAt: Date.now() });
  try {
    assert.throws(() => acquireCanonicalLock(lockPath, {
      processIdentity: () => "",
      writeFileSync: (file, bytes, options) => {
        // The claimant has confirmed the old empty owner and is paused just
        // before rename. Publishing now must not authorize this creator.
        if (path.resolve(file) === path.resolve(ownerPath)) {
          fs.writeFileSync(reclaimPath, claimBytes, { flag: "wx" });
        }
        fs.writeFileSync(file, bytes, options);
      },
    }), /lost canonical install lock ownership to a recovery claimant/);
    assert.equal(fs.existsSync(ownerPath), true);
    assert.equal(fs.readFileSync(reclaimPath, "utf8"), claimBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

posixFsTest("a setup owner paused during publication cannot proceed after its lock is reclaimed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-partial-owner-race-"));
  const lockPath = path.join(root, "transaction.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const startedAt = Date.now();
  let intercepted = false;
  let winner = null;
  let oldFd = null;
  try {
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => startedAt,
      processIdentity: () => "",
      writeFileSync: (file, bytes, options) => {
        if (!intercepted && path.resolve(file) === path.resolve(ownerPath)) {
          intercepted = true;
          oldFd = fs.openSync(file, options.flag, options.mode);
          fs.writeSync(oldFd, bytes.slice(0, 7));
          winner = acquireCanonicalLock(lockPath, {
            now: () => startedAt + 31_000,
            staleAfterMs: 30_000,
            processIdentity: () => "",
          });
          fs.writeSync(oldFd, bytes.slice(7));
          fs.closeSync(oldFd);
          oldFd = null;
          return;
        }
        fs.writeFileSync(file, bytes, options);
      },
    }), /lost canonical install lock ownership/);
    assert.equal(intercepted, true);
    const successor = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    assert.equal(successor.pid, process.pid);
    assert.ok(winner);
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (oldFd !== null) try { fs.closeSync(oldFd); } catch {}
    try { winner?.release(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup recovers when a previous lock reclaimer also died", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-dead-reclaimer-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "dead-download",
      createdAt: now,
    }));
    fs.writeFileSync(path.join(lockPath, "reclaim.json"), JSON.stringify({
      pid: 4074801,
      nonce: "dead-reclaimer",
      createdAt: now,
    }));
    const winner = acquireCanonicalLock(lockPath, {
      now: () => now,
      isProcessAlive: () => false,
      processIdentity: () => "",
    });
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.notEqual(owner.nonce, "dead-download");
    winner.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical setup leaves a dead owner alone while its live reclaimer is working", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-live-reclaimer-"));
  const lockPath = path.join(root, "transaction.lock");
  const now = Date.now();
  const reclaim = {
    pid: process.pid,
    nonce: "live-reclaimer",
    createdAt: now,
  };
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 4074800,
      nonce: "dead-download",
      createdAt: now,
    }));
    fs.writeFileSync(path.join(lockPath, "reclaim.json"), JSON.stringify(reclaim));
    assert.throws(() => acquireCanonicalLock(lockPath, {
      now: () => now,
      isProcessAlive: (pid) => pid === process.pid,
      processIdentity: () => "",
    }), /already in progress/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockPath, "reclaim.json"), "utf8")), reclaim);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old setup handle cannot release a successor's lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-release-owner-"));
  const lockPath = path.join(root, "transaction.lock");
  try {
    const oldHandle = acquireCanonicalLock(lockPath, { processIdentity: () => "" });
    const successor = JSON.stringify({ pid: process.pid, nonce: "successor", createdAt: Date.now() });
    fs.writeFileSync(path.join(lockPath, "owner.json"), successor);
    oldHandle.release();
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"), successor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux zombie lock owners are treated as dead even with a matching PID", () => {
  const fields = ["Z", ...Array(18).fill("0"), "123456", ...Array(3).fill("0")];
  const alive = processAlive(42, {
    platform: "linux",
    kill: () => {},
    readFileSync: (file) => String(file).includes("boot_id")
      ? "test-boot-id\n"
      : `42 (command with ) spaces) ${fields.join(" ")}\n`,
  });
  assert.equal(alive, false);
});

test("a recovered setup removes abandoned downloads without touching releases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-download-cleanup-"));
  try {
    for (const name of [".relay-download-1.2.3-one", ".relay-download-1.2.3-two"]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "runtime.tar.gz"), "partial");
    }
    const release = path.join(root, "1.2.3-linux-x64-release");
    fs.mkdirSync(release);
    fs.writeFileSync(path.join(release, "sentinel"), "keep");
    assert.equal(removeAbandonedRuntimeDownloads(root), 2);
    assert.deepEqual(fs.readdirSync(root), ["1.2.3-linux-x64-release"]);
    assert.equal(fs.readFileSync(path.join(release, "sentinel"), "utf8"), "keep");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS uses an owner-only local store while Windows uses Credential Manager", () => {
  const macRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mac-credential-test-"));
  const macFile = path.join(macRoot, "credentials.json");
  const macCalls = [];
  const mac = credentialStore.writeDeviceToken("secret-mac", {
    platform: "darwin",
    file: macFile,
    run: (command, args, options) => {
      macCalls.push({ command, args, options });
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(mac.ok, true);
  assert.equal(macCalls.length, 0, "a new macOS credential never touches the shared login Keychain");
  // NTFS does not expose POSIX chmod semantics through Node. The same test runs
  // on both release Mac runners, where the owner-only mode is enforceable.
  if (process.platform !== "win32") assert.equal(fs.statSync(macFile).mode & 0o777, 0o600);
  const macRead = credentialStore.readDeviceToken({
    platform: "darwin",
    file: macFile,
    run: () => { throw new Error("local reads must not invoke Keychain"); },
  });
  assert.deepEqual(macRead, { ok: true, value: "secret-mac", detail: "" });
  assert.equal(credentialStore.deleteDeviceToken({ platform: "darwin", file: macFile }).ok, true);
  fs.rmSync(macRoot, { recursive: true, force: true });

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
  const windowsMissing = credentialStore.readDeviceToken({
    platform: "win32",
    run: (_command, args) => {
      assert.match(args.join(" "), /\$null -eq \$v\)\{exit 3\}/);
      return { status: 3, stdout: "" };
    },
  });
  assert.equal(windowsMissing.ok, false, "a missing Windows credential is not an empty successful secret");
  assert.equal(windowsMissing.code, "credential_not_found");
  assert.equal(credentialStore.deleteDeviceToken({ platform: "win32", run: () => ({ status: 0 }) }).ok, true);
});

test("fresh installation authorization fields cannot fall through to the macOS Keychain", () => {
  const source = fs.readFileSync(new URL("../src/installation-authorization.js", import.meta.url), "utf8");
  const splitRead = source.match(/for \(const \[field, account\][\s\S]*?values\[field\] = result\.value;/)?.[0] || "";
  assert.match(splitRead, /readCredentialImpl\(options\(account\)\)/);
  assert.doesNotMatch(splitRead, /allowLegacyMigration/);
  assert.match(source, /readCredentialImpl\(\{ \.\.\.options\(INSTALLATION_CREDENTIAL_ACCOUNT\), allowLegacyMigration: true \}\)/);
});

test("native credential failures distinguish a missing secret from an unavailable vault", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-keychain-test-"));
  const file = path.join(root, "credentials.json");
  const calls = [];
  const lockedRead = credentialStore.readDeviceToken({
    platform: "darwin",
    file,
    allowLegacyMigration: true,
    run: (command, args) => {
      calls.push({ command, args });
      return { status: 51, stdout: "", stderr: "The user name or passphrase you entered is not correct." };
    },
  });
  assert.deepEqual(lockedRead, {
    ok: false,
    value: "",
    detail: "native credential store is locked or unavailable",
    code: "credential_unavailable",
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("show-keychain-info"), "the non-secret preflight fails before a password read can prompt");

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-missing-test-"));
  const missingRead = credentialStore.readDeviceToken({
    platform: "darwin",
    file: path.join(missingRoot, "credentials.json"),
    allowLegacyMigration: true,
    run: (_command, args) => args.includes("show-keychain-info")
      ? { status: 0, stdout: "" }
      : { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain. (-25300)" },
  });
  assert.equal(missingRead.code, "credential_not_found");

  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-write-test-"));
  const localWrite = credentialStore.writeDeviceToken("never-log-this-secret", {
    platform: "darwin",
    file: path.join(writeRoot, "credentials.json"),
    run: () => { throw new Error("new macOS writes must not invoke Keychain"); },
  });
  assert.equal(localWrite.ok, true);
  assert.equal(JSON.stringify(localWrite).includes("never-log-this-secret"), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(missingRoot, { recursive: true, force: true });
  fs.rmSync(writeRoot, { recursive: true, force: true });
});

test("canonical updater installs the signed artifact and does not recursively npm-install Relay", () => {
  const updater = fs.readFileSync(new URL("../src/canonical-updater.js", import.meta.url), "utf8");
  const bootstrap = fs.readFileSync(new URL("../bootstrap/relay-setup.cjs", import.meta.url), "utf8");
  assert.match(updater, /installSignedRuntimeCandidate/);
  assert.match(updater, /stageVerifiedRuntime/);
  assert.doesNotMatch(bootstrap, /npm\s+(?:install|i)\b/);
});

test("the thin installer accepts only reviewed setup contracts", () => {
  assert.deepEqual(validateSetupCompatibilityArgs([]), []);
  assert.deepEqual(validateSetupCompatibilityArgs(["--agent-protocol"]), ["--agent-protocol"]);
  assert.deepEqual(validateSetupCompatibilityArgs(WEBSITE_SETUP_ARGS), WEBSITE_SETUP_ARGS);
  assert.deepEqual(
    validateSetupCompatibilityArgs(["--code", "PAIR123", "--api", "http://localhost:4000"]),
    ["--code", "PAIR123", "--api", "http://localhost:4000"],
  );
  assert.throws(
    () => validateSetupCompatibilityArgs(["--api", "https://api.sendrelays.com"]),
    /invalid pairing code/,
  );
  assert.throws(
    () => validateSetupCompatibilityArgs(["--code", "PAIR123", "--api", "http://api.sendrelays.com"]),
    /secure service origin/,
  );
  assert.throws(
    () => validateSetupCompatibilityArgs(["--code", "PAIR123", "--host", "codex"]),
    /host without a relay token/,
  );
  assert.throws(
    () => validateSetupCompatibilityArgs(["--code", "PAIR123", "--name", "unreviewed"]),
    /unsupported compatibility option/,
  );
  assert.throws(
    () => validateSetupCompatibilityArgs(["--agent-protocol", "--code", "PAIR123"]),
    /cannot combine agent protocol setup/,
  );
});

test("the thin installer forwards ordinary commands to the active signed runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-forward-"));
  try {
    const runtimeRoot = path.join(root, ".relay", "runtime");
    const bin = path.join(runtimeRoot, "releases", "0.1.390-test", "node_modules", "relay-companion", "bin", "relay.js");
    const node = path.join(root, "bin", "node");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(bin, "// canonical CLI\n");
    fs.writeFileSync(node, "node\n");
    fs.writeFileSync(path.join(runtimeRoot, "current.json"), JSON.stringify({
      schema: 1,
      active: true,
      state: "active",
      version: "0.1.390",
      bin,
      node,
    }));

    assert.deepEqual(activeCanonicalCli({ homeDir: root }), { bin, node, version: "0.1.390" });
    const calls = [];
    const result = forwardActiveCanonicalCli(["repair-desktop"], {
      findTarget: () => activeCanonicalCli({ homeDir: root }),
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });
    assert.equal(result.forwarded, true);
    assert.equal(result.status, 0);
    assert.equal(calls[0].command, node);
    assert.deepEqual(calls[0].args, [bin, "repair-desktop"]);
    assert.equal(calls[0].options.stdio, "inherit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the thin installer refuses a forged canonical pointer outside Relay releases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-forged-"));
  try {
    const runtimeRoot = path.join(root, ".relay", "runtime");
    const bin = path.join(root, "outside", "relay.js");
    const node = path.join(root, "bin", "node");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(bin, "// forged\n");
    fs.writeFileSync(node, "node\n");
    fs.writeFileSync(path.join(runtimeRoot, "current.json"), JSON.stringify({
      active: true,
      state: "active",
      bin,
      node,
    }));
    assert.equal(activeCanonicalCli({ homeDir: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const healthyMacActivation = async () => ({
  ok: true,
  health: { ok: true, daemon: true, pill: true, oldDaemon: false, oldPill: false },
});

test("bootstrap writes the active pointer only after setup and shared exact-root activation succeed", async () => {
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
      { platform: "darwin", spawnImpl: (_command, args) => {
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
      {
        platform: "darwin",
        spawnImpl: (_command, args) => {
          calls.push(args);
          return { status: 0 };
        },
        healthCheck: () => ({ ok: true }),
        activateMacServices: healthyMacActivation,
      },
    );
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, version);
    const setup = calls.find((args) => args.includes("setup"));
    assert.ok(setup.includes("--no-restart"), "setup writes registrations while shared activation owns launchd restart");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap Linux setup registers without restarting, then uses the exact-root systemd activator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-linux-handoff-"));
  try {
    const packageRoot = path.join(root, "next", "node_modules", "relay-companion");
    const bin = path.join(packageRoot, "bin", "relay.js");
    const pointerPath = path.join(root, "current.json");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "// next");
    const calls = [];
    let activated = false;
    await activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(packageRoot)) },
      { bin, packageRoot },
      version,
      {
        platform: "linux",
        homeDir: root,
        spawnImpl: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "", stderr: "" }; },
        setupCompatibilityArgs: WEBSITE_SETUP_ARGS,
        activateLinuxServices: async (target) => {
          activated = true;
          assert.equal(target.packageRoot, packageRoot);
          return { ok: true, health: { ok: true, daemon: true, pill: true } };
        },
      },
    );
    const setup = calls.find(({ args }) => args.includes("setup"));
    assert.ok(setup.args.includes("--no-restart"));
    assert.deepEqual(
      setup.args,
      [bin, "setup", "--no-trampoline", "--claim", ...WEBSITE_SETUP_ARGS, "--no-restart"],
      "the verified runtime receives the website pairing and open-relay contract intact",
    );
    assert.equal(activated, true);
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
      { platform: "darwin", spawnImpl: () => ({ status: 1 }), healthCheck: () => ({ ok: true }) },
    ), /Rollback failed/);
    const journal = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    assert.equal(journal.active, false);
    assert.equal(journal.state, "recovery-required");
    assert.equal(journal.failure.reason, "activation-and-rollback-failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rolls back when shared macOS activation cannot prove exact-root health", async () => {
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
        platform: "darwin",
        spawnImpl: (_command, args) => { calls.push(args); return { status: 0 }; },
        activateMacServices: async () => ({ ok: false, reason: "exact-root-health-failed", detail: "pill did not start" }),
      },
    ), /could not start the exact registered macOS services/);
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, "1.2.2");
    assert.ok(calls.some((args) => args.includes("repair-runtime")), "failed health restores the prior runtime");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap stops Windows Relay grandchildren before candidate setup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-windows-handoff-"));
  try {
    const nextPackageRoot = path.join(root, "next", "node_modules", "relay-companion");
    const nextBin = path.join(nextPackageRoot, "bin", "relay.js");
    const pointerPath = path.join(root, "current.json");
    fs.mkdirSync(path.dirname(nextBin), { recursive: true });
    fs.writeFileSync(nextBin, "// next");
    const calls = [];
    await activateRuntime(
      { pointerPath, releaseId: "next", releaseRoot: path.dirname(path.dirname(nextPackageRoot)) },
      { bin: nextBin, packageRoot: nextPackageRoot },
      version,
      {
        platform: "win32",
        spawnImpl: (command, args) => {
          calls.push({ command, args });
          return { status: 0, stdout: "", stderr: "" };
        },
        healthCheck: () => ({ ok: true }),
      },
    );
    assert.deepEqual(calls.slice(0, 2).map(({ command, args }) => [command, ...args]), [
      ["schtasks.exe", "/End", "/TN", "Relay Companion Pill"],
      ["schtasks.exe", "/End", "/TN", "Relay Companion Daemon"],
    ]);
    assert.equal(calls[2].command, "powershell.exe");
    assert.match(calls[2].args.join(" "), /relay\\\.js.*daemon/);
    assert.match(calls[2].args.join(" "), /overlay.*main\\\.cjs/);
    assert.equal(calls[3].command, process.execPath, "candidate setup starts only after the old grandchildren are swept");
    assert.equal(calls[3].args[0], nextBin);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap restores the prior runtime when the Windows service sweep fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bootstrap-windows-stop-failure-"));
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
        platform: "win32",
        spawnImpl: (command, args) => {
          calls.push({ command, args });
          if (command === "powershell.exe") return { status: 1, stderr: "service sweep failed" };
          return { status: 0, stdout: "", stderr: "" };
        },
        healthCheck: () => ({ ok: true }),
      },
    ), /could not stop the previous desktop services/);
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).version, "1.2.2");
    assert.ok(calls.some(({ args }) => args.includes("repair-runtime")), "failed service cleanup restores the prior runtime");
    assert.equal(calls.some(({ args }) => args.includes("setup")), false, "candidate setup never starts after an incomplete handoff");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new setup documentation has one exact-version command and no pairing code", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /npx --yes --no-audit --no-fund relay-companion@<EXACT_VERSION> setup/);
  assert.doesNotMatch(readme, /relay-companion@latest setup/);
  assert.doesNotMatch(readme, /setup --code <PAIRING_CODE>/);
});

test("thin setup cleanup verifier proves launchd labels and installed service processes are stopped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-uninstall-canary-"));
  const runtime = {
    schema: 1,
    active: true,
    state: "active",
    version,
    packageRoot: path.join(root, ".relay", "runtime", "releases", version, "node_modules", "relay-companion"),
    bin: path.join(root, ".relay", "runtime", "releases", version, "node_modules", "relay-companion", "bin", "relay.js"),
  };
  try {
    const calls = [];
    const processChecks = [];
    const result = await verifyThinSetupUninstalled({
      version,
      homeDir: root,
      platform: "darwin",
      uid: 501,
      readRuntime: () => runtime,
      run: (command, args) => {
        calls.push([command, ...args]);
        return args[1] === "gui/501" ? { status: 0, stdout: "domain is queryable" } : { status: 113, stderr: "not found" };
      },
      processRows: (target, options) => {
        processChecks.push({ target, options });
        return { ok: true, rows: [] };
      },
    });
    assert.deepEqual(result.stoppedLabels, ["work.relay.companion.pill", "work.relay.companion"]);
    assert.deepEqual(calls, [
      ["/bin/launchctl", "print", "gui/501"],
      ["/bin/launchctl", "print", "gui/501/work.relay.companion.pill"],
      ["/bin/launchctl", "print", "gui/501/work.relay.companion"],
    ]);
    assert.equal(processChecks[0].target, runtime);
    assert.equal(processChecks[0].options.includeTarget, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("thin setup cleanup verifier fails closed on loaded services or an unreadable process table", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thin-uninstall-failure-"));
  const runtime = { active: true, state: "active", version, packageRoot: "/tmp/runtime/node_modules/relay-companion" };
  const absentLabelRun = (_command, args) => args[1] === "gui/501"
    ? { status: 0, stdout: "domain is queryable" }
    : { status: 113, stderr: "not found" };
  try {
    await assert.rejects(verifyThinSetupUninstalled({
      version,
      homeDir: root,
      platform: "darwin",
      uid: 501,
      deadlineMs: 0,
      readRuntime: () => runtime,
      run: (_command, args) => args[1] === "gui/501" || args[1]?.endsWith("companion.pill")
        ? { status: 0, stdout: "loaded" }
        : { status: 113, stderr: "not found" },
      processRows: () => ({ ok: true, rows: [] }),
    }), /service registrations still active: work\.relay\.companion\.pill/);

    await assert.rejects(verifyThinSetupUninstalled({
      version,
      homeDir: root,
      platform: "darwin",
      uid: 501,
      readRuntime: () => runtime,
      run: absentLabelRun,
      processRows: () => ({ ok: false, rows: [], reason: "service-process-query-failed" }),
    }), /Could not inspect installed Relay processes.*service-process-query-failed/);

    await assert.rejects(verifyThinSetupUninstalled({
      version,
      homeDir: root,
      platform: "darwin",
      uid: 501,
      deadlineMs: 0,
      readRuntime: () => runtime,
      run: absentLabelRun,
      processRows: () => ({ ok: true, rows: [{ pid: 4242, command: "installed Relay daemon" }] }),
    }), /installed Relay service processes still running: 4242/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public release owns immutable publication while private promotion owns fleet activation", () => {
  const localPublicWorkflow = new URL("../.github/workflows/release.yml", import.meta.url);
  const templatedPublicWorkflow = new URL("../public-release/.github/workflows/release.yml", import.meta.url);
  const publish = fs.readFileSync(fs.existsSync(localPublicWorkflow) ? localPublicWorkflow : templatedPublicWorkflow, "utf8");
  assert.match(publish, /workflow_dispatch/);
  assert.doesNotMatch(publish, /\n\s*push:/);
  assert.doesNotMatch(publish, /^concurrency:/m, "platform builds must not wait behind protected publication");
  assert.match(
    publish,
    /release:\n\s+needs: \[identity, runtime\][\s\S]{0,300}concurrency:\n\s+group: relay-companion-publication\n\s+cancel-in-progress: false[\s\S]{0,160}environment: companion-candidate/,
  );
  assert.match(publish, /s3api put-object/);
  assert.match(publish, /--if-none-match '\*'/);
  assert.match(publish, /npm publish .*--provenance/);
  assert.match(publish, /test\/session-routing\.test\.mjs/);
  assert.match(publish, /test\/task-completion-wake\.test\.mjs/);
  assert.match(publish, /test\/runtime-capabilities\.test\.mjs/);
  assert.match(publish, /waiting for npm provenance to propagate/);
  assert.doesNotMatch(publish, /verify-thin-setup-canary/);
  assert.match(publish, /existing npm version has different bytes/);
  const monotonicPublicationChecks = [...publish.matchAll(/node scripts\/assert-monotonic-version\.mjs/g)]
    .map((match) => match.index);
  assert.equal(monotonicPublicationChecks.length, 2, "publication rechecks the live npm build channel twice");
  const immutableUploadIndex = publish.indexOf("s3api put-object");
  const npmPublishIndex = publish.indexOf("npm publish");
  assert.ok(monotonicPublicationChecks[0] < immutableUploadIndex, "stale approval fails before immutable upload");
  assert.ok(
    monotonicPublicationChecks[1] > immutableUploadIndex && monotonicPublicationChecks[1] < npmPublishIndex,
    "npm build is rechecked immediately before npm publication",
  );
  assert.match(publish, /npm view relay-companion dist-tags\.build --prefer-online/g);
  assert.match(publish, /tar -tzf "\$tarball" > "\$RUNNER_TEMP\/pack-files\.txt"/);
  assert.doesNotMatch(publish, /tar -tzf "\$tarball" \| grep/);
  assert.doesNotMatch(publish, /companion-releases\/stable\/manifest\.json/);
  const privatePromotion = new URL("../../../.github/workflows/promote-prod.yml", import.meta.url);
  if (fs.existsSync(privatePromotion)) {
    const promote = fs.readFileSync(privatePromotion, "utf8");
    assert.match(promote, /\(cd "\$runtime_prefix" && tar -xzf runtime\.tar\.gz\)/);
    assert.doesNotMatch(promote, /tar -xzf "\$runtime_prefix\/runtime\.tar\.gz"/);
    assert.match(promote, /verify-installed-runtime\.mjs/);
    assert.match(promote, /assert-runtime-capabilities\.mjs/);
    assert.match(promote, /thin-installer\) TAG=installer/);
    assert.match(promote, /thin installer must never replace bridge latest/);
    assert.match(promote, /companion-releases\/stable\/manifest\.json/);
    assert.match(promote, /--key "companion-releases\/stable\/manifest\.json"/);
    assert.doesNotMatch(promote, /CURRENT_STABLE="\$\(curl/);
    assert.match(promote, /s3api get-object[\s\S]{0,1600}elif grep -q 'NoSuchKey'/);
    assert.match(promote, /could not read the authoritative stable runtime pointer/);
    assert.doesNotMatch(promote, /if \[ "\$TAG" = "latest" \][\s\S]{0,300}stable\/manifest/);
  }
  for (const workflow of ["promote-dev-companion.yml", "promote-companion-dev.yml", "promote-staging.yml"]) {
    const path = new URL(`../../../.github/workflows/${workflow}`, import.meta.url);
    if (!fs.existsSync(path)) continue;
    const source = fs.readFileSync(path, "utf8");
    assert.match(source, /verify-runtime-manifest\.mjs/);
    assert.match(source, /assert-runtime-capabilities\.mjs/);
    assert.match(source, /relay-runtime-\$VERSION-linux-x64\.tar\.gz/);
    if (workflow === "promote-dev-companion.yml") {
      assert.match(source, /waiting for npm dev to converge to \$VERSION/);
      assert.match(source, /npm view relay-companion dist-tags\.dev --prefer-online/);
    }
  }
  const catchupPromotion = new URL("../../../.github/workflows/promote-legacy-catchup.yml", import.meta.url);
  if (fs.existsSync(privatePromotion)) {
    assert.equal(fs.existsSync(catchupPromotion), true, "the isolated legacy catch-up workflow must exist");
  }
  if (fs.existsSync(catchupPromotion)) {
    const catchup = fs.readFileSync(catchupPromotion, "utf8");
    assert.match(catchup, /name: Promote legacy Companion catch-up/);
    assert.match(catchup, /group: relay-production-deploy/);
    assert.match(catchup, /relayDistribution\)" = bridge-runtime/);
    assert.match(catchup, /dist-tags\.dev/);
    assert.match(catchup, /dist-tags\.staging/);
    assert.match(catchup, /0\.1\.267/);
    assert.match(catchup, /0\.1\.326/);
    assert.match(catchup, /require_known_manual_intervention "\$RUN_267" 0\.1\.267/);
    assert.match(catchup, /require_success_canary "\$RUN_326" 0\.1\.326/);
    assert.match(catchup, /canonical update failed at install: candidate-install-failed \(env: node: No such file or directory\)/);
    assert.deepEqual(
      catchup.match(/npm dist-tag add[^\n]+/g),
      ['npm dist-tag add "relay-companion@$VERSION" latest'],
      "legacy catch-up may contain exactly one npm channel mutation, and it must move latest",
    );
    assert.match(catchup, /test "\$installer" = "\$EXPECTED_INSTALLER"/);
    assert.match(catchup, /test "\$stable" = "\$EXPECTED_STABLE"/);
    assert.doesNotMatch(catchup, /id-token:\s*write/);
    assert.doesNotMatch(catchup, /configure-aws-credentials|aws s3|apprunner|cloudformation|secrets\.AWS_/);
  }
  const recoveryCanary = new URL("../../../.github/workflows/verify-companion-dev-update.yml", import.meta.url);
  if (fs.existsSync(privatePromotion)) {
    assert.equal(fs.existsSync(recoveryCanary), true, "the stock recovery canary workflow must exist");
  }
  if (fs.existsSync(recoveryCanary)) {
    const canary = fs.readFileSync(recoveryCanary, "utf8");
    assert.match(canary, /npm view "relay-companion@\$FROM_VERSION" relayDistribution/);
    assert.match(canary, /if \[ "\$from_distribution" = thin-installer \]/);
    assert.match(canary, /npm install --global --no-audit --no-fund "relay-companion@\$FROM_VERSION"/);
    assert.match(canary, /npx --yes --no-audit --no-fund "relay-companion@\$FROM_VERSION" setup/);
  }
  const privateImport = new URL("../../../.github/workflows/publish-companion.yml", import.meta.url);
  if (fs.existsSync(privateImport)) {
    const importWorkflow = fs.readFileSync(privateImport, "utf8");
    assert.match(importWorkflow, /\(cd "\$root" && tar -xzf runtime\.tar\.gz\)/);
    assert.doesNotMatch(importWorkflow, /tar -xzf "\$archive"/);
    assert.match(importWorkflow, /npx --yes --no-audit --no-fund "relay-companion@\$VERSION" setup/);
    const canaryStepIndex = importWorkflow.indexOf("Exercise the exact published setup");
    const canaryStep = importWorkflow.slice(canaryStepIndex);
    assert.ok(canaryStepIndex >= 0);
    assert.match(canaryStep, /DISTRIBUTION: \$\{\{ inputs\.distribution \}\}/);
    assert.match(canaryStep, /dead_setup_pid=2147483000/);
    assert.match(canaryStep, /transaction\.lock\/owner\.json/);
    const canaryHostIndex = importWorkflow.indexOf('mkdir -p "$CODEX_HOME"');
    const canarySetupIndex = importWorkflow.indexOf('npx --yes --no-audit --no-fund "relay-companion@$VERSION" setup');
    assert.ok(canaryHostIndex >= 0 && canaryHostIndex < canarySetupIndex, "the isolated canary host exists before setup");
    assert.match(importWorkflow, /verify-thin-setup-canary\.mjs/);
    assert.match(importWorkflow, /--expect-uninstalled/);
    assert.match(importWorkflow, /uninstall --no-trampoline/);
    assert.doesNotMatch(importWorkflow, /relay-companion@latest|uninstall --purge/);
    assert.doesNotMatch(importWorkflow, /sudo install[^\n]*chrome-sandbox|sha256sum[^\n]*chrome-sandbox/);
  }
});

test("public export includes every script its release security suite imports", () => {
  assert.equal(fs.existsSync(new URL("../scripts/assert-runtime-capabilities.mjs", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../scripts/assert-monotonic-version.mjs", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../scripts/prepare-linux-electron-sandbox.mjs", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../scripts/verify-thin-setup-canary.mjs", import.meta.url)), true);
  const exporter = new URL("../scripts/export-public-release.mjs", import.meta.url);
  if (fs.existsSync(exporter)) {
    assert.match(fs.readFileSync(exporter, "utf8"), /"assert-runtime-capabilities\.mjs"/);
    assert.match(fs.readFileSync(exporter, "utf8"), /"prepare-linux-electron-sandbox\.mjs"/);
  }
  const verifier = fs.readFileSync(new URL("../scripts/verify-installed-runtime.mjs", import.meta.url), "utf8");
  assert.match(verifier, /assertRuntimeCapabilities\(root\)/);
  assert.match(verifier, /prepareLinuxElectronSandbox\(\{ electronPath: verified\.electronPath, platform \}\)/);
  assert.doesNotMatch(verifier, /["']--no-sandbox["']/);
});
