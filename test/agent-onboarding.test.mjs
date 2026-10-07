import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { createAgentOnboarding } = require("../overlay/agent-onboarding.cjs");

function harness({ schemes = {}, openFails = false } = {}) {
  const calls = [];
  let clock = Date.parse("2026-10-07T12:00:00Z");
  let status = "pending";
  let minted = 0;
  const client = {
    async createAgentSetupRun(input) {
      calls.push(["create", input]); minted += 1;
      const prompt = `Set up Relay for me. Fetch my setup packet from this link exactly as delivered there, and follow it: https://sendrelays.com/setup/CODE${minted}/packet`;
      return { id: `asr_${minted}`, status: "pending", surface: input.surface, place: input.place, expiresAt: new Date(clock + 15 * 60_000).toISOString(),
        connectedAt: null, code: `CODE${minted}`, prompt, openUrl: input.surface === "chatgpt" && input.place === "app" ? null : `https://example.test/open?q=${minted}` };
    },
    async agentSetupRun(id) { calls.push(["read", id]); return { id, status, connectedAt: status === "connected" ? "2026-10-07T12:01:00.000Z" : null }; },
    async cancelAgentSetupRun(id) { calls.push(["cancel", id]); },
    async agentOnboarding() { calls.push(["onboarding"]); return { kind: "hello", inviter: { name: "Sam", relayUserId: "usr_sam" } }; },
  };
  const store = {};
  const opened = [];
  const copied = [];
  const onboarding = createAgentOnboarding({
    store, persist: () => calls.push(["persist"]), client: async () => client,
    schemeOwner: (scheme) => schemes[scheme] || "",
    openExternal: async (url) => { if (openFails && url.startsWith("claude://")) throw new Error("refused"); opened.push(url); },
    writeClipboard: (text) => copied.push(text), now: () => clock,
  });
  return { onboarding, calls, store, opened, copied, tick: (ms) => { clock += ms; }, setStatus: (value) => { status = value; } };
}

test("a chat AI gets one live code, re-minted only when it lapses, and connects when the AI redeems it", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "chatgpt", "browser");
  assert.equal(h.onboarding.snapshot(key).run, null, "nothing is minted until the paste screen asks");
  const first = await h.onboarding.prepare(key);
  assert.equal(first.run.code, "CODE1");
  assert.equal((await h.onboarding.prepare(key)).run.code, "CODE1", "the same live code while it lasts");
  h.tick(14.5 * 60_000);
  assert.equal(h.onboarding.snapshot(key).run, null, "a code about to lapse is not shown");
  assert.equal((await h.onboarding.prepare(key)).run.code, "CODE2");
  h.setStatus("cancelled");
  assert.equal((await h.onboarding.poll(key)).run, null, "a code the server replaced is not shown");
  assert.equal((await h.onboarding.prepare(key)).run.code, "CODE3");
  h.setStatus("pending");
  assert.equal((await h.onboarding.poll(key)).connectedAt, "");
  h.setStatus("connected");
  const connected = await h.onboarding.poll(key);
  assert.equal(connected.connectedAt, "2026-10-07T12:01:00.000Z");
  assert.equal(h.store[key].host, "chatgpt", "the choice persists with the account");
});

test("changing the AI cancels the old code so a stale request cannot connect", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "claude", "browser");
  await h.onboarding.prepare(key);
  h.onboarding.choose(key, "chatgpt", "app");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.calls.some(([kind, id]) => kind === "cancel" && id === "asr_1"));
  const snapshot = await h.onboarding.prepare(key);
  assert.equal(snapshot.run.open, false, "the ChatGPT Mac app has no launch link");
  assert.throws(() => h.onboarding.choose(key, "netscape"), /Choose one of the listed AIs/);
  h.onboarding.reset(key);
  assert.equal(h.store[key], undefined);
});

test("open puts the request in the AI's composer and on the clipboard, with a web fallback for the Claude app", async () => {
  const h = harness({ openFails: true });
  const key = "user:usr_alex";
  h.onboarding.choose(key, "claude", "app");
  const created = await h.onboarding.prepare(key);
  assert.ok(created.run.open);
  h.store[key] = { ...h.store[key] };
  // Simulate the Claude app's own link.
  const result = await (async () => {
    const run = h.onboarding.snapshot(key).run;
    assert.ok(run);
    return h.onboarding.open(key);
  })();
  assert.equal(result.ok, true);
  assert.equal(h.copied.at(-1).startsWith("Set up Relay for me."), true);
  h.onboarding.copyPrompt(key);
  assert.equal(h.copied.length, 2);
});

test("local agents open with their own scheme only when the app is here", async () => {
  const h = harness({ schemes: { "codex://": "Codex" } });
  const key = "user:usr_alex";
  h.onboarding.choose(key, "codex");
  assert.deepEqual(h.onboarding.snapshot(key).openable, { "claude-code": false, codex: true, claudeApp: false });
  await h.onboarding.open(key, "Help me connect the Relay app");
  assert.equal(h.opened[0], `codex://threads/new?prompt=${encodeURIComponent("Help me connect the Relay app")}`);
  h.onboarding.choose(key, "claude-code");
  await assert.rejects(() => h.onboarding.open(key, "prompt"), /Copy the prompt/);
  h.onboarding.markConnected(key);
  assert.ok(h.onboarding.snapshot(key).connectedAt);
  await assert.rejects(() => h.onboarding.prepare(key), /Choose ChatGPT or Claude first/);
});

test("the server's answer names the first Relay's destination", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "chatgpt", "browser");
  await h.onboarding.refreshServer(key);
  assert.equal(h.onboarding.snapshot(key).kind, "hello");
  assert.equal(h.onboarding.snapshot(key).destination, "Sam");
});

test("the pill wires the chooser, the single handoff and the server's first-Relay kind", () => {
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.match(html, /Which AI do you use most\?/);
  assert.match(html, /Where do you use \$\{esc\(option\.name\)\}\?/);
  assert.match(html, /Paste this into<br>\$\{onboardingAgentTitleName\(agent\)\}\./);
  assert.match(html, /if \(status !== "checking" && agent && !onboardingAgentConnected\(agent\)\) \{ renderAgentSetup\(agent\); return; \}/);
  assert.match(html, /Connected as \$\{who\}\. This screen updates when your/);
  assert.doesNotMatch(html, /Preview the authenticated response/);
  assert.match(main, /onboardingAgents,\n\s+networkOnboardingCompleted,/, "the choice survives a restart");
  assert.match(main, /if \(serverAnswer\?\.kind === "hello" \|\| serverAnswer\?\.kind === "org"\) return "hello";/);
});
