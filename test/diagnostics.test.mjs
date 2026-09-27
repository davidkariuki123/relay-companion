import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import d from "../bootstrap/diagnostics.cjs";
import reporter from "../bootstrap/diagnostics-reporter.cjs";
import { provisionDiagnostics } from "../src/diagnostics-authorization.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-diagnostics-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const write = (file, value) => { const target = path.join(homeDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(value)); };
  write(".relay/config.json", { user: { id: "usr_one" }, deviceId: "dev_one", updateChannel: "stable", apiUrl: "https://api.sendrelays.com" });
  return { homeDir, write };
}
function auth(homeDir) {
  const identity = d.configIdentity(homeDir);
  assert.ok(reporter.saveAuthorization({ token: "dgt_abc.def", userId: identity.userId, deviceId: identity.deviceId,
    expiresAt: new Date(Date.now() + 86400000).toISOString() }, { ...identity, origin: "https://api.sendrelays.com" }, { homeDir }));
}
test("attempt history survives restart; errors and on-disk records cannot leak raw data", t => {
  const f = fixture(t), attemptId = randomUUID();
  const event = d.record({ component: "updater", stage: "activation", outcome: "failed", attemptId,
    code: new Error("EPERM C:/Users/private-person/token=SECRET"), targetVersion: "0.1.565" }, f);
  assert.equal(event.code, "permission-denied");
  f.write(`.relay/diagnostics/${d.configIdentity(f.homeDir).scope}/events/${event.id}.json`, { ...event, rawError: "SECRET", targetVersion: "SECRET", channel: "SECRET" });
  const readBack = d.events(f.homeDir, d.configIdentity(f.homeDir).scope).map(e => e.value);
  assert.equal(readBack[0].attemptId, attemptId);
  assert.ok(!JSON.stringify(readBack).includes("SECRET"));
  const report = { schema: 1, snapshot: d.snapshot(f), events: readBack };
  assert.equal(report.snapshot.schema, 1);
});
test("storage failure does not throw; unsigned-in installations do not attach history to a future account", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.homeDir, ".relay/config.json"));
  assert.equal(d.record({ code: "timeout" }, f), null);
  f.write(".relay/config.json", { user: { id: "usr_one" }, deviceId: "dev_one" });
  f.write(".relay/diagnostics", {});
  assert.equal(d.record({ code: "timeout" }, f), null);
});
test("history is bounded and reports retention loss", t => {
  const f = fixture(t), now = Date.now();
  for (let i = 0; i < d.MAX_EVENTS + 5; i++) d.record({ component: "recovery", stage: "health", outcome: "failed" }, { ...f, now: () => now + i });
  assert.equal(d.events(f.homeDir, d.configIdentity(f.homeDir).scope).length, d.MAX_EVENTS);
  assert.equal(d.snapshot(f).trimmedEvents, 5);
});
test("healthy polls retain the preceding stages of a failed attempt", t => {
  const f = fixture(t), now = Date.now(), attemptId = randomUUID();
  const started = d.record({ attemptId, stage: "activation", outcome: "started" }, { ...f, now: () => now });
  const failed = d.record({ attemptId, stage: "activation", outcome: "failed", code: "permission-denied" }, { ...f, now: () => now + 1 });
  for (let i = 0; i < 270; i++) d.record({ stage: "health", outcome: "succeeded" }, { ...f, now: () => now + i + 2 });
  const history = d.events(f.homeDir, d.configIdentity(f.homeDir).scope);
  assert.equal(history.length, 256);
  assert.ok(history.some(e => e.value.id === started.id));
  assert.ok(history.some(e => e.value.id === failed.id));
});
test("malformed or expired authorization is rejected before network access", async t => {
  const f = fixture(t), identity = { ...d.configIdentity(f.homeDir), origin: "https://api.sendrelays.com" };
  for (const expiresAt of ["nonsense", null, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 40 * 86400000).toISOString()]) {
    const value = { token: "dgt_abc.def", deviceId: identity.deviceId, userId: identity.userId, expiresAt };
    assert.equal(reporter.saveAuthorization(value, identity, f), false);
    f.write(".relay/diagnostics/authorization.json", { ...value, scope: identity.scope, origin: identity.origin });
    assert.equal((await reporter.report({ ...f, fetchImpl: () => assert.fail("invalid authorization must not send") })).status, "unauthorized");
  }
});
test("snapshot distinguishes advertised, selected, active and retained versions", t => {
  const f = fixture(t);
  f.write(".relay/runtime/current.json", { state: "active", active: true, version: "0.1.553" });
  f.write(".relay/recovery/status.json", { advertisedVersion: "0.1.550", desiredVersion: "0.1.547", launcherVersion: "0.1.564", discoveryError: "signing-key-unknown" });
  f.write(".relay/recovery/runtime-good.json", { version: "0.1.547", channel: "stable", packageRoot: "C:/private/path" });
  const snapshot = d.snapshot(f);
  assert.equal(snapshot.activeVersion, "0.1.553"); assert.equal(snapshot.advertisedVersion, "0.1.550");
  assert.equal(snapshot.selectedVersion, "0.1.547"); assert.equal(snapshot.lastKnownGood.available, false);
  assert.equal(snapshot.discoveryError, "signing-key-unknown");
  assert.ok(!JSON.stringify(snapshot).includes("private"));
});
test("independent reporter works without the application and retains events after failed delivery", async t => {
  const f = fixture(t); auth(f.homeDir);
  d.record({ component: "updater", stage: "activation", outcome: "started", attemptId: randomUUID() }, f);
  let clock = Date.now(), sent;
  const result = await reporter.report({ ...f, now: () => clock, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.sendrelays.com/v1/devices/diagnostics");
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, "Bearer dgt_abc.def");
    sent = JSON.parse(options.body); throw Error("offline");
  } });
  assert.equal(result.status, "upload-failed"); assert.equal(sent.events.length, 1);
  assert.equal(sent.snapshot.schema, 1);
  clock += 6 * 60000;
  const retry = await reporter.report({ ...f, now: () => clock, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).events[0].id, sent.events[0].id); return new Response('{}');
  } });
  assert.equal(retry.status, "uploaded");
  clock += 6 * 60000;
  await reporter.report({ ...f, now: () => clock, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).events.length, 0); return new Response('{}');
  } });
});
test("account switch, sign-out and origin changes stop old authorization", async t => {
  const f = fixture(t); auth(f.homeDir);
  const scope = d.configIdentity(f.homeDir).scope;
  const noNetwork = async () => { assert.fail("must not send under an obsolete identity"); };
  f.write(".relay/config.json", { user: { id: "usr_two" }, deviceId: "dev_two" });
  assert.equal(d.record({ stage: "activation", outcome: "failed" }, { ...f, scope }), null, "an earlier account's in-flight attempt must not attach to the new account");
  assert.equal((await reporter.report({ ...f, fetchImpl: noNetwork })).status, "unauthorized");
  assert.equal(d.events(f.homeDir, d.configIdentity(f.homeDir).scope).length, 0);
  f.write(".relay/config.json", { user: { id: "usr_one" }, deviceId: "dev_one", apiUrl: "https://attacker.example" });
  assert.equal((await reporter.report({ ...f, fetchImpl: noNetwork })).status, "unauthorized");
  fs.unlinkSync(path.join(f.homeDir, ".relay/config.json"));
  assert.equal((await reporter.report({ ...f, fetchImpl: noNetwork })).status, "unauthorized");
});
test("server refusal invalidates only the same authorization and never deletes history", async t => {
  const f = fixture(t); auth(f.homeDir); d.record({ stage: "health", outcome: "failed" }, f);
  const result = await reporter.report({ ...f, fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.equal(result.status, "authorization-expired"); assert.equal(fs.existsSync(reporter.files(f.homeDir).auth), false);
  assert.equal(d.events(f.homeDir, d.configIdentity(f.homeDir).scope).length, 1);
});
test("explicit Quit prevents independent diagnostic network activity", async t => {
  const f = fixture(t); auth(f.homeDir);
  f.write(".relay/recovery/intent.json", { stopped: true });
  assert.equal((await reporter.report({ ...f, fetchImpl: () => assert.fail("Quit must be respected") })).status, "intentionally-stopped");
});
test("authorization provisioning cannot bind a response after an account switch", async t => {
  const f = fixture(t); let respond;
  provisionDiagnostics({ url: "https://api.sendrelays.com", token: "dev_test-token", userId: "usr_one", deviceId: "dev_one" }, { ...f,
    fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
  assert.equal(typeof respond, "function");
  f.write(".relay/config.json", { user: { id: "usr_other" }, deviceId: "dev_other" });
  respond(new Response(JSON.stringify({ token: "dgt_abc.def", userId: "usr_one", deviceId: "dev_one", expiresAt: new Date(Date.now() + 86400000).toISOString() })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(reporter.files(f.homeDir).auth), false);
});
test("queued batches drain without losing older unsent events", async t => {
  const f = fixture(t); auth(f.homeDir); let clock = Date.now();
  for (let i = 0; i < 140; i++) d.record({ stage: "health", outcome: "succeeded" }, { ...f, now: () => clock + i });
  const seen = new Set();
  const fetchImpl = async (_url, options) => { for (const e of JSON.parse(options.body).events) { assert.ok(!seen.has(e.id)); seen.add(e.id); } return new Response('{}'); };
  await reporter.report({ ...f, now: () => clock, fetchImpl }); assert.equal(seen.size, 128);
  clock += 6 * 60000;
  await reporter.report({ ...f, now: () => clock, fetchImpl }); assert.equal(seen.size, 140);
});
