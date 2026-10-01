import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

async function open(info) {
  const nodes = new Map(), calls = [];
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { textContent: "", hidden: false, removeAttribute() {} });
    return nodes.get(key);
  };
  const context = { document: { querySelector: node, documentElement: { dataset: {} } },
    localStorage: { getItem() {}, setItem() {} }, window: { migration: {
      inspect: async () => info, onProgress() {},
      install: async () => { calls.push("install"); },
      handoff: async () => { calls.push("handoff"); return { opened: true }; },
      open: async () => { calls.push("open"); },
    } } };
  vm.runInNewContext(fs.readFileSync(new URL("../app/native-bootstrap.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, node };
}

test("fresh setup still starts automatically and opens Relay", async () => {
  const view = await open({ plan: { route: "fresh-install" } });
  assert.deepEqual(view.calls, ["install", "handoff"]);
});

test("healthy same/newer runtime opens without reset or sign-out", async () => {
  for (const installedVersion of ["0.1.600", "0.1.601"]) {
    const view = await open({ candidate: { version: "0.1.600" }, plan: { route: "bridge" },
      installation: { pointer: "active", applicationOwner: "present", installedVersion, serviceHeartbeat: "fresh" } });
    assert.deepEqual(view.calls, ["handoff"]);
  }
});

test("old, interrupted and unresponsive installations update on their own and never mention recovery", async () => {
  for (const change of [{ installedVersion: "0.1.490" }, { pointer: "needs-repair" }, { recoveryPending: true }, { serviceHeartbeat: "stale" }]) {
    const view = await open({ candidate: { version: "0.1.600" }, plan: { route: "deferred-repair" },
      installation: { pointer: "active", applicationOwner: "present", installedVersion: "0.1.600", serviceHeartbeat: "fresh", ...change } });
    assert.deepEqual(view.calls, ["install", "handoff"]);
    assert.doesNotMatch(view.node("#prepareStatus").textContent, /recover|clear|sign in again/i);
  }
});

test("a set-up computer whose Relay did not open waits for Try again instead of resetting itself", async () => {
  const view = await open({ candidate: { version: "0.1.600" }, plan: { route: "deferred-repair" }, launch: { quietLaunchFailed: true },
    installation: { pointer: "active", applicationOwner: "present", installedVersion: "0.1.600", serviceHeartbeat: "stale" } });
  assert.deepEqual(view.calls, []);
  assert.equal(view.node("#prepareStatus").textContent, "Relay didn’t open.");
  assert.equal(view.node("#prepareAction").textContent, "Try again");
  await view.node("#prepareAction").onclick();
  assert.deepEqual(view.calls, ["install", "handoff"]);
});

test("no setup wording mentions recovery", () => {
  const source = fs.readFileSync(new URL("../app/native-bootstrap.js", import.meta.url), "utf8");
  for (const text of source.match(/'[^']*'/g)) assert.doesNotMatch(text, /recover|pending local sends|sign in again/i, text);
});
