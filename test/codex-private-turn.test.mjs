import test from "node:test";
import assert from "node:assert/strict";
import { submitCodexTurnPrivately, THREAD_OPEN_IN_DESKTOP } from "../src/codex-private-turn.js";

// A fake app-server client: records requests, answers from `responses`, and
// lets the test deliver notifications the way the real stdout reader does.
function fakeClient(responses = {}) {
  const client = {
    requests: [],
    stopped: 0,
    notifications: [],
    async start() {},
    async stop() { client.stopped += 1; },
    async request(method, params) {
      client.requests.push({ method, params });
      const answer = responses[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : answer;
    },
    async waitForNotification(predicate, { timeoutMs = 1_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = client.notifications.find(predicate);
        if (hit) return hit;
        if (Date.now() >= deadline) throw new Error("timeout");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
  return client;
}

test("a thread open in Codex Desktop is refused before anything is written", async () => {
  const client = fakeClient({
    "thread/resume": new Error("thread-store conflict: thread t1 already has an active writer"),
  });
  const result = await submitCodexTurnPrivately({ threadId: "t1", text: "hi", createClient: () => client });
  assert.deepEqual(result, { submitted: false, reason: THREAD_OPEN_IN_DESKTOP });
  assert.deepEqual(client.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(client.stopped, 1, "the private server must not keep holding the thread");
});

test("a free thread gets one turn, and the server stops once that turn completes", async () => {
  const client = fakeClient({ "thread/resume": {}, "turn/start": { turn: { id: "turn-9" } } });
  const result = await submitCodexTurnPrivately({ threadId: "t2", text: "hello", createClient: () => client });
  assert.equal(result.submitted, true);
  assert.equal(result.turnId, "turn-9");
  assert.equal(client.stopped, 0, "the turn runs inside the private server, so it must stay up");
  assert.deepEqual(client.requests[1].params.input, [{ type: "text", text: "hello", text_elements: [] }]);
  client.notifications.push({ method: "turn/completed", params: { turn: { id: "turn-9" } } });
  assert.equal(await result.finished, true);
  assert.equal(client.stopped, 1);
});

test("a turn that never completes is interrupted and the thread released", async () => {
  const client = fakeClient({ "thread/resume": {}, "turn/start": { turn: { id: "turn-slow" } }, "turn/interrupt": {} });
  const result = await submitCodexTurnPrivately({ threadId: "t3", text: "hello", turnTimeoutMs: 20, createClient: () => client });
  assert.equal(await result.finished, false);
  assert.ok(client.requests.some((request) => request.method === "turn/interrupt"));
  assert.equal(client.stopped, 1);
});
