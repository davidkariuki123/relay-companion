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

// Founder, 0.1.624 (2026-10-10): opening Relay from the disk image installs
// it. The window starts the move itself, and the copy in Applications ejects
// the "Install Relay" image it came from.
const installVolume = "/Volumes/Install Relay";
const detached = app => app.processes.filter(([command, verb]) => command === "/usr/bin/hdiutil" && verb === "detach").map(([, , mount]) => mount);

test("the handoff names the Install Relay image the app was opened from", async () => {
  const app = await applicationMain();
  assert.equal((await app.relocate()).ok, true);
  const written = handoffWritten(app);
  assert.equal(written.volume, installVolume);
  assert.equal(written.appName, "Relay.app");
  assert.deepEqual(app.processes.map(([command, verb]) => `${command} ${verb}`), ["/usr/bin/hdiutil info", "/usr/bin/plutil -convert"]);
});

// The bytes the relocation handler wrote, read back from the recorded move.
function handoffWritten(app) {
  const move = app.calls.find(call => call.action === "move");
  return JSON.parse(move.handoff);
}

test("a translocated app finds its image only when exactly one mounted image holds this exact build", async () => {
  const bundle = "/private/var/folders/xy/abc/T/AppTranslocation/4F1C2D3E-0000-4000-8000-000000000000/d/Relay.app";
  const other = { mount: "/Volumes/Relay 0.1.500", receipt: { ...candidate, applicationVersion: "0.1.500" } };
  let app = await applicationMain({ bundle, mounts: [other, { mount: installVolume, receipt: candidate }] });
  assert.equal((await app.relocate()).ok, true);
  assert.equal(handoffWritten(app).volume, installVolume);
  app = await applicationMain({ bundle, mounts: [{ mount: installVolume, receipt: candidate }, { mount: "/Volumes/Install Relay 1", receipt: candidate }] });
  assert.equal((await app.relocate()).ok, true);
  assert.equal(handoffWritten(app).volume, null, "two copies of this build: eject neither");
  app = await applicationMain({ bundle: "/Users/test/Downloads/Relay.app" });
  assert.equal((await app.relocate()).ok, true);
  assert.equal(handoffWritten(app).volume, null, "not on a disk image");
});

test("hdiutil failing never stops the install", async () => {
  const app = await applicationMain({ hdiutil: () => { throw Error("hdiutil: info failed"); } });
  assert.equal((await app.relocate()).ok, true);
  assert.equal(handoffWritten(app).volume, null);
  assert.deepEqual(actions(app), ["write", "move"]);
});

test("the window starting the move and Try again never run two moves at once", async () => {
  const pending = Promise.withResolvers();
  const app = await applicationMain({ existing: earlier, trash: () => pending.promise });
  const first = app.relocate(), second = app.relocate();
  pending.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.ok), [true, true]);
  assert.deepEqual(actions(app), ["trash", "write", "move"]);
});

test("the copy in Applications ejects exactly the image it came from, once it is open", async () => {
  const handoff = { version: candidate.version, runtimeSourceSha: candidate.runtimeSourceSha, startedAt: new Date().toISOString(), volume: installVolume, appName: "Relay.app" };
  const app = await applicationMain({ installed: true, handoff });
  assert.equal(app.files.has(app.handoff), false, "the handoff is consumed");
  assert.deepEqual(detached(app), [], "not before Electron's own eject has had its turn");
  assert.ok(app.timers.some(timer => timer.ms >= 5000));
  await app.runTimers();
  assert.deepEqual(detached(app), [installVolume]);
  assert.ok(!app.processes.some(args => args.includes("-force")), "never forced");
});

test("an image already ejected, holding another build, or refusing to eject is left alone", async () => {
  const handoff = { version: candidate.version, runtimeSourceSha: candidate.runtimeSourceSha, volume: installVolume, appName: "Relay.app" };
  let app = await applicationMain({ installed: true, handoff, mounts: [] });
  await app.runTimers();
  assert.deepEqual(detached(app), [], "already ejected by Electron");
  app = await applicationMain({ installed: true, handoff, mounts: [{ mount: installVolume, receipt: { ...candidate, applicationVersion: "0.1.569" } }] });
  await app.runTimers();
  assert.deepEqual(detached(app), [], "another Relay's image");
  app = await applicationMain({ installed: true, handoff, hdiutil: args => { if (args[0] === "detach") throw Error("resource busy"); } });
  await app.runTimers();
  assert.deepEqual(detached(app), [installVolume], "tried once, failure ignored");
  for (const volume of ["/", "/Volumes", "/Users/test", "/Volumes/Install Relay/../..", "/private/tmp/mount"]) {
    app = await applicationMain({ installed: true, handoff: { ...handoff, volume }, mounts: [{ mount: volume, receipt: candidate }] });
    await app.runTimers();
    assert.deepEqual(detached(app), [], volume);
  }
  app = await applicationMain({ installed: true, handoff: { ...handoff, version: "0.1.500" } });
  await app.runTimers();
  assert.deepEqual(detached(app), [], "a handoff from another build ejects nothing");
});
