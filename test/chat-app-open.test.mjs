import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { chatAppTargets, CLAUDE_SCHEME } = require("../overlay/chat-app-open.cjs");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

const PROMPT = 'Pull Shane’s relay "Sign the Mac installer" from Relay and tell me what’s happening. Use the Relay connector\'s tools for this (relay_inbox_list, relay_chat_fetch). If Relay is not connected here, tell me and I will connect it from the Relay app.';
const owns = (scheme) => (scheme === CLAUDE_SCHEME ? "Claude" : "");
const ownsNothing = () => "";

// David clicked Open in Claude in the pill and got Chrome (2026-09-17): the
// https link never reaches the Claude app on a computer. With the app here,
// the tile goes through the app's own scheme, the same link its Dock menu's
// New Chat uses, with the sentence in the composer.
test("the Claude tile opens the Claude app when the OS says it owns claude://, claude.ai when nothing does", () => {
  const withApp = chatAppTargets("claude", PROMPT, { schemeOwner: owns });
  assert.equal(withApp.via, "app");
  assert.ok(withApp.primary.startsWith("claude://claude.ai/new?surface=chat&q="));
  const url = new URL(withApp.primary);
  assert.equal(url.protocol, "claude:");
  assert.equal(url.hostname, "claude.ai");
  assert.equal(url.pathname, "/new");
  assert.equal(url.searchParams.get("surface"), "chat");
  assert.equal(url.searchParams.get("q"), PROMPT);
  // The web app stands behind it for the case the OS refuses the link after all.
  assert.equal(withApp.fallback, `https://claude.ai/new?q=${encodeURIComponent(PROMPT)}`);

  const without = chatAppTargets("claude", PROMPT, { schemeOwner: ownsNothing });
  assert.deepEqual(without, { primary: `https://claude.ai/new?q=${encodeURIComponent(PROMPT)}`, fallback: "", via: "web" });
});

test("no answer from the OS, or a throwing one, means the web app", () => {
  assert.equal(chatAppTargets("claude", PROMPT).via, "web");
  assert.equal(chatAppTargets("claude", PROMPT, { schemeOwner: () => { throw new Error("no LaunchServices"); } }).via, "web");
  assert.equal(chatAppTargets("claude", PROMPT, { schemeOwner: () => "   " }).via, "web");
});

// ChatGPT registers no chatgpt:// on a computer (only codex://, which is the
// Codex surface), so the tile stays chatgpt.com in Work mode whatever the OS says.
test("the ChatGPT tile is always the web app, in Work mode", () => {
  for (const schemeOwner of [owns, ownsNothing, () => "ChatGPT"]) {
    const t = chatAppTargets("chatgpt", PROMPT, { schemeOwner });
    assert.equal(t.via, "web");
    assert.equal(t.fallback, "");
    const url = new URL(t.primary);
    assert.equal(url.origin, "https://chatgpt.com");
    assert.equal(url.searchParams.get("q"), PROMPT);
    assert.equal(url.searchParams.get("mode"), "work");
  }
});

test("main asks the OS at the click, opens the app first, and falls back to the web link only when the app refused", () => {
  const fn = main.slice(main.indexOf("async function openChatApp("), main.indexOf("ipcMain.handle(\"relay:openChatApp\""));
  assert.match(fn, /chatAppTargets\(/);
  assert.match(fn, /app\.getApplicationNameForProtocol\(scheme\)/, "the OS's registration, never a path check");
  assert.match(fn, /RELAY_OVERLAY_TEST_NO_HOST_OPEN/, "a sandbox run never pops an app or the browser");
  assert.ok(fn.indexOf("shell.openExternal(targets.primary)") < fn.indexOf("shell.openExternal(targets.fallback)"));
  assert.match(fn, /if \(!targets\.fallback\) return/);
  assert.match(main, /ipcMain\.handle\("relay:openChatApp", \(_e, chatApp, prompt\) => openChatApp\(String\(chatApp \|\| ""\), String\(prompt \|\| ""\)\)\)/);
  assert.match(preload, /openChatApp: \(app, prompt\) => ipcRenderer\.invoke\("relay:openChatApp"/);
});

test("the renderer hands the tile to main and never builds the https link itself when the bridge is there", () => {
  const click = inbox.slice(inbox.indexOf('scope.querySelectorAll("[data-app-open]")'), inbox.indexOf('scope.querySelectorAll("[data-pull-copy]")'));
  assert.match(click, /openChatApp\(b\.getAttribute\("data-app"\), message\)/);
  assert.equal(click.includes("claude.ai/new"), false);
  const opener = inbox.slice(inbox.indexOf("  function openChatApp(app, message)"), inbox.indexOf("  function hostOptions("));
  assert.match(opener, /window\.relay\.openChatApp\(key, prompt\)/);
  // The bridge's absence (an older preload) keeps the web app, so the click
  // still opens something.
  assert.match(opener, /claude\.ai\/new\?q=/);
  assert.equal(inbox.includes("chatAppUrlFor"), false);
  // Settings says which it is on this Mac.
  const settings = inbox.slice(inbox.indexOf("  function yourAgentHtml()"), inbox.indexOf("  function blockedPeopleHtml()"));
  assert.match(settings, /desktopEntry\("Claude Code"\)\?\.available === true \? "Claude app" : "claude\.ai"/);
});
