// ON THE WEB (2026-10-09): Claude's connector row read "2 chats connected ·
// used 29m ago" for a person who had not opened claude.ai: the server marks a
// connector seen on every request, a Claude Code session starting loads the
// Claude account's connector (measured), and a connector removed in claude.ai
// is never revoked here. The row says only Connected or Not connected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inbox = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
const row = inbox.slice(inbox.indexOf("function setupWebRowHtml(surface)"), inbox.indexOf("function permPrefsHtml()"));

test("the web rows say only Connected or Not connected, counting only connections still in use", () => {
  assert.match(row, /: live\.length \? \{ dot:"ok", text:"Connected" \}\s*: \{ dot:"", text:"Not connected" \};/);
  assert.doesNotMatch(row, /chats connected/, "no count of connections a person cannot verify");
  assert.doesNotMatch(row, /setupUsedWords\(newest\)/, 'no "used X ago" headline: a session starting is not using Relay');
  assert.match(inbox, /const SETUP_WEB_LIVE_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(row, /Not used since \$\{setupShortDate\(item\.lastUsedAt \|\| item\.createdAt\)\}/, "a leftover says so, and keeps its Disconnect");
  assert.match(row, /added \$\{setupShortDate\(item\.createdAt\)\}/, "two connectors are told apart by when each was added");
  assert.match(row, /: !live\.length \? `<button class="sv-choose setup-add" type="button" data-setup-web-connect="\$\{surface\}">Connect<\/button>`/);
  assert.match(row, /claude\.ai, the Claude app and Claude Code all use it/);
});

// RELAY_CHATGPT_APP (2026-10-09): with the server's switch on, the ChatGPT row
// connects by Relay's ChatGPT app like Claude's row, never by a setup code.
test("with the ChatGPT app on, the ChatGPT row connects by the app and waits for it", () => {
  assert.match(row, /const appConnects = surface === "chatgpt" && setupChatGptApp\(\);/);
  assert.match(row, /surface !== "claude" && !appConnects && setupSnapshot\?\.run\?\.surface === surface/, "no setup code with the app on");
  assert.match(row, /const appWaiting = appConnects && setupSnapshot\?\.chatgptConnector\?\.started && !appConnector;/);
  assert.match(row, /const waiting = run\?\.status === "pending" \|\| claudeWaiting \|\| appWaiting;/, "Waiting for ChatGPT… while the app is added");
  assert.match(row, /\$\{chatGptKeysHtml\(false, true\)\}/, "the clicks left in ChatGPT, drawn as keys");
  assert.match(inbox, /function setupChatGptApp\(\) \{\n\s+return payload\.features\?\.chatGptApp === true && typeof window\.relay\?\.setupConnectChatGptApp === "function";/);
  const start = inbox.slice(inbox.indexOf("async function setupStartWeb(surface)"), inbox.indexOf("function wireSetupReveal()"));
  assert.match(start, /if \(surface === "claude" \|\| \(surface === "chatgpt" && setupChatGptApp\(\)\)\)/);
  assert.match(start, /window\.relay\[surface === "claude" \? "setupConnectClaude" : "setupConnectChatGptApp"\]\(setupUserId\(\)\)/);
});
