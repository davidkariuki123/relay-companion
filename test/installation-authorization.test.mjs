import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInstallationAuthorizationController } from "../src/installation-authorization.js";

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
  assert.equal((await controller.approve()).status, "consumed");
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
  assert.equal(stores.peekDurable(), null);

  const failingStores = memoryStores({
    durable: { schemaVersion: 1, authorizationId: AUTHORIZATION_ID, expiresAt: EXPIRES, status: "pending_identity" },
    secret: { authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, codeVerifier: "v".repeat(43), activationUrl: ACTIVATION_URL },
  });
  failingStores.secretStore.delete = () => ({ ok: false, detail: "vault locked" });
  const failing = harness({ stores: failingStores }).controller;
  await assert.rejects(failing.cancel(), /native credential store/);
  assert.ok(failingStores.peekDurable(), "durable record stays so deletion can be retried");
  assert.ok(failingStores.peekSecret(), "capability is not silently orphaned");
});
