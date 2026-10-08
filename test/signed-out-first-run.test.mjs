import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

// Live run 27 (2026-10-08): a fresh, signed-out install read "your Relays open
// right here" before having any Relay, then "Your agent cannot see this
// sign-in" before choosing any AI.
test("a fresh install's sign-in speaks to someone with no Relays and no AI yet", () => {
  assert.match(html, /Relay is set up on this computer\. Sign in once and it's ready\./);
  assert.doesNotMatch(html, /your Relays open right here/);
  const google = html.slice(html.indexOf('if (signupStage === "google") {'), html.indexOf("bindSignupResume();", html.indexOf('if (signupStage === "google") {')));
  assert.match(google, /Look for the new tab in your browser\./);
  assert.doesNotMatch(google, /Your agent cannot see this sign-in/);
});

test("the sign-in page opens through the same test seam as every other link", () => {
  assert.match(main, /function openExternalOrTestSeam\(url\)/);
  const controller = main.slice(main.indexOf("createInstallationAuthorizationController({"), main.indexOf("onConnected:", main.indexOf("createInstallationAuthorizationController({")));
  assert.match(controller, /openExternal: \(url\) => openExternalOrTestSeam\(url\)/);
  assert.doesNotMatch(controller, /shell\.openExternal/);
});

// Live run 28 (2026-10-08): Codex opened with the message typed in, under a
// title that said "Paste this into Codex"; after Copy prompt, only a footnote
// changed.
test("a local AI that opens with the message typed is the same two clicks as ChatGPT", () => {
  assert.match(html, /\|\| \(!option\.chat && canOpen && localPromptCopiedFor !== option\.host\)\) \{/);
  assert.match(html, /option\.chat \? `This moves on when \$\{option\.name\} connects\.` : "This screen moves on by itself\."/);
  assert.match(html, /\.su-key-send\.codex/);
});

test("after copying for a local AI, the screen shows the steps left to do there", () => {
  const copied = html.slice(html.indexOf("if (!option.chat && localPromptCopiedFor === option.host) {"), html.indexOf("Paste this into<br>${onboardingAgentTitleName(agent)}.</h1>\n      <div"));
  assert.match(copied, /<div class="su-keys-row is-done"><span class="su-keys-n">1\$\{tick\}<\/span>Copied<\/div>/);
  assert.match(copied, /Open \$\{esc\(option\.name\)\} <span class="su-keys-where">/);
  assert.match(copied, /Press <span class="su-key">\$\{paste\}<\/span> then <span class="su-key">Return<\/span>/);
  assert.match(copied, /data-agent-copy>Copy again<\/button>/);
  assert.match(html, /else \{ localPromptCopiedFor = option\?\.host \|\| ""; onboardingAgentNote = ""; \}/);
  assert.match(html, /stopOnboardingAgentPoll\(\); onboardingAgentNote = ""; localPromptCopiedFor = "";/);
});
