import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createInstallationAuthorizationController,
  createNativeInstallationSecretStore,
} from "../src/installation-authorization.js";

const NOW = Date.parse("2026-08-20T10:00:00.000Z");
const EXPIRES = "2026-08-20T10:15:00.000Z";
const AUTHORIZATION_ID = "iauth_test_123456";
const CLIENT_SECRET = `ias_${"s".repeat(48)}`;
const ACTIVATION_TOKEN = `iaa_${"a".repeat(48)}`;
const ACTIVATION_URL = `https://sendrelays.com/activate/${AUTHORIZATION_ID}#activationToken=${ACTIVATION_TOKEN}`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStores(seed = {}) {
  let durable = seed.durable ? structuredClone(seed.durable) : null;
  let secret = seed.secret ? structuredClone(seed.secret) : null;
  const events = [];
  return {
    events,
    peekDurable: () => (durable ? structuredClone(durable) : null),
    peekSecret: () => (secret ? structuredClone(secret) : null),
    durableStore: {
      read: () => (durable ? structuredClone(durable) : null),
      write: (value) => { durable = structuredClone(value); events.push("durable:write"); },
      remove: () => { durable = null; events.push("durable:remove"); },
    },
    secretStore: {
      read: () => secret ? { ok: true, value: structuredClone(secret) } : { ok: false, detail: "missing" },
      write: (value) => { secret = structuredClone(value); events.push("secret:write"); return { ok: true }; },
      delete: () => { secret = null; events.push("secret:delete"); return { ok: true }; },
    },
  };
}

function createReply() {
  return {
    authorizationId: AUTHORIZATION_ID,
    clientSecret: CLIENT_SECRET,
    activationUrl: ACTIVATION_URL,
    expiresAt: EXPIRES,
  };
}

function harness({ stores = memoryStores(), fetchImpl, ...overrides } = {}) {
  const calls = [];
  const fetcher = fetchImpl || (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return response(createReply());
  });
  const controller = createInstallationAuthorizationController({
    apiBase: "https://api.sendrelays.com",
    webBase: "https://sendrelays.com",
    platform: "darwin",
    deviceName: "Alex's Mac",
    now: () => NOW,
    isPaired: () => false,
    durableStore: stores.durableStore,
    secretStore: stores.secretStore,
    fetchImpl: fetcher,
    ...overrides,
  });
  return { controller, stores, calls };
}

test("begin creates S256 PKCE and keeps every capability out of durable and renderer state", async () => {
  const { controller, stores, calls } = harness();
  const state = await controller.begin();

  assert.deepEqual(state, { status: "pending_identity", expiresAt: EXPIRES });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.sendrelays.com/v1/installation-authorizations");
  assert.deepEqual(
    { deviceName: calls[0].body.deviceName, platform: calls[0].body.platform, method: calls[0].body.codeChallengeMethod },
    { deviceName: "Alex's Mac", platform: "darwin", method: "S256" },
  );
  const secret = stores.peekSecret();
  assert.match(secret.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(secret.codeVerifier).digest("base64url"), calls[0].body.codeChallenge);
  assert.equal(secret.clientSecret, CLIENT_SECRET);
  assert.equal(secret.activationUrl, ACTIVATION_URL);

  const durableText = JSON.stringify(stores.peekDurable());
  const publicText = JSON.stringify(state);
  for (const capability of [CLIENT_SECRET, ACTIVATION_TOKEN, ACTIVATION_URL, secret.codeVerifier]) {
    assert.equal(durableText.includes(capability), false);
    assert.equal(publicText.includes(capability), false);
  }
  assert.ok(stores.events.indexOf("secret:write") < stores.events.indexOf("durable:write"));
});

test("begin preflights native storage before creating a server authorization", async () => {
  const stores = memoryStores();
  stores.secretStore.probe = () => ({
    ok: false,
    value: "",
    detail: "native credential store is locked or unavailable",
    code: "credential_unavailable",
  });
  const { controller, calls } = harness({ stores });
  await assert.rejects(controller.begin(), (error) => {
    assert.equal(error.code, "credential_unavailable");
    assert.match(error.message, /Check its permissions/);
    return true;
  });
  assert.equal(calls.length, 0, "no server capability is created while the local vault is unavailable");
  assert.equal(stores.peekDurable(), null);
  assert.equal(stores.peekSecret(), null);
});

test("native authorization cleanup preserves its sentinel after a partial field deletion", () => {
  const credentials = new Map([
    ["authorization-id", AUTHORIZATION_ID],
    ["client-secret", CLIENT_SECRET],
    ["code-verifier", "v".repeat(43)],
    ["activation-token", ACTIVATION_TOKEN],
    ["authorization", "legacy"],
  ]);
  const deleted = [];
  const store = createNativeInstallationSecretStore({
    readCredentialImpl: ({ account }) => credentials.has(account)
      ? { ok: true, value: credentials.get(account) }
      : { ok: false, code: "credential_not_found", detail: "missing" },
    deleteCredentialImpl: ({ account }) => {
      deleted.push(account);
      if (account === "code-verifier") {
        return { ok: false, code: "credential_unavailable", detail: "vault locked" };
      }
      credentials.delete(account);
      return { ok: true, value: "", detail: "" };
    },
  });

  assert.equal(store.delete().ok, false);
  assert.deepEqual(deleted, ["client-secret", "code-verifier"]);
  assert.equal(credentials.has("authorization-id"), true, "the residue sentinel survives partial cleanup");
  assert.deepEqual(store.inspect(), { ok: true, present: true, value: "", detail: "" });
});

test("a durable-state commit and cleanup failure leaves fail-closed authorization residue", async () => {
  const stores = memoryStores();
  stores.durableStore.write = () => { throw new Error("disk unavailable"); };
  stores.secretStore.delete = () => ({
    ok: false,
    code: "credential_unavailable",
    detail: "vault locked",
  });
  const { controller, calls } = harness({ stores });

  await assert.rejects(controller.begin(), (error) => {
    assert.equal(error.code, "credential_unavailable");
    assert.match(error.message, /roll back/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.ok(stores.peekSecret(), "the residue remains detectable instead of being treated as fresh setup");
  assert.equal(stores.peekDurable(), null);
});

test("begin does not reinterpret an unreadable paired credential as a new account", async () => {
  const { controller, calls } = harness({
    isPaired: () => {
      const error = new Error("saved account credential is unavailable");
      error.code = "credential_unavailable";
      throw error;
    },
  });
  await assert.rejects(controller.begin(), /saved account credential is unavailable/);
  assert.equal(calls.length, 0);
});

test("begin is serialized and resumes the same authorization after a restart", async () => {
  let creates = 0;
  const stores = memoryStores();
  const fetchImpl = async (_url, init) => {
    creates += 1;
    JSON.parse(init.body);
    return response(createReply());
  };
  const first = harness({ stores, fetchImpl }).controller;
  await Promise.all([first.begin(), first.begin(), first.begin()]);
  const restarted = harness({ stores, fetchImpl }).controller;
  await restarted.begin();
  assert.equal(creates, 1);
});

test("begin preserves an approved capability and resume finishes it without minting or re-approving", async () => {
  const stores = memoryStores({
    durable: {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      expiresAt: EXPIRES,
      status: "approved",
      account: { email: "alex@example.com", displayName: "Alex" },
    },
    secret: {
      authorizationId: AUTHORIZATION_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: "v".repeat(43),
      activationUrl: ACTIVATION_URL,
    },
  });
  let creates = 0;
  let approvals = 0;
  let consumes = 0;
  let persisted = 0;
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/v1/installation-authorizations") { creates += 1; return response(createReply()); }
    if (route.endsWith("/approve")) { approvals += 1; return response({ status: "approved" }); }
    if (route.endsWith("/consume")) {
      consumes += 1;
      return response({
        deviceId: "dev_recovered",
        deviceToken: "dev_recovered_secret",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com" },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const { controller } = harness({
    stores,
    fetchImpl,
    persistAccount: async () => { persisted += 1; },
  });

  assert.equal((await controller.begin()).status, "approved");
  assert.deepEqual({ creates, approvals, consumes, persisted }, { creates: 0, approvals: 0, consumes: 0, persisted: 0 });
  assert.equal((await controller.resume()).status, "consumed");
  assert.deepEqual({ creates, approvals, consumes, persisted }, { creates: 0, approvals: 0, consumes: 1, persisted: 1 });
});

test("resume preserves the explicit human approval boundary", async () => {
  const stores = memoryStores({
    durable: {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      expiresAt: EXPIRES,
      status: "pending_approval",
      account: { email: "alex@example.com", displayName: "Alex" },
    },
    secret: {
      authorizationId: AUTHORIZATION_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: "v".repeat(43),
      activationUrl: ACTIVATION_URL,
    },
  });
  let approvals = 0;
  let consumes = 0;
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/status")) return response({
      status: "pending_approval",
      expiresAt: EXPIRES,
      account: { email: "alex@example.com", displayName: "Alex" },
    });
    if (route.endsWith("/approve")) approvals += 1;
    if (route.endsWith("/consume")) consumes += 1;
    return response({ status: "approved" });
  };
  const { controller } = harness({ stores, fetchImpl });
  assert.equal((await controller.resume()).status, "pending_approval");
  assert.deepEqual({ approvals, consumes }, { approvals: 0, consumes: 0 });
  assert.equal(stores.peekDurable().status, "pending_approval");
});

test("resume recovers a lost explicit-approval response using status then idempotent consume", async () => {
  const stores = memoryStores({
    durable: {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      expiresAt: EXPIRES,
      status: "pending_approval",
      account: { email: "alex@example.com", displayName: "Alex" },
    },
    secret: {
      authorizationId: AUTHORIZATION_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: "v".repeat(43),
      activationUrl: ACTIVATION_URL,
    },
  });
  let approvals = 0;
  let consumes = 0;
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/status")) return response({
      status: "approved",
      expiresAt: EXPIRES,
      account: { email: "alex@example.com", displayName: "Alex" },
    });
    if (route.endsWith("/approve")) { approvals += 1; return response({ status: "approved" }); }
    if (route.endsWith("/consume")) {
      consumes += 1;
      return response({
        deviceId: "dev_recovered",
        deviceToken: "dev_recovered_secret",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com" },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const { controller } = harness({ stores, fetchImpl, persistAccount: async () => {} });
  assert.equal((await controller.resume()).status, "consumed");
  assert.deepEqual({ approvals, consumes }, { approvals: 0, consumes: 1 });
});

test("restart fails closed before minting when authorization-secret deletion fails", async () => {
  const stores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "expired" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  stores.secretStore.delete = () => ({ ok: false, detail: "vault locked" });
  const { controller, calls } = harness({ stores });

  await assert.rejects(controller.restart(), /protected storage/);
  assert.equal(calls.length, 0, "replacement is not minted while the old secret remains");
  assert.ok(stores.peekDurable());
  assert.ok(stores.peekSecret());
});

test("an authorization secret without public state requires explicit restart before replacement", async () => {
  const stores = memoryStores({
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  const { controller, calls } = harness({ stores });
  await assert.rejects(controller.begin(), (error) => {
    assert.equal(error.code, "setup_restart_required");
    return true;
  });
  assert.equal(calls.length, 0);
  assert.ok(stores.peekSecret());

  assert.equal((await controller.restart()).status, "pending_identity");
  assert.equal(calls.length, 1);
  assert.equal(stores.peekDurable().status, "pending_identity");
});

test("restart touches only authorization state, deletes it before minting, and never runs for a paired account", async () => {
  const stores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "expired" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  let createEventIndex = -1;
  const { controller } = harness({
    stores,
    fetchImpl: async () => {
      createEventIndex = stores.events.length;
      return response(createReply());
    },
  });
  assert.equal((await controller.restart()).status, "pending_identity");
  assert.ok(stores.events.indexOf("secret:delete") < createEventIndex);
  assert.ok(stores.events.indexOf("durable:remove") < createEventIndex);

  const pairedStores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "expired" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  const paired = harness({ stores: pairedStores, isPaired: () => true });
  await assert.rejects(paired.controller.restart(), /already connected/);
  assert.equal(paired.calls.length, 0);
  assert.ok(pairedStores.peekDurable());
  assert.ok(pairedStores.peekSecret());
  assert.deepEqual(pairedStores.events, []);
});

test("Google opens only the trusted browser URL and optional account chooser without exposing it", async () => {
  const opened = [];
  const { controller } = harness({ openExternal: async (url) => { opened.push(url); return true; } });
  await controller.begin();
  const state = await controller.google({ forceAccountSelection: true });

  assert.deepEqual(state, { status: "pending_identity", expiresAt: EXPIRES });
  assert.equal(Object.hasOwn(state, "activationUrl"), false);
  const target = new URL(opened[0]);
  const fragment = new URLSearchParams(target.hash.slice(1));
  assert.equal(target.origin, "https://sendrelays.com");
  assert.equal(fragment.get("activationToken"), ACTIVATION_TOKEN);
  assert.equal(fragment.get("switchAccount"), "1");
});

test("dev and staging validate activation against the configured first-party web origin", async () => {
  const stores = memoryStores();
  const opened = [];
  const controller = createInstallationAuthorizationController({
    apiBase: "http://127.0.0.1:4000",
    webBase: "http://localhost:3000",
    platform: "darwin",
    deviceName: "Test Mac",
    now: () => NOW,
    isPaired: () => false,
    durableStore: stores.durableStore,
    secretStore: stores.secretStore,
    openExternal: async (url) => { opened.push(url); return true; },
    fetchImpl: async () => response({
      ...createReply(),
      activationUrl: `http://localhost:3000/activate/${AUTHORIZATION_ID}#activationToken=${ACTIVATION_TOKEN}`,
    }),
  });
  await controller.begin();
  await controller.google();
  assert.equal(new URL(opened[0]).origin, "http://localhost:3000");
});

test("email verification binds only a public account summary", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(init.body);
    seen.push({ route, body });
    if (route.endsWith("/identity/email/start")) {
      return response({ status: "code_sent", codeExpiresAt: "2026-08-20T10:10:00.000Z" });
    }
    if (route.endsWith("/identity/email/verify")) {
      return response({ status: "pending_approval", account: { email: "alex@example.com", displayName: "Alex" } });
    }
    return response(createReply());
  };
  const { controller, stores } = harness({ fetchImpl });
  await controller.begin();
  assert.deepEqual(await controller.emailStart(" Alex@Example.com "), {
    status: "code_sent",
    codeExpiresAt: "2026-08-20T10:10:00.000Z",
  });
  const verified = await controller.emailVerify("123456");
  assert.deepEqual(verified, {
    status: "pending_approval",
    expiresAt: EXPIRES,
    account: { email: "alex@example.com", displayName: "Alex" },
  });
  assert.equal(seen.find((call) => call.route.endsWith("/identity/email/start")).body.email, "alex@example.com");
  assert.equal(seen.find((call) => call.route.endsWith("/identity/email/verify")).body.code, "123456");
  assert.equal(JSON.stringify(stores.peekDurable()).includes(CLIENT_SECRET), false);
});

test("explicit approval serializes consume, persists once, cleans the capability, and connects", async () => {
  const counts = { approve: 0, consume: 0, persist: 0, connected: 0 };
  let verifier = "";
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (route === "/v1/installation-authorizations") return response(createReply());
    if (route.endsWith("/approve")) { counts.approve += 1; return response({ status: "approved" }); }
    if (route.endsWith("/consume")) {
      counts.consume += 1;
      verifier = body.codeVerifier;
      return response({
        deviceId: "dev_test",
        deviceToken: "dev_secret_token",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com", accountKind: "human", isDeveloper: false },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const stores = memoryStores();
  const { controller } = harness({
    stores,
    fetchImpl,
    persistAccount: async (registration) => {
      counts.persist += 1;
      assert.equal(registration.deviceToken, "dev_secret_token");
    },
    onConnected: async () => { counts.connected += 1; },
  });
  await controller.begin();
  const originalVerifier = stores.peekSecret().codeVerifier;
  stores.durableStore.write({
    ...stores.peekDurable(),
    status: "pending_approval",
    account: { email: "alex@example.com", displayName: "Alex" },
  });
  const results = await Promise.all([controller.approve(), controller.approve(), controller.approve()]);

  assert.deepEqual(counts, { approve: 1, consume: 1, persist: 1, connected: 1 });
  assert.equal(verifier, originalVerifier);
  assert.equal(stores.peekSecret(), null);
  assert.equal(stores.peekDurable(), null);
  assert.equal(JSON.stringify(results).includes("dev_secret_token"), false);
  assert.equal(results[0].status, "consumed");
});

test("a failed consume retains approved state and the PKCE capability for an explicit retry", async () => {
  let consumeAttempts = 0;
  const stores = memoryStores();
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/v1/installation-authorizations") return response(createReply());
    if (route.endsWith("/approve")) return response({ status: "approved" });
    if (route.endsWith("/consume")) {
      consumeAttempts += 1;
      if (consumeAttempts === 1) return response({ error: "temporarily_unavailable" }, 503);
      return response({
        deviceId: "dev_test",
        deviceToken: "dev_secret_token",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com", accountKind: "human", isDeveloper: false },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const { controller } = harness({ stores, fetchImpl, persistAccount: async () => {} });
  await controller.begin();
  stores.durableStore.write({ ...stores.peekDurable(), status: "pending_approval" });

  await assert.rejects(controller.approve(), /temporarily_unavailable/);
  assert.equal(stores.peekDurable().status, "approved");
  assert.ok(stores.peekSecret().codeVerifier);
  await controller.approve();
  assert.equal(consumeAttempts, 2);
});

test("lost consume response recovery skips re-approval when durable status is consumed", async () => {
  const stores = memoryStores({
    durable: {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      expiresAt: EXPIRES,
      status: "consumed",
      account: { email: "alex@example.com", displayName: "Alex" },
    },
    secret: {
      authorizationId: AUTHORIZATION_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: "v".repeat(43),
      activationUrl: ACTIVATION_URL,
    },
  });
  let approvals = 0;
  let consumes = 0;
  let persisted = 0;
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/approve")) { approvals += 1; return response({ error: "authorization_consumed" }, 409); }
    if (route.endsWith("/consume")) {
      consumes += 1;
      return response({
        deviceId: "dev_recovered",
        deviceToken: "dev_recovered_secret",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com", accountKind: "human", isDeveloper: false },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const { controller } = harness({
    stores,
    fetchImpl,
    persistAccount: async () => { persisted += 1; },
  });
  assert.equal((await controller.begin()).status, "consumed", "begin resumes the recovery receipt instead of replacing it");
  assert.equal((await controller.resume()).status, "consumed");
  assert.equal(approvals, 0);
  assert.equal(consumes, 1);
  assert.equal(persisted, 1);
});

test("a consumed-state commit failure leaves account persistence untouched and retries consume safely", async () => {
  const stores = memoryStores();
  const write = stores.durableStore.write;
  let failConsumedCommit = true;
  stores.durableStore.write = (value) => {
    if (value.status === "consumed" && failConsumedCommit) {
      failConsumedCommit = false;
      throw new Error("disk unavailable");
    }
    write(value);
  };
  let approvals = 0;
  let consumes = 0;
  let persisted = 0;
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/v1/installation-authorizations") return response(createReply());
    if (route.endsWith("/approve")) { approvals += 1; return response({ status: "approved" }); }
    if (route.endsWith("/consume")) {
      consumes += 1;
      return response({
        deviceId: "dev_recovered",
        deviceToken: "dev_recovered_secret",
        user: { id: "usr_test", name: "Alex", email: "alex@example.com", accountKind: "human", isDeveloper: false },
      });
    }
    throw new Error(`unexpected ${route}`);
  };
  const { controller } = harness({
    stores,
    fetchImpl,
    persistAccount: async () => { persisted += 1; },
  });
  await controller.begin();
  stores.durableStore.write({ ...stores.peekDurable(), status: "pending_approval" });
  await assert.rejects(controller.approve(), /disk unavailable/);
  assert.equal(stores.peekDurable().status, "approved");
  assert.ok(stores.peekSecret());
  assert.equal(persisted, 0);
  assert.equal((await controller.approve()).status, "consumed");
  assert.deepEqual({ approvals, consumes, persisted }, { approvals: 1, consumes: 2, persisted: 1 });
});

test("polling survives restart, expiry purges the capability, and cancel fails closed", async () => {
  const stores = memoryStores({
    durable: {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      expiresAt: EXPIRES,
      status: "pending_identity",
    },
    secret: {
      authorizationId: AUTHORIZATION_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: "v".repeat(43),
      activationUrl: ACTIVATION_URL,
    },
  });
  const fetchImpl = async () => response({
    status: "pending_approval",
    expiresAt: EXPIRES,
    account: { email: "alex@example.com", displayName: "Alex" },
  });
  const restarted = harness({ stores, fetchImpl }).controller;
  assert.equal((await restarted.state()).status, "pending_approval");

  const expired = harness({ stores, fetchImpl, now: () => Date.parse(EXPIRES) + 1 }).controller;
  assert.equal((await expired.state()).status, "expired");
  assert.equal(stores.peekSecret(), null);
  assert.equal(stores.peekDurable().status, "expired", "a secret-free tombstone requires an explicit Restart across relaunches");
  assert.equal((await expired.begin()).status, "expired", "ordinary Begin cannot replace the tombstone");

  const failingStores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "pending_identity" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  failingStores.secretStore.delete = () => ({ ok: false, detail: "vault locked" });
  const failing = harness({ stores: failingStores }).controller;
  await assert.rejects(failing.cancel(), /protected storage/);
  assert.ok(failingStores.peekDurable(), "durable record stays so deletion can be retried");
  assert.ok(failingStores.peekSecret(), "capability is not silently orphaned");
});

test("cancel is serialized behind an in-flight poll and cannot be undone by its late response", async () => {
  const stores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "pending_identity" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  let releasePoll;
  let pollStarted;
  const started = new Promise((resolve) => { pollStarted = resolve; });
  const fetchImpl = async () => {
    pollStarted();
    await new Promise((resolve) => { releasePoll = resolve; });
    return response({
      status: "pending_approval",
      expiresAt: EXPIRES,
      account: { email: "alex@example.com", displayName: "Alex" },
    });
  };
  const { controller } = harness({ stores, fetchImpl });
  const poll = controller.state();
  await started;
  const cancelled = controller.cancel();
  releasePoll();
  assert.equal((await poll).status, "pending_approval");
  assert.deepEqual(await cancelled, { status: "idle" });
  assert.equal(stores.peekDurable(), null);
  assert.equal(stores.peekSecret(), null);
});
