import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { prepareCandidate, portableTarInvocation } from "../prepare.mjs";
import migration from "../lib/migration.cjs";

test("Windows extraction accepts both Git Bash tar and Windows bsdtar", () => {
  const invocation = { command: "tar", cwd: "D:\\a\\input", args: ["-xzf", "runtime.tar.gz", "-C", "..\\candidate\\runtime"] };
  assert.deepEqual(portableTarInvocation(invocation, "win32").args, ["-xzf", "runtime.tar.gz", "-C", "../candidate/runtime"]);
  assert.deepEqual(portableTarInvocation(invocation, "linux"), invocation);
});

test("invalid artifact or signature cannot create a candidate or touch an installation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-candidate-verification-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519");
  const version = "0.2.0";
  const sourceSha = "a".repeat(40);
  const digest = `sha512-${crypto.createHash("sha512").update("expected").digest("base64")}`;
  const artifacts = Object.fromEntries(migration.PLATFORMS.map((platform) => [platform, {
    bytes: 8, sha512: digest, dependencyLockSha512: digest,
    url: `https://api.sendrelays.com/v1/companion-releases/v${version}/relay-runtime-${version}-${platform}.tar.gz`,
    sbom: { bytes: 8, sha512: digest, url: `https://api.sendrelays.com/v1/companion-releases/v${version}/relay-runtime-${version}-${platform}.sbom.cdx.json` },
  }]));
  const payload = Buffer.from(JSON.stringify({ product: "Relay", version, sourceSha, artifacts }));
  const envelope = { schema: 1, algorithm: "ED25519_SHA_512", keyId: "relay-runtime-release-v1", payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, keys.privateKey).toString("base64") };
  const manifestFile = path.join(root, "manifest.json");
  const artifactFile = path.join(root, "runtime.tar.gz");
  const outputDir = path.join(root, "candidate");
  const trustStore = { schema: 2, activeKeyId: envelope.keyId, keys: [{ keyId: envelope.keyId, algorithm: envelope.algorithm,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }] };
  fs.writeFileSync(manifestFile, JSON.stringify(envelope));
  fs.writeFileSync(artifactFile, "tampered");
  const options = { manifestFile, artifactFile, outputDir, version, sourceSha, trustStore };
  await assert.rejects(prepareCandidate(options), /digest/);
  assert.equal(fs.existsSync(outputDir), false);
  envelope.signature = Buffer.alloc(64).toString("base64");
  fs.writeFileSync(manifestFile, JSON.stringify(envelope));
  await assert.rejects(prepareCandidate(options), /signature/);
  assert.equal(fs.existsSync(outputDir), false);
  await assert.rejects(prepareCandidate({ ...options, platform: "unsupported" }), /matching OS/);
});

test("online candidates exclude the runtime from resources while retaining verified build inputs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-online-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const write = (name, value) => { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const version = "0.2.0", sourceSha = "a".repeat(40);
  write("node_modules/relay-companion/package.json", JSON.stringify({ name: "relay-companion", version }));
  write("node_modules/relay-companion/runtime-links.json", JSON.stringify({ schema: 1, links: [] }));
  write("node_modules/relay-companion/bootstrap/application-owner.cjs", "// fixture");
  write("node_modules/relay-companion/overlay/deep-link.cjs", "// fixture");
  write("node_modules/relay-companion/overlay/relay.ico", "fixture");
  write("node_modules/electron/package.json", JSON.stringify({ version: "43.4.1" }));
  write("node_modules/electron/dist/fixture", "fixture");
  const artifactFile = path.join(root, "runtime.tar.gz");
  const archive = spawnSync("tar", ["-czf", artifactFile.replaceAll("\\", "/"), "node_modules"], { cwd: source, encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  const bytes = fs.readFileSync(artifactFile), digest = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const artifacts = Object.fromEntries(migration.PLATFORMS.map(platform => [platform, {
    bytes: bytes.length, sha512: digest, dependencyLockSha512: digest,
    url: `https://api.sendrelays.com/v1/companion-releases/v${version}/relay-runtime-${version}-${platform}.tar.gz`,
    sbom: { bytes: 1, sha512: digest, url: `https://api.sendrelays.com/v1/companion-releases/v${version}/relay-runtime-${version}-${platform}.sbom.cdx.json` },
  }]));
  const key = crypto.generateKeyPairSync("ed25519"), keyId = "relay-runtime-release-v1";
  const trustStore = { schema: 2, activeKeyId: keyId, keys: [{ keyId, algorithm: "ED25519_SHA_512", publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  const payload = Buffer.from(JSON.stringify({ product: "Relay", version, sourceSha, artifacts }));
  const manifestFile = path.join(root, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ schema: 1, algorithm: "ED25519_SHA_512", keyId, payload: payload.toString("base64"), signature: crypto.sign(null, payload, key.privateKey).toString("base64") }));
  for (const runtimeDelivery of ["download", "bundled"]) {
    const outputDir = path.join(root, runtimeDelivery);
    const result = await prepareCandidate({ manifestFile, artifactFile, version, sourceSha, outputDir, trustStore,
      mode: "application-candidate", ...(runtimeDelivery === "bundled" ? { runtimeDelivery } : {}) });
    assert.equal(result.runtimeDelivery, runtimeDelivery);
    assert.equal(result.runtimeDownloadBytes, runtimeDelivery === "download" ? bytes.length : 0);
    assert.equal(fs.existsSync(path.join(outputDir, "resources/runtime.tar.gz")), runtimeDelivery === "bundled");
    assert.deepEqual(fs.readFileSync(path.join(outputDir, runtimeDelivery === "download" ? "build-input/runtime.tar.gz" : "resources/runtime.tar.gz")), bytes);
    // The Companion's five-ways card module and fonts ride along under the
    // names the setup page loads them by.
    for (const asset of ["app/five-ways.js", "app/fonts/newsreader-var.woff2", "app/fonts/inter-var.woff2"]) assert.equal(fs.existsSync(path.join(outputDir, asset)), true, asset);
    assert.equal(fs.readFileSync(path.join(outputDir, "app/five-ways.js"), "utf8"),
      fs.readFileSync(path.resolve(import.meta.dirname, "../../../packages/companion/overlay/relay-anyone-tip.cjs"), "utf8"));
  }
});
