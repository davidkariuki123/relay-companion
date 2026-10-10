import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { LOOPBACK_CALLBACK_PATH, signedInPage, startLoopbackSignInListener } from "../src/loopback-signin.js";
import { createInstallationAuthorizationController } from "../src/installation-authorization.js";

const CODE = `ilc_${"c".repeat(43)}`;

function request(port, path, { method = "GET", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function callbackPath(listener, code = CODE, state = listener.state) {
  return `${LOOPBACK_CALLBACK_PATH}?${new URLSearchParams({ code, state })}`;
}

test("the listener binds loopback only and accepts exactly one valid callback", async () => {
  const codes = [];
  const listener = await startLoopbackSignInListener({
    onCode: async (code) => { codes.push(code); return { html: signedInPage({ platform: "darwin", inviterName: "Sam <b>" }) }; },
  });
  try {
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/relay\/signin-complete$/);
    assert.match(listener.state, /^[A-Za-z0-9_-]{43}$/);

    assert.equal((await request(listener.port, "/")).status, 404);
    assert.equal((await request(listener.port, "/relay/signin-complete/extra")).status, 404);
    assert.equal((await request(listener.port, callbackPath(listener), { method: "POST" })).status, 405);
    assert.equal((await request(listener.port, callbackPath(listener, CODE, "x".repeat(43)))).status, 400, "wrong state");
    assert.equal((await request(listener.port, callbackPath(listener, "ilc_short"))).status, 400, "malformed code");
    assert.equal((await request(listener.port, `${LOOPBACK_CALLBACK_PATH}?code=${CODE}`)).status, 400, "missing state");
    assert.equal((await request(listener.port, callbackPath(listener), { host: "evil.example" })).status, 400, "DNS rebinding Host");
    assert.equal((await request(listener.port, callbackPath(listener), { host: `localhost:${listener.port}` })).status, 400);
    assert.deepEqual(codes, [], "no rejected request reaches the code handler");

    const done = await request(listener.port, callbackPath(listener));
    assert.equal(done.status, 200);
    assert.match(done.headers["content-type"], /^text\/html/);
    assert.equal(done.headers["cache-control"], "no-store");
    assert.equal(done.headers["referrer-policy"], "no-referrer");
    assert.match(done.headers["content-security-policy"], /default-src 'none'/);
    assert.match(done.body, /You’re signed in\./);
    assert.match(done.body, /Relay is open on your Mac\./);
    assert.match(done.body, /Sam &lt;b&gt; is now in your contacts/);
    assert.match(done.body, /prefers-color-scheme:dark/);
    assert.equal(done.body.includes(CODE), false, "the code is never echoed");
    assert.deepEqual(codes, [CODE]);

    await listener.closed;
    assert.equal(listener.isOpen(), false, "one-shot: the listener closes after its callback");
    await assert.rejects(request(listener.port, callbackPath(listener)), /ECONNREFUSED/);
  } finally {
    await listener.close();
  }
});

test("a failed redemption sends the browser to the website's Connect fallback", async () => {
  const fallbackUrl = "https://sendrelays.com/activate/iauth_test_123456?handoff=failed";
  const listener = await startLoopbackSignInListener({ fallbackUrl, onCode: async () => { throw new Error("invalid_loopback_code"); } });
  const response = await request(listener.port, callbackPath(listener));
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, fallbackUrl);
  await listener.closed;
});

test("a slow redemption still answers the browser, and the listener times out on its own", async () => {
  const slow = await startLoopbackSignInListener({
    fallbackUrl: "https://sendrelays.com/activate/x?handoff=failed",
    callbackTimeoutMs: 50,
    onCode: () => new Promise(() => {}),
  });
  const response = await request(slow.port, callbackPath(slow));
  assert.equal(response.status, 303);
  await slow.closed;

  const idle = await startLoopbackSignInListener({ timeoutMs: 1000, onCode: async () => ({}) });
  const started = Date.now();
  await idle.closed;
  assert.ok(Date.now() - started >= 900, "closes at its lifetime, not before");
  await assert.rejects(request(idle.port, callbackPath(idle)), /ECONNREFUSED/);
});

// --- Controller: the loopback replaces the browser's Connect click -----------

const NOW = Date.now();
const EXPIRES = new Date(NOW + 15 * 60 * 1000).toISOString();
const AUTHORIZATION_ID = "iauth_test_123456";
const CLIENT_SECRET = `ias_${"s".repeat(48)}`;
const ACTIVATION_URL = `https://sendrelays.com/activate/${AUTHORIZATION_ID}#activationToken=iaa_${"a".repeat(48)}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStores() {
  let durable = null;
  let secret = null;
  return {
    peekDurable: () => (durable ? structuredClone(durable) : null),
    durableStore: {
      read: () => (durable ? structuredClone(durable) : null),
      write: (value) => { durable = structuredClone(value); },
      remove: () => { durable = null; },
    },
    secretStore: {
      read: () => (secret ? { ok: true, value: structuredClone(secret) } : { ok: false, detail: "missing" }),
      write: (value) => { secret = structuredClone(value); return { ok: true }; },
      delete: () => { secret = null; return { ok: true }; },
    },
  };
}

function fakeApi({ loopbackRoute = "ok", approve = "ok" } = {}) {
  const calls = [];
  const server = { status: "pending_identity", loopback: null, challenge: "" };
  const fetchImpl = async (url, init) => {
    const route = new URL(String(url)).pathname.replace(`/v1/installation-authorizations/${AUTHORIZATION_ID}`, "") || "/create";
    const body = JSON.parse(init.body);
    calls.push({ route, body });
    if (route === "/v1/installation-authorizations") {
      server.challenge = body.codeChallenge;
      return json({ authorizationId: AUTHORIZATION_ID, clientSecret: CLIENT_SECRET, activationUrl: ACTIVATION_URL, expiresAt: EXPIRES });
    }
    if (route === "/status") return json({ status: server.status, expiresAt: EXPIRES, ...(server.status !== "pending_identity" ? { account: { email: "alex@example.com", displayName: "Alex" } } : {}) });
    if (route === "/loopback") {
      if (loopbackRoute === "missing") return json({ error: "Not Found", statusCode: 404 }, 404);
      server.loopback = { redirectUri: body.redirectUri, state: body.state };
      return json({ status: "registered" });
    }
    if (route === "/loopback-approve") {
      assert.equal(createHash("sha256").update(body.codeVerifier).digest("base64url"), server.challenge, "the app proves PKCE");
      if (approve === "invalid") return json({ error: "invalid_loopback_code" }, 400);
      if (approve === "lost") { server.status = "approved"; throw new TypeError("socket hang up"); }
      server.status = "approved";
      return json({ status: "approved", onboardingContext: { outcome: "added", inviter: { name: "Sam", relayUserId: "usr_sam" } } });
    }
    if (route === "/consume") {
      server.status = "consumed";
      return json({ deviceToken: "dev_token", deviceId: "dev_1", user: { id: "usr_alex", email: "alex@example.com", name: "Alex" } });
    }
    return json({ error: "unexpected" }, 500);
  };
  return { calls, server, fetchImpl };
}

function controllerFor(api, overrides = {}) {
  const stores = memoryStores();
  const opened = [];
  const approvedEvents = [];
  const persisted = [];
  const controller = createInstallationAuthorizationController({
    apiBase: "https://api.sendrelays.com",
    webBase: "https://sendrelays.com",
    platform: "darwin",
    approvalSurface: "browser-v1",
    deviceName: "Alex's Mac",
    isPaired: () => persisted.length > 0,
    durableStore: stores.durableStore,
    secretStore: stores.secretStore,
    installationKey: async () => null,
    persistAccount: async (registration) => { persisted.push(registration); },
    fetchImpl: api.fetchImpl,
    openExternal: async (url) => { opened.push(url); return true; },
    onLoopbackApproved: async (state) => { approvedEvents.push(state); },
    loopbackHeartbeatMs: 60_000,
    ...overrides,
  });
  return { controller, stores, opened, approvedEvents, persisted };
}

async function browserHandsOff(api, code = CODE) {
  const { redirectUri, state } = api.server.loopback;
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return request(Number(url.port), `${url.pathname}${url.search}`);
}

test("loopback happy path: listen and register before the browser opens, approve with PKCE, then consume as before", async () => {
  const api = fakeApi();
  const { controller, stores, opened, approvedEvents, persisted } = controllerFor(api);
  try {
    await controller.google();
    const order = api.calls.map((call) => call.route);
    assert.deepEqual(order.slice(0, 2), ["/v1/installation-authorizations", "/loopback"], "registered before the browser opened");
    assert.equal(opened.length, 1);
    assert.equal(api.calls[1].body.clientSecret, CLIENT_SECRET);
    assert.match(api.calls[1].body.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/relay\/signin-complete$/);
    assert.equal(JSON.stringify(stores.peekDurable()).includes(api.calls[1].body.state), false, "listener state stays in memory");

    api.server.status = "pending_approval"; // the browser bound the Google identity
    assert.equal((await controller.state()).status, "pending_approval");

    const page = await browserHandsOff(api);
    assert.equal(page.status, 200);
    assert.match(page.body, /You’re signed in\./);
    assert.match(page.body, /Sam is now in your contacts\. No message was sent\./);
    const approveCall = api.calls.find((call) => call.route === "/loopback-approve");
    assert.deepEqual(Object.keys(approveCall.body).sort(), ["clientSecret", "code", "codeVerifier"]);
    assert.equal(approveCall.body.code, CODE);
    assert.equal(stores.peekDurable().status, "approved");
    assert.deepEqual(stores.peekDurable().onboardingContext, { inviter: { name: "Sam", relayUserId: "usr_sam" } });
    assert.equal(approvedEvents.length, 1, "the app is asked to come forward");
    assert.equal(persisted.length, 0, "consumption stays with the pill's state/resume path");

    const resumed = await controller.resume();
    assert.equal(resumed.status, "consumed");
    assert.equal(persisted.length, 1);
    await assert.rejects(browserHandsOff(api), /ECONNREFUSED/, "the listener is gone");
  } finally {
    controller.close();
  }
});

test("a rejected code sends the browser back to Connect and the app never listens again for that setup", async () => {
  const api = fakeApi({ approve: "invalid" });
  const { controller, stores, approvedEvents } = controllerFor(api);
  try {
    await controller.google();
    api.server.status = "pending_approval";
    const response = await browserHandsOff(api);
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, `https://sendrelays.com/activate/${AUTHORIZATION_ID}?handoff=failed`);
    assert.equal(stores.peekDurable().status, "pending_approval");
    assert.equal(approvedEvents.length, 0);
    const registrations = api.calls.filter((call) => call.route === "/loopback").length;
    await controller.state();
    assert.equal(api.calls.filter((call) => call.route === "/loopback").length, registrations, "no new listener");
  } finally {
    controller.close();
  }
});

test("a lost approval response is recovered from status, not by approving twice", async () => {
  const api = fakeApi({ approve: "lost" });
  const { controller, stores } = controllerFor(api);
  try {
    await controller.google();
    api.server.status = "pending_approval";
    const page = await browserHandsOff(api);
    assert.equal(page.status, 200);
    assert.equal(stores.peekDurable().status, "approved");
    assert.equal(api.calls.filter((call) => call.route === "/loopback-approve").length, 1);
  } finally {
    controller.close();
  }
});

test("an API without the loopback route keeps today's browser flow and stops asking", async () => {
  const api = fakeApi({ loopbackRoute: "missing" });
  const { controller, opened } = controllerFor(api);
  try {
    await controller.google();
    assert.equal(opened.length, 1, "the browser still opens");
    api.server.status = "pending_approval";
    await controller.state();
    await controller.state();
    assert.equal(api.calls.filter((call) => call.route === "/loopback").length, 1, "one refused registration, no retry loop");
  } finally {
    controller.close();
  }
});

test("setups approved inside the app never open a loopback listener", async () => {
  const api = fakeApi();
  const { controller, opened } = controllerFor(api, { approvalSurface: undefined });
  try {
    await controller.google();
    assert.equal(opened.length, 1);
    assert.equal(api.calls.some((call) => call.route === "/loopback"), false);
  } finally {
    controller.close();
  }
});

test("restarted mid-sign-in, the app listens again from its status poll", async () => {
  const api = fakeApi();
  const first = controllerFor(api);
  await first.controller.google();
  first.controller.close(); // the app quit; durable and protected state survive
  const relaunched = createInstallationAuthorizationController({
    apiBase: "https://api.sendrelays.com",
    webBase: "https://sendrelays.com",
    platform: "darwin",
    approvalSurface: "browser-v1",
    isPaired: () => false,
    durableStore: first.stores.durableStore,
    secretStore: first.stores.secretStore,
    fetchImpl: api.fetchImpl,
    loopbackHeartbeatMs: 60_000,
  });
  try {
    const before = api.server.loopback.state;
    api.server.status = "pending_approval";
    await relaunched.state();
    assert.notEqual(api.server.loopback.state, before, "a fresh listener registered");
    const page = await browserHandsOff(api);
    assert.equal(page.status, 200);
  } finally {
    relaunched.close();
  }
});
