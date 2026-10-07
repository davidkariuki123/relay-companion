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
    connectors: [],
    async mcpBrowserHandoff(provider) { calls.push(["handoff", provider]); return { url: "https://sendrelays.com/connect/claude#handoff=mcp_handoff.x.y" }; },
    async agentConnections() { calls.push(["connections"]); return { connections: this.connectors }; },
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
  return { onboarding, calls, store, opened, copied, client, tick: (ms) => { clock += ms; }, setStatus: (value) => { status = value; } };
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
  h.onboarding.choose(key, "chatgpt", "browser");
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

test("open puts the request in the AI's composer and on the clipboard", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "chatgpt", "browser");
  const created = await h.onboarding.prepare(key);
  assert.ok(created.run.open);
  const result = await h.onboarding.open(key);
  assert.equal(result.ok, true);
  assert.equal(h.opened.at(-1), "https://example.test/open?q=1");
  assert.equal(h.copied.at(-1).startsWith("Set up Relay for me."), true);
  await h.onboarding.copyPrompt(key);
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
  assert.match(html, /if \(status !== "checking" && agent && \(!onboardingAgentConnected\(agent\) \|\| claudeCelebrating\)\) \{ renderAgentSetup\(agent\); return; \}/);
  assert.match(html, /if \(option\.host === "claude"\) \{ renderClaudeConnect\(agent, option\); return; \}/, "Claude connects by connector, with no where screen");
  assert.match(html, /\[key\("Continue"\), `Scroll down <span class="su-wheel"[^`]*`, key\("Add"\), key\("Connect"\), key\("Allow"\)\]/, "the clicks are drawn as buttons, and scrolling to Add is a step of its own");
  assert.match(html, /Connected as \$\{who\}\. This screen updates when your/);
  assert.doesNotMatch(html, /Preview the authenticated response/);
  assert.match(main, /onboardingAgents,\n\s+networkOnboardingCompleted,/, "the choice survives a restart");
  assert.match(main, /if \(serverAnswer\?\.kind === "hello" \|\| serverAnswer\?\.kind === "org"\) return "hello";/);
});

test("Claude connects by connector: no place, one handoff link, and connecting moves the app on without opening or copying anything", async () => {
  const h = harness({ schemes: { "claude://": "Claude" } });
  const key = "user:usr_alex";
  const chosen = h.onboarding.choose(key, "claude", "browser");
  assert.equal(chosen.place, "", "Claude's connector works wherever Claude does, so no where");
  assert.deepEqual(chosen.connector, { started: false, connected: false, checked: false, error: "" });
  // First look: Claude has no Relay yet, and nothing opens on its own.
  assert.equal((await h.onboarding.poll(key)).connector.checked, true);
  assert.deepEqual(h.opened, []);
  const started = await h.onboarding.connectClaude(key);
  assert.deepEqual(h.calls.filter(([name]) => name === "handoff"), [["handoff", "claude"]]);
  assert.equal(h.opened[0], "https://sendrelays.com/connect/claude#handoff=mcp_handoff.x.y");
  assert.equal(started.connector.started, true);
  assert.equal((await h.onboarding.poll(key)).connectedAt, "", "still waiting for Claude");
  assert.equal(h.calls.some(([name]) => name === "create"), false, "Claude never gets a setup code");
  h.client.connectors = [{ kind: "connector", surface: "claude", name: "Claude", createdAt: "2026-10-07T12:02:00.000Z" }];
  const opensBefore = h.opened.length;
  const connected = await h.onboarding.poll(key);
  assert.ok(connected.connectedAt, "the app moves on to copying the first message");
  assert.equal(h.opened.length, opensBefore, "nothing opens by itself");
  assert.deepEqual(h.copied, [], "nothing is copied behind the person's back");
  // The person copies, then opens Claude.
  await h.onboarding.copyPrompt(key);
  assert.equal(h.copied.at(-1), "Help me send my first Relay to Sam.", "the person names who it is for, so Claude's safety check sees it came from them");
  await h.onboarding.open(key);
  assert.equal(h.opened.at(-1), "claude://claude.ai/new?surface=chat", "the Claude app, which owns claude://, with no prefill (Claude bannered prefilled links)");
});

test("a Claude that already has Relay goes straight to copying; Open Claude opens claude.ai when no Claude app is here", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.client.connectors = [{ kind: "connector", surface: "claude", name: "Claude", createdAt: "2026-09-01T00:00:00.000Z" }];
  h.onboarding.choose(key, "claude");
  const seen = await h.onboarding.poll(key);
  assert.equal(seen.connector.connected, true);
  assert.ok(seen.connectedAt, "no Add screen for a Claude that has Relay");
  assert.deepEqual(h.opened, [], "nothing opens by itself");
  assert.deepEqual(h.copied, [], "nothing is copied by itself");
  await h.onboarding.open(key);
  assert.equal(h.opened.at(-1), "https://claude.ai/new");
  assert.deepEqual(h.copied, [], "opening Claude never touches the clipboard");
});

test("a ChatGPT connector never counts as Claude's", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "claude");
  await h.onboarding.connectClaude(key);
  h.client.connectors = [{ kind: "connector", surface: "chatgpt", name: "ChatGPT", createdAt: "2026-10-07T12:02:00.000Z" }];
  assert.equal((await h.onboarding.poll(key)).connectedAt, "");
});

test("Claude's first sentence names who the first Relay is for", async () => {
  const { claudeStartPrompt } = require("../overlay/agent-onboarding.cjs");
  assert.equal(claudeStartPrompt({ kind: "hello", inviter: { name: "Sam Taylor", relayUserId: "usr_sam" } }), "Help me send my first Relay to Sam Taylor.");
  assert.equal(claudeStartPrompt({ kind: "org", org: { name: "Harbor Coffee", groupId: "grp_1" } }), "Help me send my first Relay to Harbor Coffee.");
  assert.equal(claudeStartPrompt({ kind: "link" }), "Help me make my first Relay link.");
  assert.equal(claudeStartPrompt({ kind: "done" }), "Help me get started with Relay.");
  assert.equal(claudeStartPrompt(null), "Help me get started with Relay.");
});

test("Copy it again copies Claude's start sentence, not a setup code", async () => {
  const h = harness();
  const key = "user:usr_alex";
  h.onboarding.choose(key, "claude");
  await h.onboarding.refreshServer(key);
  assert.deepEqual(await h.onboarding.copyPrompt(key), { ok: true });
  assert.equal(h.copied.at(-1), "Help me send my first Relay to Sam.");
  assert.equal(h.calls.some(([name]) => name === "create"), false, "Claude never gets a setup code");
});
