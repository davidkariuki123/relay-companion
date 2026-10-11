import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");

// Live onboarding run, 2026-10-11: an email sign-up has no name, so the first
// Relay link was refused and Claude sent the new person to a settings page.
test("an account with no name is asked for one before choosing its AI", () => {
  const setup = html.slice(html.indexOf("  function renderAgentSetup(agent) {"), html.indexOf("  function renderAgentSetup(agent) {") + 200);
  assert.match(setup, /if \(accountNameMissing\(\)\) \{ renderAccountNameStep\(\); return; \}/, "first, before the AI list");
  assert.match(html, /payload\.account\?\.paired && !String\(payload\.account\?\.name \|\| ""\)\.trim\(\)/);
  assert.match(html, /<h1 class="su-title">What’s your name\?<\/h1>/);
  assert.match(html, /People see it on the Relays you send them\./);
  assert.match(html, /autocomplete="name"/);
  assert.match(preload, /setAccountName: \(name\) => ipcRenderer\.invoke\("relay:setAccountName"/);
  assert.match(main, /ipcMain\.handle\("relay:setAccountName"/);
  assert.match(main, /config\.writeConfig\(\{ user: \{ \.\.\.current\.user, name:/, "this computer's copy of the account follows");
  assert.match(client, /setAccountName\(name\) \{\n\s+return this\.#req\("POST", "\/v1\/me\/name", \{ name \}\);/);
});

test("the ideas say who suggested them, never claiming recent chats a new computer doesn't have", () => {
  assert.doesNotMatch(html, /from your recent chats/);
  assert.match(html, /: `Suggested by \$\{esc\(name\)\}`;/);
});
