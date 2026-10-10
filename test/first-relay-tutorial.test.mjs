import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../overlay/first-relay-tutorial.cjs");
const settings = require("../src/relay-settings.cjs");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

const welcome = (extra = {}) => ({ id: "relay_welcome", threadId: "t_w", direction: "inbound", title: "Welcome to Relay",
  senderName: "Relay Agent", senderEmail: "agent@sendrelays.com", forHuman: "Relay is connected.", forAgent: "## What this is\n…",
  createdAt: "2026-10-10T09:00:00Z", ...extra });

// THE FIRST RELAY TUTORIAL (David, 2026-10-10): board candidate D, word for word,
// then opening the Relay in the AI they chose at onboarding.
const plain = (b) => b.say.replace(/<\/?b>/g, "");
const BASE_COPY = [
  "Start here. Open your chat with Relay Agent.",
  "This card is a Relay. Open it.",
  "This part is for you. Just the short version: what’s going on and what’s needed from you.",
  "You never have to wade through AI slop.",
  "Now open the part for your AI.",
  "This part is for your AI: all the detail and context, so it can answer your questions or do the work.",
  "Your AI reads both parts. You only need the top one.",
];
test("seven steps: the two parts, then open it in your AI, with the board's copy exactly", () => {
  assert.equal(T.TOTAL, 7);
  assert.deepEqual(T.BEATS.map((b) => [b.id, b.step, b.kind, b.advance || ""]), [
    ["row", 1, "click", ""], ["card", 2, "click", ""], ["you1", 3, "explain", ""], ["you2", 3, "explain", ""],
    ["agent", 4, "click", ""], ["ai", 4, "explain", ""], ["both", 5, "explain", ""],
    ["open", 6, "click", "click"], ["menu", 6, "click", "click"], ["opening", 7, "pause", ""], ["end", 7, "finish", ""],
  ]);
  assert.deepEqual(T.BEATS.slice(0, 7).map(plain), BASE_COPY);
  assert.deepEqual(T.BEATS.slice(7).map(plain), [
    "Open it in Codex. Your AI gets both parts, ready to go.",
    "Pick New Codex task to start fresh.",
    "Well done. It’s opening in your Codex now.",
    "That’s the tutorial. You’re all set.",
  ]);
  assert.ok(Object.isFrozen(T.BEATS) && T.BEATS.every(Object.isFrozen));
});

test("each AI has its own path: the chat apps and Conductor open at once, Claude Code and Codex through New", () => {
  const path = (key) => T.plan(T.HOSTS[key]).slice(7).map((b) => `${b.id}:${plain(b)}`);
  assert.deepEqual(path("claude"), ["open:Open it in Claude. Your AI gets both parts, ready to go.", "opening:Well done. It’s opening in your Claude now.", "end:That’s the tutorial. You’re all set."]);
  assert.deepEqual(path("chatgpt"), ["open:Open it in ChatGPT. Your AI gets both parts, ready to go.", "opening:Well done. It’s opening in your ChatGPT now.", "end:That’s the tutorial. You’re all set."]);
  assert.deepEqual(path("conductor"), ["open:Open it in Conductor. Your AI gets both parts, ready to go.", "opening:Well done. It’s opening in your Conductor now.", "end:That’s the tutorial. You’re all set."]);
  assert.deepEqual(path("claude-code"), ["open:Open it in Claude Code. Your AI gets both parts, ready to go.", "menu:Pick New Claude Code session to start fresh.",
    "opening:Well done. It’s opening in your Claude Code now.", "end:That’s the tutorial. You’re all set."]);
  assert.equal(T.plan(T.HOSTS.codex).find((b) => b.id === "menu").optional, true, "a menu that can't be anchored is skipped");
  // With no app to open in, it ends at both parts.
  const none = T.plan(null);
  assert.deepEqual(none.map(plain), BASE_COPY);
  assert.equal(none.at(-1).kind, "finish");
  assert.equal(T.totalOf(none), 5);
  // The reader's tiles are the pill's own data-host keys.
  assert.deepEqual(Object.values(T.HOSTS).map((h) => [h.key, h.tile]), [["claude", "claude-app"], ["chatgpt", "chatgpt"], ["claude-code", "claude"], ["codex", "codex"], ["conductor", "conductor"]]);
});

test("the AI chosen at onboarding, when the reader offers it; otherwise the first app it offers", () => {
  const row = ["claude-app", "chatgpt", "claude", "codex"];
  assert.equal(T.hostFor("codex", row).key, "codex");
  assert.equal(T.hostFor("claude-code", row).key, "claude-code");
  assert.equal(T.hostFor("claude", row).key, "claude", "Claude in a browser or the app is the Claude chat tile");
  assert.equal(T.hostFor("conductor", row).key, "claude", "Conductor switched off here: the first app offered");
  assert.equal(T.hostFor("", ["codex", "claude"]).key, "codex", "unknown choice: first offered");
  assert.equal(T.hostFor("codex", ["mystery"]), null);
  assert.equal(T.hostFor("codex", []), null, "nothing to open in");
});

test("the welcome Relay is Relay Agent's inbound welcome with an agent part; nothing else qualifies", () => {
  assert.equal(T.findWelcomeRelay([welcome()]).id, "relay_welcome");
  assert.equal(T.findWelcomeRelay([welcome({ senderEmail: "someone@x.test" })]).id, "relay_welcome", "the sender's name is enough");
  assert.equal(T.findWelcomeRelay([welcome({ senderName: "Relay", senderEmail: "AGENT@sendrelays.com" })]).id, "relay_welcome", "or its address");
  for (const miss of [{ deletedAt: "2026-10-10T10:00:00Z" }, { direction: "outbound" }, { title: "Welcome to Relay!" }, { forAgent: " " },
    { senderName: "Sven", senderEmail: "sven@x.test" }]) assert.equal(T.findWelcomeRelay([welcome(miss)]), null, JSON.stringify(miss));
  assert.equal(T.findWelcomeRelay(undefined), null);
  const older = welcome({ id: "old", createdAt: "2026-10-01T00:00:00Z" });
  assert.equal(T.findWelcomeRelay([older, welcome()]).id, "relay_welcome", "the newest one");
});

test("it starts only with a welcome Relay, in the small card, and never again after Done or Skip", () => {
  assert.equal(T.shouldStart({ welcome: welcome() }), true);
  assert.equal(T.shouldStart({ welcome: null }), false, "no welcome Relay: nothing to teach on");
  assert.equal(T.shouldStart({ welcome: welcome(), saved: "done" }), false);
  assert.equal(T.shouldStart({ welcome: welcome(), saved: "skipped" }), false);
  assert.equal(T.shouldStart({ welcome: welcome(), saved: "bogus" }), true, "an unknown saved value is not a result");
  assert.equal(T.shouldStart({ welcome: welcome(), wide: true }), false, "the expanded app has no small-card Inbox");
});

test("the state machine: clicks advance on arrival, opens on the click, Next on explain beats, Done at the end", () => {
  const run = (beats, events) => events.reduce((s, e) => T.reduce(s, e, beats), T.initial());
  const lesson = [{ type: "start" }, { type: "reached", id: "row" }, { type: "reached", id: "card" }, { type: "next" }, { type: "next" },
    { type: "reached", id: "agent" }, { type: "next" }, { type: "next" }];
  let s = T.initial();
  assert.deepEqual(T.reduce(s, { type: "next" }), s, "nothing happens before start");
  s = T.reduce(s, { type: "start" });
  assert.deepEqual(s, { status: "running", index: 0 });
  assert.deepEqual(T.reduce(s, { type: "start" }), s, "start is once");
  assert.deepEqual(T.reduce(s, { type: "next" }), s, "Next does not skip a click");
  assert.deepEqual(T.reduce(s, { type: "clicked", id: "row" }), s, "the row advances on arrival in the chat, not on the click");
  assert.deepEqual(T.reduce(s, { type: "reached", id: "card" }), s, "arriving somewhere else is not this step");
  // Codex: open → New Codex task → opening → Done
  const codex = T.plan(T.HOSTS.codex);
  s = run(codex, lesson);
  assert.equal(codex[s.index].id, "open");
  assert.deepEqual(T.reduce(s, { type: "reached", id: "open" }, codex), s, "Open in advances on its click");
  assert.deepEqual(T.reduce(s, { type: "next" }, codex), s);
  s = T.reduce(s, { type: "clicked", id: "open" }, codex);
  assert.equal(codex[s.index].id, "menu");
  s = T.reduce(s, { type: "clicked", id: "menu" }, codex);
  assert.equal(codex[s.index].id, "opening");
  assert.deepEqual(T.reduce(s, { type: "done" }, codex), s, "Done only on the last beat");
  s = T.reduce(s, { type: "next" }, codex);
  assert.equal(codex[s.index].id, "end");
  const done = T.reduce(s, { type: "done" }, codex);
  assert.deepEqual(done, { status: "done", index: codex.length - 1 });
  assert.equal(T.resultFor(done), "done");
  assert.deepEqual(T.reduce(done, { type: "skip" }, codex), done, "a finished tutorial stays finished");
  // Codex whose menu never showed New: the step is skipped, not the tutorial.
  let m = run(codex, [...lesson, { type: "clicked", id: "open" }]);
  assert.deepEqual(T.reduce(m, { type: "missing", id: "open" }, codex), m, "only an optional beat can go missing");
  m = T.reduce(m, { type: "missing", id: "menu" }, codex);
  assert.equal(codex[m.index].id, "opening");
  // ChatGPT (and Claude, Conductor): open → opening → Done
  const chat = T.plan(T.HOSTS.chatgpt);
  const c = run(chat, [...lesson, { type: "clicked", id: "open" }, { type: "next" }, { type: "done" }]);
  assert.deepEqual(c, { status: "done", index: chat.length - 1 });
  // No app to open in: Done at both parts.
  const none = T.plan(null);
  assert.deepEqual(run(none, [...lesson.slice(0, -1), { type: "done" }]), { status: "done", index: 6 });
});

test("Skip and a vanished target end it from anywhere, and both are saved so it never returns", () => {
  const running = T.reduce(T.reduce(T.initial(), { type: "start" }), { type: "reached", id: "row" });
  const skipped = T.reduce(running, { type: "skip" });
  assert.equal(skipped.status, "skipped");
  assert.equal(T.resultFor(skipped), "skipped");
  const lost = T.reduce(running, { type: "lost" });
  assert.equal(lost.status, "lost");
  assert.equal(T.resultFor(lost), "done", "a deleted welcome never brings the tutorial back");
  assert.equal(T.resultFor(running), null, "nothing is saved while it runs");
  assert.equal(T.resultFor(T.initial()), null);
});

test("arrival is read from the app: the room with the welcome, its reader, its agent part open", () => {
  const [row, card, , , agent, ai] = T.BEATS;
  const open = T.BEATS.find((b) => b.id === "open");
  assert.equal(T.reached(open, { view: "reader", readerId: "relay_welcome", detailsOpen: true }, "relay_welcome"), false, "an open is never read from the app");
  assert.equal(T.reached(row, { view: "threads", roomHasWelcome: true }, "relay_welcome"), true);
  assert.equal(T.reached(row, { view: "threads", roomHasWelcome: false }, "relay_welcome"), false, "another chat is not the welcome");
  assert.equal(T.reached(card, { view: "reader", readerId: "relay_welcome" }, "relay_welcome"), true);
  assert.equal(T.reached(card, { view: "reader", readerId: "other" }, "relay_welcome"), false);
  assert.equal(T.reached(agent, { view: "reader", readerId: "relay_welcome", detailsOpen: false }, "relay_welcome"), false);
  assert.equal(T.reached(agent, { view: "reader", readerId: "relay_welcome", detailsOpen: true }, "relay_welcome"), true);
  assert.equal(T.reached(ai, { view: "reader", readerId: "relay_welcome", detailsOpen: true }, "relay_welcome"), false, "explain beats never arrive by themselves");
});

test("the result is the account's: settings.json keeps done or skipped, per account, and nothing else", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-frt-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, env: { RELAY_CONFIG_DIR: path.join(homeDir, ".relay") } };
  assert.equal(settings.pillSnapshot("usr_a", options).firstRelayTutorial, undefined);
  settings.savePillChoices("usr_a", { firstRelayTutorial: "maybe" }, options);
  assert.equal(settings.pillSnapshot("usr_a", options).firstRelayTutorial, undefined, "an unknown value is ignored");
  settings.savePillChoices("usr_a", { firstRelayTutorial: "skipped" }, options);
  assert.equal(settings.pillSnapshot("usr_a", options).firstRelayTutorial, "skipped");
  settings.savePillChoices("usr_a", { firstRelayTutorial: "done" }, options);
  assert.equal(settings.pillSnapshot("usr_a", options).firstRelayTutorial, "done");
  assert.equal(settings.pillSnapshot("usr_b", options).firstRelayTutorial, undefined, "another account still gets its tutorial");
  settings.savePillChoices(null, { firstRelayTutorial: "done" }, options);
  assert.equal(settings.pillSnapshot("", options).firstRelayTutorial, undefined, "signed out: nothing saved");
});

test("the pill loads it, scopes the result to the account, and starts it as onboarding ends, before the old landing", () => {
  assert.match(html, /<link rel="stylesheet" href="\.\/first-relay-tutorial\.css" \/>/);
  assert.match(html, /<script src="\.\/first-relay-tutorial\.cjs"><\/script>/);
  assert.match(html, /const ACCOUNT_SETTING_KEYS = new Set\(\[[^\]]*"firstRelayTutorial"[^\]]*\]\);/);
  const finish = html.slice(html.indexOf("  async function finishNetworkInvitation() {"), html.indexOf("  function openFirstRelayRoom("));
  const starts = finish.indexOf("startFirstRelayTutorial(account)"), lands = finish.indexOf("openFirstRelayRoom(firstRelayId)");
  assert.ok(starts > 0 && lands > starts, "the tutorial is tried first; the room of the Relay they wrote is the fallback");
  const start = html.slice(html.indexOf("  function startFirstRelayTutorial(account) {"), html.indexOf("  let firstRelayLanding = null;"));
  assert.match(start, /tutorial\.shouldStart\(\{ welcome, saved: storedSettings\(\)\.firstRelayTutorial, wide: wideLayoutActive\(\) \}\)/);
  assert.match(start, /activeView = "relays";\s*relaysLayout = "chats";/);
  assert.match(start, /savePillSetting\(\{ firstRelayTutorial: result \}\)/);
  assert.match(start, /reducedMotion: \(\) => REDUCED/);
});

// The AI chosen at "Which AI do you use most?" is the account's, durably:
// agent-onboarding.cjs keeps it in the overlay prefs store and the pill reads
// it from payload.ui.onboardingAgent. The tutorial takes it from there.
test("the onboarding choice is kept per account across restarts, and the tutorial reads it", async () => {
  const { createAgentOnboarding } = require("../overlay/agent-onboarding.cjs");
  const store = {};
  let persisted = 0;
  const make = () => createAgentOnboarding({ store, persist: () => { persisted += 1; }, client: async () => ({}), schemeOwner: () => "", openExternal: async () => {}, writeClipboard: () => {} });
  make().choose("usr_a", "codex");
  assert.ok(persisted >= 1, "the choice is written out");
  const restarted = JSON.parse(JSON.stringify(store)); // what overlay-prefs.json holds
  Object.keys(store).forEach((k) => delete store[k]);
  Object.assign(store, restarted);
  assert.equal(make().snapshot("usr_a").host, "codex", "a restart reads it back");
  assert.equal(make().snapshot("usr_b").host, "", "another account has its own");
  const start = html.slice(html.indexOf("  function firstRelayTutorialApp(welcomeId) {"), html.indexOf("  function startFirstRelayTutorial(account) {"));
  assert.match(start, /chosenHost: String\(payload\.ui\?\.onboardingAgent\?\.host \|\| ""\)/);
});
