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
