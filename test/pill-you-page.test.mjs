import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return html.slice(start, end);
}

// THE YOU PAGE (Sven, 2026-09-08, the Minimal design): Settings is you — your
// avatar as the tab, the account as a row you tap, your agent, your link,
// notifications, the version. "Settings is so much cleaner my way."

test("the tab strip ends in your avatar, not a Settings word", () => {
  assert.match(html, /<button class="tab tab-you" type="button" data-view="settings" aria-label="You"><span class="tab-avatar word" id="youTabAvatar" aria-hidden="true">You<\/span><\/button>/);
  assert.doesNotMatch(html, /data-view="settings">Settings</);
  // Initials once paired; the word until then. Words over glyphs.
  const tabs = slice("function syncTabs()", "function applyView()");
  assert.match(tabs, /youTabAvatarEl\.textContent = paired \? cvInitials\(payload\.account\.name, payload\.account\.email\) : "You";/);
});

test("the account is a row you tap; its actions unfold beneath it", () => {
  const settings = slice("function renderSettings()", "function wireSettings()");
  assert.match(settings, /<button class="sv-account\$\{svAccountOpen \? " open" : ""\}" type="button" id="svAccountRow" aria-expanded=/);
  assert.match(settings, /\$\{svAccountOpen \? `<div class="open-actions sv-actions" id="svAccountActions"/);
  assert.doesNotMatch(settings, /sv-device">This device/, "the device line is gone");
  // The row is wired where the page paints, beside the other value rows.
  assert.match(settings, /svAccountOpen = !svAccountOpen;/);
  // Leaving the page folds the row, the way it disarms Sign Out.
  assert.match(html, /resetSignOutArm\(\); \/\/ leaving the view disarms the confirm state\s*svAccountOpen = false;/);
});

test("Your agent restores independent switches and a same-list own-session choice", () => {
  const agent = slice("function yourAgentHtml()", "function yourLinkHtml()");
  assert.match(agent, /<div class="sv-open-title">Your agent<\/div>/);
  assert.match(agent, /Choose which agents you use\. Turn on one or more\./);
  assert.match(agent, /role="switch" data-agent-app="\$\{app\}" aria-checked=/);
  assert.match(agent, /svOtherAgent/);
  assert.match(agent, /Relay copies the sentence for you/);
  assert.doesNotMatch(agent, /svOpeningSurface|<select|Opening an app does not|Available ·/);
  assert.match(agent, /Connected · opens relays in a new chat/);
});

test("Your invite link is on the page with Copy, and says what joining through it does", () => {
  const link = slice("function yourLinkHtml()", "async function copyInviteLinkFromSettings()");
  assert.match(link, /<div class="sv-open-title">Your invite link<\/div>/);
  // Redeeming an invite writes both contacts (apps/api invites.ts), so the
  // person lands in Contacts. The old line promised Requests, which was untrue.
  assert.match(link, /Share it with someone you want to message on Relay\./);
  assert.match(link, /When they join, you’ll find each other in Contacts\./);
  assert.match(link, /class="sv-invite-field"/);
  assert.doesNotMatch(link, /waits in Requests/);
  assert.match(link, /id="svCopyLink"[^>]*>\$\{inviteLinkCopied \? "Copied" : "Copy link"\}/);
  // The renderer never mints or copies the link itself: main does both, so
  // the account token that mints it never reaches this process.
  const copy = slice("async function copyInviteLinkFromSettings()", "function deviceApprovalsHtml(info)");
  assert.match(copy, /await window\.relay\.copyOnboardingInviteLink\(\)/);
  assert.doesNotMatch(copy, /navigator\.clipboard/);
  const load = slice("async function loadSettings()", "// Provider state is live product state");
  assert.match(load, /await window\.relay\.onboardingInviteLink\(\)/);
  assert.match(load, /if \(!window\.relay\.onboardingInviteLink \|\| payload\.account\?\.paired === false\) return;/);
});

test("candidate B sits directly below account and above agent settings", () => {
  const settings = slice("function renderSettings()", "function wireSettings()");
  const order = ["svAccountRow", "yourLinkHtml()", "yourAgentHtml()", "slackSettingsHtml(info)", "connectionsHtml(info", "quietPrefsHtml(info)", "sv-colophon"]
    .map((marker) => settings.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), order);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
