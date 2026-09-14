import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  pairedAccountConfig,
  replacedDeviceCredential,
  revokeReplacedDevice,
  revokeSignedOutDevice,
  signedOutAccountConfig,
} from "../src/account.js";

const { installationKey, machineIdentifier, INSTALLATION_KEY_PATTERN } = createRequire(import.meta.url)("../src/installation-key.cjs");

const WINDOWS_GUID = "    MachineGuid    REG_SZ    8f1c2a4e-1111-4b2b-9c3d-0123456789ab\r\n";
const OTHER_WINDOWS_GUID = "    MachineGuid    REG_SZ    2b7d9e10-2222-4c4c-8d8d-ba9876543210\r\n";
const MAC_IOREG = '  "IOPlatformUUID" = "A1B2C3D4-0000-1111-2222-333344445555"\n';

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installation-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the installation key is stable for one installation on one machine", async (t) => {
  const homeDir = tempHome(t);
  const options = { homeDir, platform: "win32", hostname: "MSI", run: async () => WINDOWS_GUID };
  const first = await installationKey(options);
  assert.match(first, INSTALLATION_KEY_PATTERN);
  assert.equal(await installationKey(options), first, "a re-pair of the same computer sends the same key");
  assert.ok(fs.existsSync(path.join(homeDir, ".relay", "installation-id.json")));
});

test("genuinely different devices never share an installation key", async (t) => {
  const laptopHome = tempHome(t);
  const laptop = await installationKey({ homeDir: laptopHome, platform: "win32", hostname: "MSI", run: async () => WINDOWS_GUID });

  // A VM cloned from the laptop carries the same installation-id.json. Its own
  // machine identifier (or, for a clone that kept the source GUID, its new
  // hostname) makes its key different.
  const clonedHome = tempHome(t);
  fs.mkdirSync(path.join(clonedHome, ".relay"), { recursive: true });
  fs.copyFileSync(path.join(laptopHome, ".relay", "installation-id.json"), path.join(clonedHome, ".relay", "installation-id.json"));
  const clonedVm = await installationKey({ homeDir: clonedHome, platform: "win32", hostname: "MSI", run: async () => OTHER_WINDOWS_GUID });
  const clonedWithoutSysprep = await installationKey({ homeDir: clonedHome, platform: "win32", hostname: "MSI-VM", run: async () => WINDOWS_GUID });
  assert.notEqual(clonedVm, laptop);
  assert.notEqual(clonedWithoutSysprep, laptop);

  // A second Relay installation on the same machine (another OS user, or a
  // purged and reinstalled Companion) has its own installation id.
  const secondUser = await installationKey({ homeDir: tempHome(t), platform: "win32", hostname: "MSI", run: async () => WINDOWS_GUID });
  assert.notEqual(secondUser, laptop);

  // WSL on the same laptop reports its own Linux machine id.
  const wsl = await installationKey({
    homeDir: laptopHome, platform: "linux", hostname: "MSI",
    readFile: () => "0123456789abcdef0123456789abcdef\n",
  });
  assert.notEqual(wsl, laptop);
});

test("macOS keys ignore the network-dependent hostname", async (t) => {
  const homeDir = tempHome(t);
  const run = async () => MAC_IOREG;
  const onWifi = await installationKey({ homeDir, platform: "darwin", hostname: "Davids-MacBook-Pro.local", run });
  const onCampus = await installationKey({ homeDir, platform: "darwin", hostname: "2a-d-aa-81-88-34.lan.uct.ac.za", run });
  assert.match(onWifi, INSTALLATION_KEY_PATTERN);
  assert.equal(onCampus, onWifi);
});

test("an unidentifiable machine sends no key, so nothing is ever merged", async (t) => {
  const homeDir = tempHome(t);
  assert.equal(await installationKey({ homeDir, platform: "win32", hostname: "MSI", run: async () => null }), null);
  assert.equal(await installationKey({ homeDir, platform: "linux", hostname: "box", readFile: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(await installationKey({ homeDir, platform: "freebsd", hostname: "box" }), null);
  assert.equal(await installationKey({ homeDir, platform: "win32", readInstallationId: () => { throw new Error("read-only home"); }, run: async () => WINDOWS_GUID }), null);
  assert.equal(await machineIdentifier({ platform: "darwin", run: async () => "no uuid here" }), null);
});

test("the account config remembers which installation issued its credential, and sign-out forgets it", () => {
  const paired = pairedAccountConfig({ installationKey: "ik_stale" }, {
    registration: { deviceToken: "dev_a", deviceId: "dev_1", user: { id: "usr_1" }, installationKey: `ik_${"a".repeat(40)}` },
  });
  assert.equal(paired.installationKey, `ik_${"a".repeat(40)}`);
  const legacy = pairedAccountConfig({ installationKey: "ik_stale" }, { registration: { deviceToken: "dev_b", deviceId: "dev_2", user: null } });
  assert.equal("installationKey" in legacy, false, "a credential without a key never inherits an old one");
  assert.equal("installationKey" in signedOutAccountConfig(paired), false);
});

const KEY = `ik_${"b".repeat(40)}`;
const OTHER_KEY = `ik_${"c".repeat(40)}`;

function recordingClient() {
  const calls = [];
  const makeClient = async (url, token) => ({
    revokeSelf: async (options) => { calls.push({ url, token, options }); },
  });
  return { calls, makeClient };
}

test("a re-pair or Switch Account revokes the replaced device with its own token", async () => {
  const { calls, makeClient } = recordingClient();
  const previous = replacedDeviceCredential({ deviceToken: "dev_old", deviceId: "dev_1", apiUrl: "https://api.sendrelays.com", installationKey: KEY });
  const result = await revokeReplacedDevice(previous, { deviceToken: "dev_new", deviceId: "dev_2", installationKey: KEY }, { makeClient });
  assert.equal(result, "revoked");
  assert.deepEqual(calls, [{ url: "https://api.sendrelays.com", token: "dev_old", options: { timeoutMs: 5000 } }]);
});

test("a credential copied in from another machine is never revoked", async () => {
  const { calls, makeClient } = recordingClient();
  // A cloned VM re-pairing: its config holds the laptop's live token, issued
  // under the laptop's key. The VM's registration carries its own key.
  const copied = replacedDeviceCredential({ deviceToken: "dev_laptop", deviceId: "dev_laptop_row", installationKey: KEY });
  assert.equal(await revokeReplacedDevice(copied, { deviceToken: "dev_vm", deviceId: "dev_vm_row", installationKey: OTHER_KEY }, { makeClient }), "not_this_installation");
  assert.equal(await revokeReplacedDevice(copied, { deviceToken: "dev_vm", deviceId: "dev_vm_row" }, { makeClient }), "not_this_installation");
  // Credentials from before installation keys existed are left alone too.
  const legacy = replacedDeviceCredential({ deviceToken: "dev_legacy", deviceId: "dev_legacy_row" });
  assert.equal(await revokeReplacedDevice(legacy, { deviceToken: "dev_new", deviceId: "dev_new_row", installationKey: KEY }, { makeClient }), "not_this_installation");
  assert.deepEqual(calls, []);
});

test("replaced-device revocation skips the same device and never throws", async () => {
  const { calls, makeClient } = recordingClient();
  const previous = replacedDeviceCredential({ deviceToken: "dev_same", deviceId: "dev_1", installationKey: KEY });
  assert.equal(await revokeReplacedDevice(previous, { deviceToken: "dev_same", deviceId: "dev_1", installationKey: KEY }, { makeClient }), "same_device");
  assert.equal(await revokeReplacedDevice(null, { deviceToken: "dev_new", installationKey: KEY }, { makeClient }), "none");
  assert.equal(replacedDeviceCredential({ deviceToken: "web_not_a_device" }), null);
  assert.deepEqual(calls, []);

  const rejected = async () => ({ revokeSelf: async () => { throw Object.assign(new Error("gone"), { status: 401 }); } });
  const offline = async () => ({ revokeSelf: async () => { throw new Error("ECONNRESET"); } });
  const next = { deviceToken: "dev_new", deviceId: "dev_2", installationKey: KEY };
  const old = replacedDeviceCredential({ deviceToken: "dev_old", deviceId: "dev_1", installationKey: KEY });
  assert.equal(await revokeReplacedDevice(old, next, { makeClient: rejected }), "already_revoked", "the server already replaced it");
  assert.equal(await revokeReplacedDevice(old, next, { makeClient: offline }), "failed");
});

test("sign-out revokes this computer's device only when this installation issued it", async () => {
  const { calls, makeClient } = recordingClient();
  const config = { deviceToken: "dev_signed_in", deviceId: "dev_1", apiUrl: "https://dev-api.sendrelays.com", installationKey: KEY };
  assert.equal(await revokeSignedOutDevice(config, { currentKey: KEY, makeClient }), "revoked");
  assert.equal(await revokeSignedOutDevice(config, { currentKey: OTHER_KEY, makeClient }), "not_this_installation", "a copied config never revokes the original machine");
  assert.equal(await revokeSignedOutDevice(config, { currentKey: null, makeClient }), "not_this_installation");
  assert.equal(await revokeSignedOutDevice({ ...config, installationKey: "" }, { currentKey: KEY, makeClient }), "not_this_installation");
  assert.equal(await revokeSignedOutDevice({}, { currentKey: KEY, makeClient }), "none");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "dev_signed_in");
});
