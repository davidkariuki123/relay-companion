import test from "node:test";
import assert from "node:assert/strict";
import { startHeadlessTaskRun } from "../src/task-run-headless.js";

// A runner that, like startAcpRun, names the session and awaits onSession
// before the prompt goes anywhere.
function runner(nativeId = "0f5d5d0e-6a8f-4c43-9f4a-3c1f0a6d2b11") {
  const calls = { started: null, prompted: false };
  let finish;
  const start = async (options) => {
    calls.started = options;
    await options.onSession(nativeId);
    calls.prompted = true;
    return { sessionId: nativeId, done: new Promise((resolve) => { finish = resolve; }) };
  };
  return { calls, start, finish: () => finish({ stopReason: "end_turn" }) };
}
const base = { taskId: "relay_task", operationId: "sop_1", cwd: "/Users/sven/relay", packet: { title: "Fix it" }, prompt: "do it", allowed: () => true };

test("the Task is reserved for the background run, refusing if anything started it, before the prompt is sent", async () => {
  const r = runner();
  const reserved = [];
  const client = { taskExecute: async (id, body) => { reserved.push({ id, body }); return { taskRunOwner: { provider: "claude", nativeSessionId: body.sourceNativeId } }; } };
  const result = await startHeadlessTaskRun({ ...base, client, provider: "claude", start: r.start });
  assert.equal(result.nativeId, "0f5d5d0e-6a8f-4c43-9f4a-3c1f0a6d2b11");
  assert.deepEqual(reserved, [{ id: "relay_task", body: { sourceProvider: "claude", sourceNativeId: result.nativeId, idempotencyKey: `remote-background:${result.nativeId}`, requireUnstarted: true } }]);
  assert.equal(r.calls.prompted, true);
  assert.equal(r.calls.started.title, "Fix it", "a titled Claude run is handed to Claude's app when it finishes");
  assert.equal(r.calls.started.cwd, "/Users/sven/relay");
  assert.equal(r.calls.started.prompt, "do it");
});

test("a Task started elsewhere, or off this computer's execution, sends nothing", async () => {
  const elsewhere = runner();
  const refused = { taskExecute: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); } };
  await assert.rejects(startHeadlessTaskRun({ ...base, client: refused, provider: "codex", start: elsewhere.start }), /started somewhere else/);
  assert.equal(elsewhere.calls.prompted, false);

  const other = runner();
  const owned = { taskExecute: async () => ({ taskRunOwner: { provider: "claude", nativeSessionId: "someone-else" } }) };
  await assert.rejects(startHeadlessTaskRun({ ...base, client: owned, provider: "claude", start: other.start }), /another conversation/);
  assert.equal(other.calls.prompted, false);

  const off = runner();
  let asked = false;
  await assert.rejects(startHeadlessTaskRun({ ...base, allowed: () => false, client: { taskExecute: async () => { asked = true; } }, provider: "claude", start: off.start }), /turned off/);
  assert.equal(asked, false);
  assert.equal(off.calls.prompted, false);
});

test("a finished Codex run is announced to Codex's app in its folder", async () => {
  const r = runner();
  const notified = [];
  const client = { taskExecute: async (_id, body) => ({ taskRunOwner: { provider: "codex", nativeSessionId: body.sourceNativeId } }) };
  const { nativeId } = await startHeadlessTaskRun({ ...base, client, provider: "codex", start: r.start, notifyCodex: async (input) => { notified.push(input); } });
  assert.deepEqual(notified, [], "nothing is announced while it runs");
  r.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notified, [{ threadIds: [nativeId], workspaceRootsByThreadId: { [nativeId]: ["/Users/sven/relay"] }, primeOpen: false }]);
});
