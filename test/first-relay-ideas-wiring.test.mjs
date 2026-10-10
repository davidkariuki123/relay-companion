import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// YOUR FIRST RELAY (2026-10-10): the pill's main process does the account step
// the AI used to run, opens the AI with one sentence, watches the AI's ideas,
// and routes a tap to a waiting AI or reopens the AI with the idea typed in.
// The behaviour is exercised in first-relay-ideas.test.mjs and the browser
// test; these pin the wiring that only exists inside Electron.

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const startHere = fs.readFileSync(new URL("../onboarding/START-HERE.md", import.meta.url), "utf8");
const slice = (source, start, end) => {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  assert.ok(j > i, `found after: ${end}`);
  return source.slice(i, j);
};

test("the AI is opened with one sentence: no paths, no run id, no sign-in", () => {
  assert.match(main, /const LOCAL_ONBOARDING_PROMPT = "Set up Relay with me\.";/);
  const prompt = slice(main, "function localOnboardingPrompt() {", "}\n");
  assert.doesNotMatch(prompt, /START-HERE|relay\.js|run\.id|browser/);
  assert.doesNotMatch(startHere, /onboarding start|--run|browser|Connect Relay/);
  assert.match(startHere, /relay_onboarding_current/);
});

test("choosing Claude Code, Codex or Conductor starts the setup and finishes the account step in the app", () => {
  assert.match(main, /const FIRST_RELAY_LOCAL_HOSTS = Object\.freeze\(\{ codex: "codex", "claude-code": "claude_code", conductor: "conductor" \}\);/);
  const prepare = slice(main, "async function prepareLocalFirstRelay(key, host) {", "\nlet firstRelayPreparing");
  assert.match(prepare, /firstRelayIdeas\(\)\.begin\(\{ accountId: who\.userId, host, \.\.\.firstRelayDestination\(key\)/);
  assert.match(prepare, /desktopOnboardingBridge\.prepareLocalAgent\(FIRST_RELAY_LOCAL_HOSTS\[host\]\)/);
  assert.match(prepare, /saveDesktopTeachingContext\(\{ directory: relayConfigDir\(\), run, apiUrl: apiUrl\(\) \}\)/);
  const choose = slice(main, 'ipcMain.handle("relay:onboardingChooseAgent"', "}));");
  assert.match(choose, /if \(FIRST_RELAY_LOCAL_HOSTS\[snapshot\.host\]\) void prepareLocalFirstRelayOnce\(key, snapshot\.host\);/);
  const open = slice(main, 'ipcMain.handle("relay:onboardingOpenAgent"', "}));");
  assert.match(open, /await \(firstRelayPreparing \|\| prepareLocalFirstRelayOnce\(key, host\)\);/, "the account step finishes before the AI looks for it");
  assert.match(open, /firstRelayIdeas\(\)\.markOpened\(\)/);
  const reset = slice(main, 'ipcMain.handle("relay:onboardingResetAgent"', "}));");
  assert.match(reset, /firstRelayIdeas\(\)\.end\(\)/, "a different AI starts afresh");
});

test("a tap with no AI waiting opens the AI again with that idea typed in; Conductor copies and opens its link", () => {
  const pick = slice(main, 'ipcMain.handle("relay:onboardingPickIdea"', "}));");
  assert.match(pick, /firstRelayIdeas\(\)\.pick\(String\(ideaId \|\| ""\), \{ accountId: who\.userId \}\)/);
  assert.match(pick, /if \(result\.mode === "reopened" && !result\.repeated\)/);
  assert.match(pick, /await openLocalAgent\(key, result\.state\.host, prompt\)/);
  assert.match(pick, /catch \{ clipboard\.writeText\(prompt\); opened = "copied"; \}/);
  const opener = slice(main, "async function openLocalAgent(key, host, prompt) {", "\n}\n");
  assert.match(opener, /if \(host !== "conductor"\) return agentOnboarding\.open\(key, prompt\);/);
  assert.match(opener, /clipboard\.writeText\(prompt\);/);
  assert.match(opener, /conductorLink\(\{ prompt \}\)/);
  assert.match(preload, /onboardingPickIdea: \(userId, ideaId\) => ipcRenderer\.invoke\("relay:onboardingPickIdea"/);
  assert.match(preload, /onboardingFocusAgent: \(userId\) => ipcRenderer\.invoke\("relay:onboardingFocusAgent"/);
  assert.match(preload, /copyFirstLink: \(userId\) => ipcRenderer\.invoke\("relay:copyFirstLink"/);
});

test("the pill repaints when the AI writes ideas, only while the first-run chapter is open, and ends the setup with it", () => {
  assert.match(main, /fs\.watchFile\(file, \{ interval: 1000, persistent: false \}/);
  assert.match(main, /syncFirstRelayIdeasWatch\(Boolean\(currentAccount\.paired && \(networkOnboardingState\.required \|\| completedOnboardingVersion < COMPANION_ONBOARDING_VERSION\)\)\);/);
  assert.match(main, /firstRelayIdeas: firstRelayIdeasSnapshot\(currentAccount\),/);
  assert.match(main, /payload\.ui\.firstRelayIdeas\],/, "a change in the ideas is a change in the pushed payload");
  const complete = slice(main, "async function completeSetupTutorial() {", "\n}\n");
  assert.match(complete, /firstRelayIdeas\(\)\.end\(\)/);
});

test("the pill draws the ideas flow for local AIs and keeps the chooser and chat AIs as they were", () => {
  const stage = slice(html, 'if (signupStage === "first-relay") {', 'if (signupStage === "restart-required") {');
  assert.match(stage, /if \(status !== "checking" && localAgent && !localAgent\.chat\) \{ renderLocalFirstRelay\(agent, localAgent\); return; \}/);
  const flow = slice(html, "  function renderLocalFirstRelay(agent, option) {", "  async function pickFirstRelayIdea(ideaId) {");
  for (const copy of [
    "Finding ideas for your first Relay.",
    "is looking at what you’ve worked on lately, so it can suggest something to send. Nothing goes to anyone yet.",
    "Press send in ${esc(name)}.",
    "What do you need from ${who ? esc(who) : \"someone\"} this week?",
    "Suggested by ${esc(name)} from your recent chats",
    "invited you, so they’re in your contacts",
    "is writing it.",
    "is writing to ${esc(inviter)}.",
    "It shows you the Relay and its link when it’s ready.",
    "You’ll see the message first, and nothing goes to ${esc(inviter)} until you say send.",
    "had stopped, so we opened it again with this typed in.",
  ]) assert.ok(flow.includes(copy), `copy: ${copy}`);
  assert.doesNotMatch(flow, /Skip/, "the picker has no skip link");
  assert.match(flow, /const FIRST_RELAY_HINT_MS = 60_000;|FIRST_RELAY_HINT_MS/);
  assert.match(html, /const FIRST_RELAY_HINT_MS = 60_000;/);
  assert.match(html, /Which AI do you use most\?/, "the chooser is unchanged");
});
