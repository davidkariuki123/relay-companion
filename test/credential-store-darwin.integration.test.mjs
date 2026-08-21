import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { createNativeInstallationSecretStore } from "../src/installation-authorization.js";

const { writeCredential, readCredential, deleteCredential } = createRequire(import.meta.url)(
  "../src/credential-store.cjs",
);

const nativeStoreName = process.platform === "darwin"
  ? "macOS Keychain"
  : process.platform === "win32"
    ? "Windows Credential Manager"
    : "native credential store";
const nativeStoreUnavailable = !["darwin", "win32"].includes(process.platform);

test(`${nativeStoreName} preserves Relay credentials byte for byte`, {
  skip: nativeStoreUnavailable && "native credential store is unavailable",
}, (t) => {
  const options = {
    service: `work.relay.companion.integration.${process.pid}.${Date.now()}`,
    account: "round-trip",
  };
  t.after(() => deleteCredential(options));

  const first = `relay_${randomBytes(48).toString("base64url")}`;
  const second = `relay_${randomBytes(48).toString("base64url")}`;

  assert.equal(writeCredential(first, options).ok, true);
  assert.deepEqual(readCredential(options), { ok: true, value: first, detail: "" });

  assert.equal(writeCredential(second, options).ok, true);
  assert.deepEqual(readCredential(options), { ok: true, value: second, detail: "" });

  if (process.platform === "darwin") {
    assert.match(
      writeCredential("x".repeat(121), options).detail,
      /secure prompt limit/,
      "oversized values fail before macOS can silently truncate them",
    );
    assert.deepEqual(readCredential(options), { ok: true, value: second, detail: "" });
  }

  assert.equal(deleteCredential(options).ok, true);
  assert.equal(readCredential(options).ok, false);
});

test(`${nativeStoreName} round-trips a complete split installation capability`, {
  skip: nativeStoreUnavailable && "native credential store is unavailable",
}, async (t) => {
  const service = `work.relay.companion.installation.integration.${process.pid}.${Date.now()}`;
  const store = createNativeInstallationSecretStore({ webBase: "https://sendrelays.com", service });
  t.after(() => store.delete());

  const authorizationId = `iauth_${randomBytes(24).toString("hex")}`;
  const value = {
    authorizationId,
    clientSecret: `ias_${randomBytes(48).toString("base64url")}`,
    codeVerifier: randomBytes(32).toString("base64url"),
    activationUrl: `https://sendrelays.com/activate/${authorizationId}#activationToken=iaa_${randomBytes(48).toString("base64url")}`,
  };

  assert.equal((await store.write(value)).ok, true);
  assert.deepEqual(await store.read(), { ok: true, value });
  assert.equal((await store.delete()).ok, true);
  assert.equal((await store.read()).ok, false);
});

test(`${nativeStoreName} refuses an incomplete installation capability without leaving native credentials`, {
  skip: nativeStoreUnavailable && "native credential store is unavailable",
}, async (t) => {
  const service = `work.relay.companion.installation.incomplete.${process.pid}.${Date.now()}`;
  const store = createNativeInstallationSecretStore({ webBase: "https://sendrelays.com", service });
  t.after(() => store.delete());

  const result = await store.write({
    authorizationId: "iauth_incomplete",
    clientSecret: "",
    codeVerifier: "verifier_incomplete",
    activationUrl: "https://sendrelays.com/activate/iauth_incomplete#activationToken=token_incomplete",
  });
  assert.equal(result.ok, false);
  assert.equal((await store.read()).ok, false);
});
