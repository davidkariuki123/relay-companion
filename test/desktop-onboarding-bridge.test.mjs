import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDesktopOnboardingBridge, callDesktopOnboarding } from "../src/desktop-onboarding-bridge.js";

test("local helper starts once, waits for browser approval, and checks matching account", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-"));
  let starts = 0, consumes = 0, status = "pending_identity";
  const bridge = await startDesktopOnboardingBridge({ directory,
    authorization: { signIn: async () => { starts++; }, state: async () => ({ status }), resume: async () => { consumes++; status = "consumed"; } },
    verifyAccount: async () => ({ id: "local-test-user" }),
  });
  const run = bridge.state().id;
  const invoke = (operation, extra = {}) => callDesktopOnboarding({ directory, operation, run, ...extra });
  try {
    assert.equal((await invoke("status")).stage, "prompt");
    assert.equal(starts, 0);
    await assert.rejects(invoke("start", { guideVersion: 0, host: "codex" }));
    await Promise.all([invoke("start", { guideVersion: 1, host: "codex" }), invoke("start", { guideVersion: 1, host: "codex" })]);
    assert.equal(starts, 1);
    assert.equal((await invoke("status")).stage, "browser");
    await assert.rejects(invoke("ready", { accountId: "local-test-user" }));
    status = "approved";
    // Reads have no side effects; the app's authorization observer owns consume.
    assert.equal((await invoke("status")).stage, "browser");
    assert.equal(consumes, 0);
    for (let i = 0; i < 30 && bridge.state().stage !== "verifying"; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await invoke("status")).stage, "verifying");
    assert.equal(consumes, 1);
    await assert.rejects(invoke("ready", { accountId: "another-account" }));
    assert.equal((await invoke("ready", { accountId: "local-test-user" })).stage, "teaching");
    assert.equal((await invoke("ready", { accountId: "local-test-user" })).stage, "teaching");
    await assert.rejects(callDesktopOnboarding({ directory, operation: "status", run: "stale" }));
  } finally { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
