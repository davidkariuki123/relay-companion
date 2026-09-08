import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import { startOnboardingReview } from "../src/onboarding-review.js";

test("practice invitation bridge matches the pill's initial-load and copy contracts", async () => {
  const copied = [];
  const window = { practiceBase: "http://127.0.0.1:12345", practiceAccess: "practice-only" };
  const url = window.practiceBase + "/";
  vm.runInNewContext(fs.readFileSync(new URL("../src/onboarding-review-bridge.js", import.meta.url), "utf8"), {
    window,
    fetch: async (requested, options) => {
      assert.equal(requested, window.practiceBase + "/v1/invite-link");
      assert.equal(options.headers.Authorization, "Bearer practice-only");
      return { ok: true, json: async () => ({ url, shareText: "Local practice only." }) };
    },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    setInterval: () => {},
  });
  const initial = await window.relay.onboardingInviteLink();
  assert.equal(initial.ok, true);
  assert.equal(initial.invite.url, url);
  const copy = await window.relay.copyOnboardingInviteLink();
  assert.equal(copy.ok, true);
  assert.equal(copy.url, url);
  assert.deepEqual(copied, [url]);
});

test("local rehearsal uses the real helper, contains sends, rejects other origins and keeps profiles separate", async (t) => {
  const review = await startOnboardingReview();
  t.after(async () => { await review.close(); fs.rmSync(review.root, { recursive: true, force: true }); });
  const wrapper = path.join(review.root, "practice-relay.mjs");
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", error = "";
    child.stdout.on("data", (b) => out += b); child.stderr.on("data", (b) => error += b);
    child.on("error", reject); child.on("close", (code) => resolve({ code, out, error }));
  });
  assert.equal((await fetch(review.url + "/practice/state")).status, 401);
  assert.equal((await fetch(review.url + "/", { headers: { Origin: "https://example.com" } })).status, 403);
  assert.equal((await run("connect-start", "https://api.sendrelays.com", "invite_practice_01234567890123456789", "codex")).code, 1);
  const started = await run("connect-start", review.url, "invite_practice_01234567890123456789", "codex");
  assert.equal(started.code, 0, started.error);
  assert.equal((await run("connect-finish")).code, 1, "approval remains a real step in the rehearsal");
  const approval = new URL(JSON.parse(started.out).approvalUrl);
  const token = new URLSearchParams(approval.hash.slice(1)).get("approvalToken");
  assert.equal((await fetch(`${review.url}/approve?key=${token}`, { method: "POST" })).status, 200);
  const finish = await run("connect-finish");
  assert.equal(finish.code, 0, finish.error);
  assert.equal(JSON.parse(finish.out).account.relayUserId, "usr_review_you");
  assert.equal((await run("tutorial-send")).code, 1);
  const sent = await run("tutorial-send", "--approved");
  assert.equal(sent.code, 0, sent.error);
  const retry = await run("tutorial-send", "--approved");
  assert.equal(JSON.parse(sent.out).relayId, JSON.parse(retry.out).relayId);
  const config = JSON.parse(fs.readFileSync(path.join(review.root, "agent-protocol.json")));
  const state = await (await fetch(review.url + "/practice/state", { headers: { Authorization: `Bearer ${config.accessToken}` } })).json();
  assert.equal(state.sent.length, 1);
  assert.equal(state.ui.firstRelayId, JSON.parse(sent.out).relayId);
  assert.equal(state.ui.firstRelayStatus, "sent");
  assert.equal((await fetch(review.url + "/overlay/read-receipts.cjs")).status, 200);
  const other = await startOnboardingReview();
  try { assert.notEqual(other.root, review.root); assert.equal(fs.existsSync(path.join(other.root, "agent-protocol.json")), false); }
  finally { await other.close(); fs.rmSync(other.root, { recursive: true, force: true }); }
});
