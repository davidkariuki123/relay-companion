import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

async function open(info, { search = "", handoff = async () => ({ opened: true }) } = {}) {
  const nodes = new Map(), calls = [];
  let launched;
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { textContent: "", hidden: false, removeAttribute() {} });
    return nodes.get(key);
  };
  const context = { document: { querySelector: node, documentElement: { dataset: {} } }, location: { search },
    localStorage: { getItem() {}, setItem() {} }, window: { migration: {
      inspect: async () => info, onProgress() {}, onLaunch(callback) { launched = callback; },
      install: async () => { calls.push("install"); },
      handoff: async () => { calls.push("handoff"); return handoff(); },
      open: async () => { calls.push("open"); },
    } } };
  vm.runInNewContext(fs.readFileSync(new URL("../app/native-bootstrap.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, node, document: context.document, launchFailed: () => launched({ failed: true }) };
}

const installed = { candidate: { version: "0.1.600" }, plan: { route: "deferred-repair" },
  installation: { pointer: "active", applicationOwner: "present", installedVersion: "0.1.600", serviceHeartbeat: "fresh" } };

test("on a computer Relay is set up on, the window says Relay is opening and never offers to install", async () => {
  const view = await open(installed, { search: "?open" });
  assert.deepEqual(view.calls, [], "the main process opens Relay; the window starts nothing");
  assert.equal(view.node("#prepareTitle").textContent, "Opening Relay.");
  assert.equal(view.node("#prepareStep").textContent, "Relay");
  assert.equal(view.document.title, "Relay");
  assert.equal(view.node("#prepareAction").hidden, true);
});

test("when the pill does not come up, the window says Relay didn't open and opens it again on request", async () => {
  let opened = false;
  const view = await open(installed, { search: "?open", handoff: async () => ({ opened }) });
  view.launchFailed();
  assert.equal(view.node("#prepareTitle").textContent, "Relay didn’t open.");
  assert.doesNotMatch(view.node("#prepareStatus").textContent, /error|invoking|exit|install relay|reinstall|preparing/i, "no raw error and no install wording");
  assert.equal(view.node("#prepareAction").textContent, "Open Relay");
  await view.node("#prepareAction").onclick();
  assert.deepEqual(view.calls, ["handoff"], "a running service is reopened, never reinstalled");
  assert.equal(view.node("#prepareTitle").textContent, "Relay didn’t open.", "still slow: says so again");
  opened = true;
  await view.node("#prepareAction").onclick();
  assert.deepEqual(view.calls, ["handoff", "handoff"]);
  assert.equal(view.node("#prepareTitle").textContent, "Opening Relay.");
});

test("a handoff that throws is reported as Relay not opening, not as an error message", async () => {
  const view = await open(installed, { search: "?open", handoff: async () => { throw new Error("Error invoking remote method 'application:handoff': Error: Relay could not open its pill (exit 1)."); } });
  view.launchFailed();
  await view.node("#prepareAction").onclick();
  assert.equal(view.node("#prepareTitle").textContent, "Relay didn’t open.");
  assert.doesNotMatch(view.node("#prepareStatus").textContent, /invoking|exit 1/);
});

test("reopening an installed computer whose service stopped puts it back through setup", async () => {
  const view = await open({ ...installed, installation: { ...installed.installation, serviceHeartbeat: "stale" } }, { search: "?open" });
  view.launchFailed();
  await view.node("#prepareAction").onclick();
  assert.deepEqual(view.calls, ["install", "handoff"]);
});

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
