import assert from "node:assert/strict";
import test from "node:test";
import { applicationMain, candidate } from "./fixtures/application-main.mjs";

const earlier = { ...candidate, applicationVersion: "0.1.565" };
const actions = app => app.calls.map(call => call.action);

test("a fresh Mac moves the app with a handoff for the exact candidate", async () => {
  const app = await applicationMain();
  assert.equal((await app.relocate()).ok, true);
  assert.deepEqual(actions(app), ["write", "move"]);
  const handoff = JSON.parse(app.calls.at(-1).handoff);
  assert.equal(handoff.version, candidate.version);
  assert.equal(handoff.runtimeSourceSha, candidate.runtimeSourceSha);
  assert.ok(Number.isFinite(Date.parse(handoff.startedAt)));
  assert.equal(app.calls[0].options.mode, 0o600);
});

test("an older or identical app is actually removed before moving its replacement", async () => {
  for (const existing of [earlier, candidate]) {
    const app = await applicationMain({ existing });
    assert.equal((await app.relocate()).ok, true);
    assert.deepEqual(actions(app), ["trash", "write", "move"]);
  }
});

test("the move waits until trash has finished", async () => {
  const pending = Promise.withResolvers();
  const app = await applicationMain({ existing: earlier, trash: () => pending.promise });
  const result = app.relocate();
  // Observe a rejection immediately if a regression races the move.
  result.catch(() => {});
  assert.deepEqual(actions(app), ["trash"]);
  assert.equal(app.files.has(app.handoff), false);
  pending.resolve();
  assert.equal((await result).ok, true);
  assert.deepEqual(actions(app), ["trash", "write", "move"]);
});

test("trash failure blocks the move and the same window can retry", async () => {
  let attempts = 0;
  const app = await applicationMain({ existing: earlier, trash: async () => {
    if (++attempts === 1) throw Error("Permission denied");
  } });
  await assert.rejects(app.relocate(), /could not replace/);
  assert.deepEqual(actions(app), ["trash"]);
  assert.equal(app.files.has(app.handoff), false);
  assert.equal((await app.relocate()).ok, true);
  assert.deepEqual(actions(app), ["trash", "trash", "write", "move"]);
});

test("a refused move clears the handoff and retries after the old app was trashed", async () => {
  let attempts = 0;
  const app = await applicationMain({ existing: earlier, move: () => ++attempts > 1 });
  await assert.rejects(app.relocate(), /could not move/);
  assert.deepEqual(actions(app), ["trash", "write", "move", "remove"]);
  assert.equal(app.files.has(app.handoff), false);
  assert.equal((await app.relocate()).ok, true);
  assert.deepEqual(actions(app), ["trash", "write", "move", "remove", "write", "move"]);
});

test("a thrown move error also clears the handoff before retry", async () => {
  let attempts = 0;
  const app = await applicationMain({ move: () => {
    if (++attempts === 1) throw Error("Destination unavailable");
    return true;
  } });
  await assert.rejects(app.relocate(), /Destination unavailable/);
  assert.equal(app.files.has(app.handoff), false);
  assert.equal((await app.relocate()).ok, true);
});

test("a newer app or an untrusted receipt cannot trigger trash, handoff or move", async () => {
  for (const existing of [
    { ...candidate, applicationVersion: "0.1.600" },
    { ...candidate, appId: "another.application" },
    { ...candidate, applicationVersion: "invalid" },
    "{broken-json", null,
  ]) {
    const app = await applicationMain({ existing });
    await assert.rejects(app.relocate());
    assert.deepEqual(actions(app), []);
  }
});

test("only the main installer frame on a Mac outside Applications may move the app", async () => {
  for (const options of [{ platform: "win32" }, { platform: "linux" }, { installed: true }, { preview: true }]) {
    const app = await applicationMain(options);
    await assert.rejects(app.relocate(), /unavailable/);
    assert.deepEqual(actions(app), []);
  }
  const app = await applicationMain();
  for (const event of [{ ...app.event, sender: {} }, { ...app.event, senderFrame: {} }]) {
    await assert.rejects(app.relocate(event), /unavailable/);
    assert.deepEqual(actions(app), []);
  }
});
