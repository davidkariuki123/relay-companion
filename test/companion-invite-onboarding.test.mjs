import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("all accounts cross a versioned, per-account, skippable invite-link onboarding", () => {
  assert.match(main, /const COMPANION_ONBOARDING_VERSION = 1/);
  assert.match(main, /onboardingVersions\[key\] = COMPANION_ONBOARDING_VERSION/);
  assert.match(main, /user:\$\{userId\}/);
  assert.match(main, /email:\$\{email\}/);
  assert.match(main, /device:\$\{createHash\("sha256"\)\.update\(token\)\.digest\("hex"\)\}/);
  assert.match(main, /onboardingRequired: currentAccount\.paired && completedOnboardingVersion < COMPANION_ONBOARDING_VERSION/);
  assert.match(html, /payload\.ui\?\.onboardingRequired === true/);
  assert.match(html, /Bring someone into Relay\./);
  assert.match(html, /id="suCopyInvite"/);
  assert.match(html, /id="suChatSkip"[\s\S]*Skip for now/);
});

test("invite-link onboarding calls the direct authenticated API and copies only in main", () => {
  assert.match(client, /this\.#req\("POST", "\/v1\/invite-link", \{\}\)/);
  assert.match(client, /this\.#req\("POST", "\/v1\/invites-v2\/link", \{\}\)/);
  assert.match(preload, /onboardingInviteLink: \(\) => ipcRenderer\.invoke\("relay:onboardingInviteLink"\)/);
  assert.match(preload, /copyOnboardingInviteLink: \(\) => ipcRenderer\.invoke\("relay:copyOnboardingInviteLink"\)/);
  assert.match(main, /clipboard\.writeText\(parsed\.toString\(\)\)/);
});
