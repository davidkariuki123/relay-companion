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

// Fresh Mac VM (2026-10-08): the person stepped away while Google's page was
// open; the pill came back as "Setup expired. Start setup again." with jargon
// about one-time approvals, though either sign-in button makes a fresh link.
test("a sign-in that lapsed before anyone chose an account returns to the first screen", () => {
  const start = html.indexOf("function expiredSignupStage(");
  const source = html.slice(start, html.indexOf("\n  }\n", start) + 4);
  const expiredSignupStage = new Function(`let signupAccount = null; ${source}; return expiredSignupStage;`)();
  assert.equal(expiredSignupStage(null), "method");
  assert.equal(expiredSignupStage(undefined), "method");
  assert.equal(expiredSignupStage({ email: "sam@example.com" }), "expired");
  assert.doesNotMatch(html, /signupStage = "expired"/, "every expiry goes through expiredSignupStage");
  const expired = html.slice(html.indexOf('if (signupStage === "expired") {'), html.indexOf("return;", html.indexOf('if (signupStage === "expired") {')));
  assert.match(expired, /That sign-in timed out\./);
  assert.match(expired, />Sign in again</);
  assert.doesNotMatch(expired, /authorization|approval|Restart setup/);
});

// Fresh Mac VM (2026-10-08): "Use email instead" opened the website's sign-in
// page in the browser; a new email there met "Couldn't find your account".
// The app has its own email + code screens, and the server makes the account.
test("Use email instead stays in the app", () => {
  const method = html.slice(html.indexOf('<p class="su-step">Welcome to Relay</p>'), html.indexOf('if (signupStage === "email") {'));
  assert.match(method, /getElementById\("suSignIn"\)\?\.addEventListener\("click", \(\) => \{ signupStage = "email";/);
  assert.doesNotMatch(method, /"suSignIn"\)\?\.addEventListener\("click", startInstallationSignIn\)/);
  assert.match(html, /<h1 class="su-title">What’s your email\?<\/h1>/);
});

// Fresh Mac VM (2026-10-08): the in-app email screen told a brand-new person
// "Your agent never sees it" and offered both Back and Cancel setup.
test("the email and code screens speak to a new person and offer one way back", () => {
  const screens = html.slice(html.indexOf('if (signupStage === "email") {'), html.indexOf('if (signupStage === "google") {'));
  assert.match(screens, /New or returning, Relay emails you a 6-digit code\./);
  assert.doesNotMatch(screens, /Your agent never sees it|cancelSetupButton|bindSignupCancel/);
  assert.match(screens, /id="suEmailBack" type="button">Back</);
  assert.match(screens, />Use another email</);
});

// Fresh Mac VM (2026-10-08): waiting on Google, the only way to email was
// Cancel setup; Google had just refused the person's address.
test("the browser wait offers email in one click", () => {
  const google = html.slice(html.indexOf('if (signupStage === "google") {'), html.indexOf('if (signupStage === "approval") {'));
  assert.match(google, /id="suUseEmail" type="button"\$\{busy\}>Use email instead</);
  assert.match(google, /getElementById\("suUseEmail"\)\?\.addEventListener\("click", \(\) => \{ stopSignupPolling\(\); signupStage = "email";/);
});

// Fresh Mac VM (2026-10-08): after a correct email code the pill showed
// "Continue in your browser" and waited forever; only the Google path has a
// browser that approves.
test("a verified email code finishes sign-in in the app", () => {
  const code = html.slice(html.indexOf('if (signupStage === "code") {'), html.indexOf('if (signupStage === "google") {'));
  assert.match(code, /installationAuthEmailVerify\(code\);\s*signupBusy = false; applyInstallationState\(state\);[\s\S]*?if \(state\?\.status === "pending_approval"\) \{ await approveSignupAccount\(\); return; \}/);
  const approve = html.slice(html.indexOf("async function approveSignupAccount()"), html.indexOf("function applyInstallationState("));
  assert.match(approve, /window\.relay\.installationAuthApprove\(\)/);
  assert.match(approve, /signupStage = "finishing"/);
  assert.match(html, /getElementById\("suApprove"\)\?\.addEventListener\("click", approveSignupAccount\);/);
});
