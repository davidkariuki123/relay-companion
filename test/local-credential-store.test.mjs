import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const localStore = createRequire(import.meta.url)("../src/local-credential-store.cjs");
const credentialStore = createRequire(import.meta.url)("../src/credential-store.cjs");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-credentials-"));
  return { root, file: path.join(root, "credentials.json") };
}

test("owner-only local credentials round-trip independently by service and account", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = { file, service: "work.relay.one", account: "device" };
  const second = { file, service: "work.relay.two", account: "authorization" };

  assert.equal(localStore.writeCredential("secret-one", first).ok, true);
  assert.equal(localStore.writeCredential("secret-two", second).ok, true);
  assert.deepEqual(localStore.readCredential(first), { ok: true, value: "secret-one", detail: "" });
  assert.deepEqual(localStore.readCredential(second), { ok: true, value: "secret-two", detail: "" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);

  assert.equal(localStore.deleteCredential(first).ok, true);
  assert.equal(localStore.readCredential(first).code, "credential_not_found");
  assert.equal(localStore.readCredential(second).value, "secret-two");
});

test("local credentials fail closed on broad permissions, symlinks, and hard links", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { file, service: "work.relay", account: "device" };
  assert.equal(localStore.writeCredential("secret", target).ok, true);

  fs.chmodSync(file, 0o644);
  assert.equal(localStore.readCredential(target).code, "credential_store_permissions");
  fs.chmodSync(file, 0o600);

  const hard = path.join(root, "hard-link.json");
  fs.linkSync(file, hard);
  assert.match(localStore.readCredential(target).detail, /hard links/);
  fs.rmSync(hard);

  const real = path.join(root, "real.json");
  fs.renameSync(file, real);
  fs.symlinkSync(real, file);
  assert.match(localStore.readCredential(target).detail, /regular file/);
});

test("macOS legacy migration probes without reading a poisoned Keychain", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const options = {
    platform: "darwin",
    file,
    homeDir: root,
    service: "work.relay.companion",
    account: "device-token-existing",
    run: (command, args) => {
      calls.push({ command, args });
      if (args.includes("show-keychain-info")) return { status: 51, stderr: "authentication failed" };
      throw new Error("a poisoned Keychain must never reach a password operation");
    },
  };
  assert.equal(credentialStore.readDeviceToken(options).code, "credential_unavailable");
  assert.equal(calls.length, 1);
});

test("a healthy legacy macOS credential migrates once and future reads never touch Keychain", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const options = {
    platform: "darwin",
    file,
    homeDir: root,
    service: "work.relay.companion",
    account: "device-token-existing",
    run: (_command, args) => {
      calls.push(args);
      if (args.includes("show-keychain-info")) return { status: 0, stdout: "" };
      if (args.includes("find-generic-password")) return { status: 0, stdout: "legacy-secret\n" };
      if (args.includes("delete-generic-password")) return { status: 0, stdout: "" };
      return { status: 1, stderr: "unexpected command" };
    },
  };

  assert.deepEqual(credentialStore.readDeviceToken(options), { ok: true, value: "legacy-secret", detail: "" });
  assert.ok(calls.some((args) => args.includes("find-generic-password")));
  const migratedCallCount = calls.length;
  assert.deepEqual(credentialStore.readDeviceToken(options), { ok: true, value: "legacy-secret", detail: "" });
  assert.equal(calls.length, migratedCallCount, "the migrated local read never consults Keychain again");
});

test("a fresh generic macOS credential never probes Keychain", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = credentialStore.readCredential({
    platform: "darwin",
    file,
    service: "work.relay.new-feature",
    account: "new-secret",
    run: () => { throw new Error("fresh credentials must not invoke Keychain"); },
  });
  assert.equal(result.code, "credential_not_found");
});

test("local credentials reject unbounded secrets and stores", (t) => {
  const { root, file } = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { file, service: "work.relay", account: "bounded" };
  assert.equal(localStore.writeCredential("x".repeat(localStore.MAX_SECRET_BYTES + 1), target).ok, false);
  fs.writeFileSync(file, " ".repeat(localStore.MAX_STORE_BYTES + 1), { mode: 0o600 });
  assert.equal(localStore.readCredential(target).code, "credential_store_corrupt");
});
