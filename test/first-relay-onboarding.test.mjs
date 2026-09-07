import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createFirstRelayOnboarding, hasSentRelay } from "../overlay/first-relay-onboarding.cjs";

const sent = { relayId: "relay_first", state: "delivered" };

test("confirmed sends count without a read receipt; pending sends and unclaimed links do not", () => {
  assert.equal(hasSentRelay({ items: [sent] }), true);
  assert.equal(hasSentRelay({ items: [{ ...sent, state: "queued" }] }), false);
  assert.equal(hasSentRelay({ items: [{ ...sent, state: "pending" }] }), false);
  assert.equal(hasSentRelay({ items: [{ ...sent, shareLink: { state: "active" } }] }), false);
  assert.equal(hasSentRelay({ items: [{ ...sent, shareLink: { state: "revoked" } }] }), false);
  assert.equal(hasSentRelay({ items: [{ ...sent, shareLink: { state: "claimed" } }] }), true);
  assert.equal(hasSentRelay({ items: [{ ...sent, deletedAt: "2026-09-07" }] }), true);
  assert.equal(hasSentRelay({}), null);
});

test("account history works beyond the returned page, with conservative old-server compatibility", () => {
  const links = Array.from({ length: 200 }, () => ({ ...sent, shareLink: { state: "active" } }));
  assert.equal(hasSentRelay({ items: links }), null);
  assert.equal(hasSentRelay({ items: links, hasSentRelay: true }), true);
  assert.equal(hasSentRelay({ items: links, hasSentRelay: false }), false);
  assert.equal(hasSentRelay({ items: [] }), false);
  // A send can land between the parallel server history and list queries.
  assert.equal(hasSentRelay({ items: [sent], hasSentRelay: false }), true);
});

test("a send made before the app opens bypasses the tutorial; a send during it celebrates once", () => {
  const flow = createFirstRelayOnboarding();
  assert.equal(flow.status("existing"), "checking");
  assert.equal(flow.observe("existing", { hasSentRelay: true }), "complete");
  assert.equal(flow.observe("new", { items: [] }), "waiting");
  assert.equal(flow.observe("new", { items: [sent] }), "sent");
  flow.failed("new");
  assert.equal(flow.observe("new", { items: [] }), "sent");
  assert.equal(flow.status("existing"), "complete");
  assert.equal(createFirstRelayOnboarding().observe("new", { items: [sent] }), "complete");
});

test("network failures are unknown, recover without losing progress, and never leak between accounts", () => {
  const flow = createFirstRelayOnboarding();
  flow.failed("a");
  assert.equal(flow.status("a"), "unavailable");
  assert.equal(flow.status("b"), "checking");
  assert.equal(flow.observe("a", { items: [sent] }), "complete");
  flow.observe("b", { items: [] });
  flow.failed("b");
  assert.equal(flow.status("b"), "unavailable");
  assert.equal(flow.observe("b", { items: [sent] }), "sent");
});

function refreshHarness() {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const pending = [];
  const flow = createFirstRelayOnboarding();
  const scope = vm.createContext({
    credential: "a", key: "user:a", firstRelayOnboarding: flow,
    onboardingVersions: {}, COMPANION_ONBOARDING_VERSION: 2, SENT_FETCH_LIMIT: 200,
    testFixtures: () => null, console: { error() {} },
    deviceToken: () => scope.credential, onboardingAccountKey: () => scope.key,
    relayClient: async () => ({ sent: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }),
    sentFingerprintOf: JSON.stringify, writeOverlayPrefs() {},
    outbox: { retireConfirmed() {}, pendingCount: () => 0 },
  });
  vm.runInContext(`let sentCache = [], sentFingerprint = "", sentRefreshStarted = 0, sentRefreshCommitted = 0;\n${main.slice(main.indexOf("async function refreshSent()"), main.indexOf("function ensureSentLoaded()"))}`, scope);
  return { scope, pending, flow, refresh: () => vm.runInContext("refreshSent()", scope) };
}

test("a late previous-account response cannot finish the current account's onboarding", async () => {
  const h = refreshHarness();
  const old = h.refresh();
  await new Promise(setImmediate);
  h.scope.credential = "b"; h.scope.key = "user:b";
  const current = h.refresh();
  await new Promise(setImmediate);
  h.pending[1].resolve({ items: [], hasSentRelay: false }); await current;
  h.pending[0].resolve({ items: [sent], hasSentRelay: true }); await old;
  assert.equal(h.flow.status("user:b"), "waiting");
  assert.equal(h.flow.status("user:a"), "checking");
  assert.deepEqual(h.scope.onboardingVersions, {});
});

test("stale overlapping polls cannot replace a confirmed first send with an empty history", async () => {
  const h = refreshHarness();
  const old = h.refresh(); await new Promise(setImmediate);
  const latest = h.refresh(); await new Promise(setImmediate);
  h.pending[1].resolve({ items: [sent], hasSentRelay: true }); await latest;
  h.pending[0].resolve({ items: [], hasSentRelay: false }); await old;
  assert.equal(h.flow.status("user:a"), "complete");
  assert.equal(h.scope.onboardingVersions["user:a"], 2);
});
