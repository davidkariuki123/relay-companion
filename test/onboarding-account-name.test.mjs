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

// Fresh Mac VM, 2026-10-11: a sign-in state check still in flight when sign-in
// finished answered "consumed" late and put the person back on "Finishing
// setup…", where nothing moved them on.
test("a late sign-in answer never strands a signed-in person on Finishing setup", () => {
  const poll = html.slice(html.indexOf("  function pollInstallationState("), html.indexOf("  function pollInstallationState(") + 1600);
  assert.match(poll, /let state = await window\.relay\.installationAuthState\(\);\n[\s\S]*?if \(payload\.account\?\.paired !== false\) return;\n\s+applyInstallationState\(state\);/);
  const finishing = html.slice(html.indexOf("Never leave the person on this screen."), html.indexOf("Finishing setup…</h1>"));
  assert.match(finishing, /if \(payload\.account\?\.paired === true && payload\.ui\?\.onboardingRequired === true\) \{\n\s+signupStage = "first-relay";\n\s+renderSignup\(\);\n\s+return;/);
});

test("the four ideas have room, and a scrollbar, if any, is quiet", () => {
  assert.match(html, /\.su-idea-list \{ margin-top:16px; max-height:min\(340px, 52vh\);/);
  assert.match(html, /\.su-idea-list::-webkit-scrollbar-thumb \{ background:var\(--hair\);/);
  assert.match(html, /Send the link to whoever it’s for\./);
});
