import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  deviceNameForPairing,
  normalizePairingCode,
  pairedAccountConfig,
  persistPairedAccount,
  persistSignedOutAccount,
  signedOutAccountConfig,
} from "../src/account.js";
import { configPath, readConfig, readConfigState, writeConfigObject } from "../src/config.js";

const localCredentialStore = createRequire(import.meta.url)("../src/local-credential-store.cjs");

const REGISTRATION = {
  deviceToken: "dev_token_new",
  deviceId: "dev_new",
  user: { id: "usr_new", name: "Josh", email: "josh@example.com" },
};

function withConfigEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-account-test-"));
  const previousDir = process.env.RELAY_CONFIG_DIR;
  const previousFile = process.env.RELAY_CONFIG;
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CONFIG;
  try {
    return fn(dir);
  } finally {
    if (previousDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousDir;
    if (previousFile === undefined) delete process.env.RELAY_CONFIG;
    else process.env.RELAY_CONFIG = previousFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizePairingCode folds typed variants onto the server's alphabet", () => {
  assert.equal(normalizePairingCode(" abcd-efgh "), "ABCDEFGH");
  assert.equal(normalizePairingCode("AB CD\tEF GH"), "ABCDEFGH");
  assert.equal(normalizePairingCode("m2p3-q4r5"), "M2P3Q4R5");
  assert.equal(normalizePairingCode(""), "");
  assert.equal(normalizePairingCode(null), "");
  assert.equal(normalizePairingCode(undefined), "");
});

test("pairedAccountConfig layers fresh credentials over the existing config", () => {
  const next = pairedAccountConfig(
    { apiUrl: "https://api.old", webUrl: "https://web.old", companionMode: "messages-only", extra: "kept" },
    { deviceName: "Joshs-Mac", registration: REGISTRATION },
  );
  assert.deepEqual(next, {
    apiUrl: "https://api.old",
    webUrl: "https://web.old",
    extra: "kept",
    deviceName: "Joshs-Mac",
    deviceToken: "dev_token_new",
    deviceId: "dev_new",
    user: REGISTRATION.user,
  });
});

test("pairedAccountConfig only touches the URLs when they are explicitly given", () => {
  const preserved = pairedAccountConfig({ apiUrl: "https://api.old" }, { registration: REGISTRATION });
  assert.equal(preserved.apiUrl, "https://api.old");
  assert.equal("webUrl" in preserved, false);
  const overridden = pairedAccountConfig(
    { apiUrl: "https://api.old" },
    { apiUrl: "https://api.new", webUrl: "https://web.new", registration: REGISTRATION },
  );
  assert.equal(overridden.apiUrl, "https://api.new");
  assert.equal(overridden.webUrl, "https://web.new");
});

test("signedOutAccountConfig clears the credential set and preserves everything else", () => {
  const next = signedOutAccountConfig({
    apiUrl: "https://api.old",
    webUrl: "https://web.old",
    deviceName: "Joshs-Mac",
    companionMode: "full",
    features: { requests: true },
    deviceToken: "dev_token_old",
    deviceId: "dev_old",
    user: { id: "usr_old", email: "old@example.com" },
  });
  assert.deepEqual(next, {
    apiUrl: "https://api.old",
    webUrl: "https://web.old",
    deviceName: "Joshs-Mac",
  });
});

test("deviceNameForPairing prefers the remembered name and falls back to the hostname", () => {
  assert.equal(deviceNameForPairing({ deviceName: "Joshs-Mac" }), "Joshs-Mac");
  assert.equal(deviceNameForPairing({ deviceName: "   " }), os.hostname());
  assert.equal(deviceNameForPairing({}), os.hostname());
});

test("persistPairedAccount then persistSignedOutAccount round-trips config.json", () => {
  withConfigEnv(() => {
    persistPairedAccount({
      apiUrl: "https://api.example",
      webUrl: "https://web.example",
      deviceName: "Joshs-Mac",
      registration: REGISTRATION,
    });
    const paired = readConfig();
    assert.equal(paired.deviceToken, "dev_token_new");
    assert.equal(paired.deviceId, "dev_new");
    assert.equal(paired.user.email, "josh@example.com");
    assert.equal(paired.deviceName, "Joshs-Mac");

    persistSignedOutAccount();
    const signedOut = readConfig();
    assert.deepEqual(signedOut, {
      apiUrl: "https://api.example",
      webUrl: "https://web.example",
      deviceName: "Joshs-Mac",
    });
  });
});

test("new credentials and legacy plaintext migrate to protected storage without leaving secrets in config.json", () => {
  withConfigEnv(() => {
    let nativeToken = "";
    const credentialBackend = {
      writeDeviceToken: (token) => { nativeToken = token; return { ok: true }; },
      readDeviceToken: () => ({ ok: true, value: nativeToken }),
    };
    writeConfigObject({ deviceToken: "dev_secure", deviceId: "dev_1", user: { id: "usr_1" } }, { credentialBackend });
    const disk = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    assert.equal(disk.deviceToken, undefined);
    assert.equal(disk.credentialStore, process.platform === "darwin" ? "local-v2" : "native-v1");
    assert.equal(nativeToken, "dev_secure");
    assert.equal(readConfig({ credentialBackend }).deviceToken, "dev_secure");

    fs.writeFileSync(configPath(), JSON.stringify({ deviceToken: "legacy_plaintext", deviceId: "legacy" }));
    const migrated = readConfig({ credentialBackend });
    assert.equal(migrated.deviceToken, "legacy_plaintext");
    assert.equal(nativeToken, "legacy_plaintext");
    assert.equal(JSON.parse(fs.readFileSync(configPath(), "utf8")).deviceToken, undefined);
  });
});

test("credential migration is rollback-safe when the native vault is unavailable", () => {
  withConfigEnv(() => {
    fs.writeFileSync(configPath(), JSON.stringify({ deviceToken: "keep_plaintext", deviceId: "legacy" }));
    const credentialBackend = {
      writeDeviceToken: () => ({ ok: false, detail: "vault locked" }),
      readDeviceToken: () => ({ ok: false, value: "" }),
    };
    assert.equal(readConfig({ credentialBackend }).deviceToken, "keep_plaintext");
    assert.equal(JSON.parse(fs.readFileSync(configPath(), "utf8")).deviceToken, "keep_plaintext");
  });
});

test("a native credential pointer keeps paired recovery states distinct from first run", () => {
  withConfigEnv(() => {
    const writePointer = (version) => fs.writeFileSync(configPath(), JSON.stringify({
      credentialStore: "native-v1",
      credentialVersion: version,
      credentialAccount: `device-token-${version}`,
      deviceId: "dev_existing",
      user: { id: "usr_existing", email: "existing@example.com" },
    }));

    writePointer("locked");
    const locked = readConfigState({ credentialBackend: {
      readDeviceToken: () => ({ ok: false, value: "", code: "credential_unavailable" }),
    } });
    assert.equal(locked.credential.status, "unavailable");
    assert.equal(locked.config.user.email, "existing@example.com");

    writePointer("missing");
    const missing = readConfigState({ credentialBackend: {
      readDeviceToken: () => ({ ok: false, value: "", code: "credential_not_found" }),
    } });
    assert.equal(missing.credential.status, "missing");

    writePointer("empty");
    const corrupt = readConfigState({ credentialBackend: {
      readDeviceToken: () => ({ ok: true, value: "" }),
    } });
    assert.equal(corrupt.credential.status, "corrupt");

    writePointer("available");
    const available = readConfigState({ credentialBackend: {
      readDeviceToken: () => ({ ok: true, value: "dev_existing_token" }),
    } });
    assert.equal(available.credential.status, "available");
    assert.equal(available.config.deviceToken, "dev_existing_token");
  });
});

test("a migrated macOS credential atomically advances its config pointer to local-v2", { skip: process.platform !== "darwin" }, () => {
  withConfigEnv((dir) => {
    const account = "device-token-legacy-marker-test";
    fs.writeFileSync(configPath(), JSON.stringify({
      credentialStore: "native-v1",
      credentialVersion: "legacy-marker-test",
      credentialAccount: account,
      deviceId: "dev_existing",
      user: { id: "usr_existing" },
    }));
    assert.equal(localCredentialStore.writeCredential("existing-secret", {
      file: path.join(dir, "credentials.v2.json"),
      service: "work.relay.companion",
      account,
    }).ok, true);

    const state = readConfigState();
    assert.equal(state.credential.status, "available");
    assert.equal(state.config.deviceToken, "existing-secret");
    assert.equal(state.config.credentialStore, "local-v2");
    assert.equal(JSON.parse(fs.readFileSync(configPath(), "utf8")).credentialStore, "local-v2");
  });
});

test("a corrupt account config is a recovery state, not a fresh unpaired machine", () => {
  withConfigEnv((dir) => {
    fs.writeFileSync(configPath(), "{broken account config");
    const state = readConfigState();
    assert.equal(state.credential.status, "corrupt");
    assert.equal(state.credential.code, "config_corrupt");
    assert.equal(state.config.deviceToken, undefined);
    assert.equal(
      fs.readdirSync(dir).some((name) => name.startsWith("config.json.corrupt-")),
      true,
      "the damaged file is preserved before recovery is offered",
    );
  });
});

test("installation authorization requires protected storage and never falls back to config plaintext", () => {
  withConfigEnv(() => {
    const unavailable = {
      writeDeviceToken: () => ({ ok: false, detail: "vault locked" }),
      readDeviceToken: () => ({ ok: false, value: "" }),
      deleteDeviceToken: () => ({ ok: true }),
    };
    assert.throws(
      () => persistPairedAccount({
        registration: REGISTRATION,
        requireNativeCredential: true,
        credentialBackend: unavailable,
      }),
      /store Relay's device credential securely/,
    );
    assert.equal(fs.existsSync(configPath()), false);

    let nativeToken = "";
    const available = {
      writeDeviceToken: (token) => { nativeToken = token; return { ok: true }; },
      readDeviceToken: () => ({ ok: true, value: nativeToken }),
      deleteDeviceToken: () => { nativeToken = ""; return { ok: true }; },
    };
    persistPairedAccount({
      registration: REGISTRATION,
      requireNativeCredential: true,
      credentialBackend: available,
    });
    const disk = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    assert.equal(nativeToken, REGISTRATION.deviceToken);
    assert.equal(disk.deviceToken, undefined);
    assert.equal(disk.credentialStore, process.platform === "darwin" ? "local-v2" : "native-v1");
  });
});

test("credential replacement commits a versioned vault pointer before deleting the previous token", () => {
  withConfigEnv(() => {
    const oldConfig = {
      credentialStore: "native-v1",
      credentialVersion: "old",
      credentialAccount: "device-token-old",
      deviceId: "dev_old",
      user: { id: "usr_old", email: "old@example.com" },
    };
    fs.writeFileSync(configPath(), JSON.stringify(oldConfig));
    const vault = new Map([["device-token-old", "dev_old_token"]]);
    const deleted = [];
    const backend = {
      writeDeviceToken: (token, options) => { vault.set(options.account, token); return { ok: true }; },
      readDeviceToken: (options) => ({ ok: vault.has(options.account), value: vault.get(options.account) || "" }),
      deleteDeviceToken: (options) => { deleted.push(options.account); vault.delete(options.account); return { ok: true }; },
    };
    assert.throws(() => writeConfigObject(
      { ...oldConfig, deviceToken: "dev_new_token", deviceId: "dev_new", user: REGISTRATION.user },
      { credentialBackend: backend, requireNativeCredential: true, atomicWrite: () => { throw new Error("disk full"); } },
    ), /disk full/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath(), "utf8")), oldConfig);
    assert.equal(vault.get("device-token-old"), "dev_old_token", "the authoritative old token survives rollback");
    assert.equal([...vault.values()].includes("dev_new_token"), false, "only the uncommitted new target is removed");
    assert.equal(deleted.includes("device-token-old"), false);

    writeConfigObject(
      { ...oldConfig, deviceToken: "dev_new_token", deviceId: "dev_new", user: REGISTRATION.user },
      { credentialBackend: backend, requireNativeCredential: true },
    );
    const committed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    assert.notEqual(committed.credentialAccount, "device-token-old");
    assert.equal(vault.get(committed.credentialAccount), "dev_new_token");
    assert.equal(vault.has("device-token-old"), false, "old token is deleted only after config points at the new target");
  });
});

test("sign-out deletes the native credential before removing its config marker", () => {
  withConfigEnv(() => {
    fs.writeFileSync(configPath(), JSON.stringify({
      apiUrl: "https://api.sendrelays.com",
      credentialStore: "native-v1",
      credentialVersion: "one",
      deviceId: "dev_1",
      user: { id: "usr_1" },
    }));
    let deleted = 0;
    persistSignedOutAccount({ credentialBackend: { deleteDeviceToken: () => { deleted += 1; return { ok: true }; } } });
    assert.equal(deleted, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath(), "utf8")), { apiUrl: "https://api.sendrelays.com" });
  });
});

test("sign-out keeps its rollback marker when native credential deletion fails", () => {
  withConfigEnv(() => {
    const original = { credentialStore: "native-v1", credentialVersion: "one", deviceId: "dev_1", user: { id: "usr_1" } };
    fs.writeFileSync(configPath(), JSON.stringify(original));
    assert.throws(
      () => persistSignedOutAccount({ credentialBackend: { deleteDeviceToken: () => ({ ok: false, detail: "vault locked" }) } }),
      /Could not remove Relay credential/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath(), "utf8")), original);
  });
});

test("configPath honors RELAY_CONFIG so the pill and CLI share one file", () => {
  withConfigEnv((dir) => {
    const explicit = path.join(dir, "custom", "config.json");
    process.env.RELAY_CONFIG = explicit;
    assert.equal(configPath(), explicit);
    persistPairedAccount({ registration: REGISTRATION });
    const disk = JSON.parse(fs.readFileSync(explicit, "utf8"));
    assert.equal(disk.deviceToken, undefined);
    assert.equal(disk.credentialStore, process.platform === "darwin" ? "local-v2" : undefined);
    assert.equal(readConfig().deviceToken, "dev_token_new");
  });
});

// The pill's account-switch flow sends people to a URL. If that URL lands on
// Clerk's hosted accounts.<domain> host, the flow is dead on arrival: this
// deployment runs Clerk in proxy mode and those subdomains present no TLS
// certificate at all, so no browser can complete the handshake (field-reported
// as "Safari can't establish a secure connection"). The app's own /sign-in
// route renders through the proxy and carries the user on to setup, so the
// flow must always target that instead.
test("the account-switch flow never targets Clerk's hosted accounts subdomain", async () => {
  const overlay = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const declared = overlay.match(/const SETUP_PATH = "([^"]+)"/);
  assert.ok(declared, "main.cjs must define SETUP_PATH for the switch-account flow");
  const setupPath = declared[1];
  assert.ok(
    !/accounts\./i.test(setupPath),
    `setupPath must not point at a Clerk-hosted accounts subdomain (got ${setupPath})`,
  );
  assert.match(setupPath, /^\/sign-in/, "setupPath should use the app's own sign-in route");
  assert.match(setupPath, /redirect_url=%2Fapp%2Fsetup/, "sign-in must carry the user on to /app/setup");
  // The browser running a switch nearly always still holds the OLD session. Without
  // this flag the sign-in page treats that session as success and hands back the
  // pairing code for the very account the user was trying to leave — the switch
  // silently becomes a no-op.
  assert.match(setupPath, /(^|[?&])switch=1(&|$)/, "the switch flow must announce itself as a switch");
  // The path and the copyable URL are built from the same constant, so the two
  // cannot drift apart.
  assert.match(overlay, /setupPath: SETUP_PATH/);
  assert.match(overlay, /setupUrl: absoluteUrl\(SETUP_PATH\)/);
});

test("account settings opens the first-party identity gateway for the paired account", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const renderer = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const declared = main.match(/const ACCOUNT_SETTINGS_PATH = "([^"]+)"/);
  assert.ok(declared, "main.cjs must define one account-settings gateway");
  assert.equal(declared[1], "/account/settings");
  assert.ok(!/accounts\./i.test(declared[1]));
  assert.match(main, /settingsPath: accountSettingsPath\(user\)/);
  assert.match(main, /query\.set\("account", accountId\)/, "the stable Relay user id must cross the browser boundary");
  assert.match(main, /query\.set\("email", email\)/, "the expected address should explain or prefill a mismatch");
  assert.match(renderer, /settingsInfo\.settingsPath/);
  assert.doesNotMatch(renderer, /openUrl\("\/app\/settings"\)/);
});

test("switch account uses eight code cells and a short clickable setup link", () => {
  const renderer = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

  assert.match(renderer, /Array\.from\(\{ length:8 \}/);
  assert.match(renderer, /class="sv-code-cell"/);
  assert.match(renderer, /Paste your pairing code/);
  assert.match(renderer, /id="svSetupLink">Open here<\/button>/);
  assert.doesNotMatch(renderer, /settingsInfo\s*&&\s*settingsInfo\.setupUrl/);
  assert.doesNotMatch(renderer, /Your browser opened the Relay setup page/);
  assert.doesNotMatch(renderer, /Wrong browser\?/);
});
