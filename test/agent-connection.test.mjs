import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptAgentConnection } from "../src/agent-connection.js";

test("Companion adopts one approved account and recovers a lost registration response with the same proof and keys", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adoption-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = { consentVersion: 2, account: { relayUserId: "usr_test" }, apiUrl: "https://dev-api.sendrelays.com", accessToken: "web_test_only" };
  const registration = { deviceId: "dev_test", deviceToken: "dev_test_only", user: { id: "usr_test" } };
  const enrollments = [];
  let pairings = 0;
  const options = {
    journalFile: path.join(root, "pending.json"), readAgent: () => agent, readCompanion: () => ({}),
    request: async (_url, _token, _method, route, body) => {
      if (route === "/v1/me") return { user: { id: "usr_test" } };
      assert.equal(route, "/v1/agent/companion/pairing-code");
      assert.match(body.recoverySecret, /^[A-Za-z0-9_-]{43}$/);
      pairings++;
      return { code: "ABCDEFGH" };
    },
    createIdentity: () => ({ request: { publicKey: "fixture" }, state: { privateKey: "fixture" } }),
    makeClient: () => ({ registerDevice: async (input) => {
      enrollments.push(input);
      if (enrollments.length === 1) throw new Error("response lost");
      return registration;
    } }),
    persistIdentity: (keys, response) => { assert.equal(keys.privateKey, "fixture"); assert.deepEqual(response, registration); },
    persistAccount: (input) => { assert.equal(input.requireNativeCredential, true); assert.deepEqual(input.registration, registration); },
  };
  await assert.rejects(adoptAgentConnection(options), /response lost/);
  assert.deepEqual(await adoptAgentConnection(options), { connected: true, reused: false });
  assert.equal(pairings, 1);
  assert.deepEqual(enrollments[0], enrollments[1]);
  assert.equal(fs.existsSync(options.journalFile), false);
  await assert.rejects(adoptAgentConnection({ ...options, readAgent: () => ({ ...agent, consentVersion: 1 }) }), /updated Relay connection/);
  await assert.rejects(adoptAgentConnection({ ...options, readCompanion: () => ({ deviceToken: "other", user: { id: "usr_other" }, apiUrl: agent.apiUrl }) }), /another account/);
  await assert.rejects(adoptAgentConnection({ ...options, request: async () => ({ user: { id: "usr_other" } }) }), /does not match/);

  const current = { deviceToken: "dev_existing", user: { id: "usr_test" }, apiUrl: agent.apiUrl };
  assert.deepEqual(await adoptAgentConnection({ ...options, readCompanion: () => current, makeClient: () => ({ me: async () => ({ user: { id: "usr_test" } }) }) }), { connected: true, reused: true });
  let attempts = 0;
  const before = pairings;
  assert.deepEqual(await adoptAgentConnection({ ...options, makeClient: () => ({ registerDevice: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("expired"), { status: 400, body: { message: "Unused pairing code expired" } });
    return registration;
  } }) }), { connected: true, reused: false });
  assert.equal(pairings - before, 2, "renew only a server-confirmed unused code, without another sign-in");
});
