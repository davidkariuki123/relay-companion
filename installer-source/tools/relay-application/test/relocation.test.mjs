// Installing over an earlier Relay in /Applications.
//
// Field case, 2026-09-29: the 0.1.565 app whose first setup failed stayed in
// Applications, and the fixed 0.1.567 download refused to replace it ("Relay
// could not move to Applications"), so the person could not install at all.
// Receipt decisions are tested here; relocation-handler.test.mjs executes the
// actual main-process handler against simulated Electron and filesystem APIs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { relocationPlan } = require("../app/relocation.cjs");
const ours = { appId: "work.relay.application", version: "0.1.568", applicationVersion: "0.1.568" };

function applications(t, receipt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-relocation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Relay.app");
  if (receipt !== undefined) {
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    if (receipt) fs.writeFileSync(path.join(app, "Contents", "Resources", "candidate.json"), JSON.stringify(receipt));
  }
  return app;
}

test("an empty Applications folder is a plain move", t => {
  assert.deepEqual(relocationPlan(applications(t), ours), { action: "move" });
});

test("an earlier or identical Relay is replaced", t => {
  for (const applicationVersion of ["0.1.99", "0.1.565", "0.1.568", "0.0.999"]) {
    const app = applications(t, { appId: "work.relay.application", version: applicationVersion, applicationVersion });
    assert.deepEqual(relocationPlan(app, ours), { action: "replace" }, applicationVersion);
  }
});

test("a newer Relay, or an app that is not Relay, is never replaced", t => {
  for (const applicationVersion of ["0.1.600", "0.2.0", "1.0.0"]) {
    const plan = relocationPlan(applications(t, { appId: "work.relay.application", applicationVersion }), ours);
    assert.equal(plan.action, "refuse");
    assert.match(plan.message, /newer Relay/);
  }
  assert.equal(relocationPlan(applications(t, { appId: "com.example.relay", applicationVersion: "0.1.1" }), ours).action, "refuse");
  assert.equal(relocationPlan(applications(t, null), ours).action, "refuse", "a Relay.app with no receipt is someone else's app");
});

test("outer application version governs replacement, with a legacy version fallback", t => {
  const newerOuter = { appId: ours.appId, version: "0.1.500", applicationVersion: "0.1.600" };
  assert.equal(relocationPlan(applications(t, newerOuter), ours).action, "refuse");
  const olderOuter = { appId: ours.appId, version: "9.0.0", applicationVersion: "0.1.500" };
  assert.equal(relocationPlan(applications(t, olderOuter), ours).action, "replace");
  assert.equal(relocationPlan(applications(t, { appId: ours.appId, version: "0.1.565" }), ours).action, "replace");
});

test("missing or malformed versions and unreadable receipts fail closed", t => {
  for (const applicationVersion of ["invalid", "0.1", "0.1.568-beta.1", "-1.0.0"]) {
    const invalid = { appId: ours.appId, applicationVersion };
    assert.equal(relocationPlan(applications(t, invalid), ours).action, "refuse");
    assert.equal(relocationPlan(applications(t, ours), invalid).action, "refuse");
  }
  assert.equal(relocationPlan(applications(t, { appId: ours.appId }), ours).action, "refuse");
  const destination = applications(t, ours);
  fs.writeFileSync(path.join(destination, "Contents", "Resources", "candidate.json"), "{broken-json");
  assert.equal(relocationPlan(destination, ours).action, "refuse");
  assert.equal(relocationPlan(destination, ours, { read: () => { throw Error("Permission denied"); } }).action, "refuse");
});
