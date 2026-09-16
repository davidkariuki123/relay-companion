import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import release from "../bootstrap/application-release.cjs";

function fixture() {
  const version = "1.0.0", sourceSha = "a".repeat(40);
  const sha512 = `sha512-${crypto.createHash("sha512").update("installer").digest("base64")}`;
  const artifacts = Object.fromEntries(release.PLATFORMS.map((platform) => [platform,
    (platform.startsWith("darwin") ? ["dmg", "zip"] : platform.startsWith("win32") ? ["exe"] : ["deb", "rpm"])
      .map((kind) => ({ kind, bytes: 9, sha512, url: `https://api.sendrelays.com/v1/application-releases/v${version}/Relay-${version}-${platform}.${kind}` }))]));
  return { schema: 1, product: "Relay Application", version, sourceSha, runtime: { version: "0.1.600", sourceSha: "b".repeat(40) }, artifacts };
}

test("a signed Dev pilot can contain selected platforms but cannot become a stable offer", () => {
  const payload = fixture();
  payload.schema = 2; payload.channel = "dev";
  payload.rollout = { nativeUpdates: true, migrateDeviceIds: [], expiresAt: Date.now() + 86400000 };
  payload.artifacts = { "win32-x64": payload.artifacts["win32-x64"] };
  payload.artifacts["win32-x64"][0].url = payload.artifacts["win32-x64"][0].url.replace("api.sendrelays.com/v1/application-releases", "dev-api.sendrelays.com/v1/application-releases/dev");
  assert.equal(release.validateApplicationRelease(payload, { ...payload, channel: "dev" }), payload);
  assert.throws(() => release.validateApplicationRelease(payload, { ...payload, channel: "stable" }), /channel/);
  payload.channel = "stable";
  assert.throws(() => release.validateApplicationRelease(payload, payload));
});

test("native and runtime release identities cannot be substituted", () => {
  const payload = fixture();
  assert.equal(release.validateApplicationRelease(payload, payload), payload);
  assert.throws(() => release.validateApplicationRelease(payload, { ...payload, sourceSha: payload.runtime.sourceSha }), /identity/);
  assert.throws(() => release.validateApplicationRelease({ ...payload, product: "Relay" }, payload), /identity/);
  delete payload.artifacts["linux-arm64"];
  assert.throws(() => release.validateApplicationRelease(payload, payload), /Incomplete/);
});

test("every artifact is source-bound and must use immutable branded version URLs", () => {
  for (const change of [
    (p) => { p.artifacts["win32-x64"][0].url = "https://evil.example/Relay.exe"; },
    (p) => { p.artifacts["win32-x64"][0].bytes = -1; },
    (p) => { p.artifacts["darwin-x64"][1] = p.artifacts["darwin-x64"][0]; },
    (p) => { p.artifacts["win32-x64"][0].url = p.artifacts["win32-x64"][0].url.replace("v1.0.0/", "latest/"); },
  ]) {
    const payload = fixture(); change(payload);
    assert.throws(() => release.validateApplicationRelease(payload, payload));
  }
});

test("application signatures and downloaded bytes must both verify", async (t) => {
  const payload = fixture();
  const keys = crypto.generateKeyPairSync("ed25519");
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { schema: 1, algorithm: "ED25519_SHA_512", keyId: "relay-runtime-release-v1",
    payload: bytes.toString("base64"), signature: crypto.sign(null, bytes, keys.privateKey).toString("base64") };
  const trustStore = { schema: 2, activeKeyId: envelope.keyId, keys: [{ keyId: envelope.keyId, algorithm: envelope.algorithm,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  assert.deepEqual(release.verifyApplicationRelease(envelope, { ...payload, trustStore }), payload);
  assert.throws(() => release.verifyApplicationRelease({ ...envelope, signature: Buffer.alloc(64).toString("base64") }, { ...payload, trustStore }), /signature/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-signature-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "installer.exe");
  fs.writeFileSync(file, "installer");
  assert.equal(await release.verifyApplicationArtifact(file, payload.artifacts["win32-x64"][0]), true);
  fs.writeFileSync(file, "different");
  await assert.rejects(release.verifyApplicationArtifact(file, payload.artifacts["win32-x64"][0]), /digest/);
});
