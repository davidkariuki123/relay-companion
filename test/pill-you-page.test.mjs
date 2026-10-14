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
  // Sven's cut (2026-10-08): your name in serif and your email head the page;
  // the old avatar-and-"Settings" button is gone.
  assert.match(settings, /<div class="sv-profile">\s*<div class="sv-profile-name">\$\{esc\(name\)\}<\/div>\s*\$\{info\.email \? `<div class="sv-profile-email">\$\{esc\(info\.email\)\}<\/div>` : ""\}\s*<\/div>/);
  assert.doesNotMatch(settings, /class="sv-account|sv-avatar|sv-account-more|"Close" : "Settings"/);
  assert.doesNotMatch(settings, /sv-device">This device/, "the device line is gone");
  // The account is the last row of the page's last card, after Blocked people.
  const account = slice("function accountRowHtml()", "function yourLinkHtml()");
  assert.match(account, /<button class="sv-row\$\{svAccountOpen \? " open" : ""\}" type="button" id="svAccountRow" aria-expanded="\$\{svAccountOpen \? "true" : "false"\}" aria-controls="svAccountActions">\s*<span class="sv-row-copy"><span class="sv-row-name">Relay account<\/span><\/span>/);
  assert.match(account, /\$\{svAccountOpen \? `<div class="sv-row-actions" id="svAccountActions" aria-label="Account actions">/);
  assert.match(account, /id="svAccount" [^>]*><span class="sv-row-copy"><span class="sv-row-name">Account settings<\/span>/);
  assert.match(account, /id="svSwitch" [^>]*><span class="sv-row-copy"><span class="sv-row-name">Switch account<\/span>/);
  assert.match(account, /id="svSignOut" [^>]*><span class="sv-row-copy"><span class="sv-row-name danger">\$\{svSignOutArmed \? "Sign out — click again to confirm" : "Sign out"\}<\/span>/);
  assert.match(settings, /html \+= `<div class="sv-group" data-stop="1"><div class="sv-open-list">\$\{blockedPeopleHtml\(\)\}\$\{accountRowHtml\(\)\}<\/div><\/div>`;\s*html \+= accountNotes;/);
  // Each unfolded row still does its job.
  const wire = slice("function wireSettings()", "const codeCells =");
  assert.match(wire, /document\.getElementById\("svAccount"\);\s*if \(accountEl\) \{\s*accountEl\.addEventListener\("click"/);
  assert.match(wire, /if \(switchEl\) switchEl\.addEventListener\("click", beginPairFlow\);/);
  assert.match(wire, /if \(signOutEl\) signOutEl\.addEventListener\("click", onSignOutClick\);/);
  // Blocked people is a row on You that opens its page.
  assert.match(slice("function blockedPeopleHtml()", "function accountRowHtml()"), /<button class="sv-row" id="svBlockedPeople" type="button"><span class="sv-row-copy"><span class="sv-row-name">Blocked people<\/span>/);
  assert.match(settings, /document\.getElementById\("svBlockedPeople"\)\?\.addEventListener\("click", \(event\) => openBlockedPeople\(event\.currentTarget\)\);/);
  // The row is wired where the page paints, beside the other value rows.
  assert.match(settings, /svAccountOpen = !svAccountOpen;/);
  // Leaving the page folds the row, the way it disarms Sign Out.
  assert.match(html, /resetSignOutArm\(\); \/\/ leaving the view disarms the confirm state\s*svAccountOpen = false;/);
});

test("the opens-Relays switches live on Your AIs, one per AI, never on You", () => {
  // Shane's compact Your AIs (2026-10-13): each AI's switch sits on its own
  // row, and only once that AI is connected to Relay; the chat AIs first, then
  // the coding agents on this computer, the way the reader's sheet is ordered.
  const setup = slice("function setupPageHtml()", "/** The You page's door");
  const template = setup.slice(setup.indexOf("return `<section"));
  assert.ok(template.indexOf('setupWebRowHtml("claude")') < template.indexOf("${agents}"));
  assert.match(slice("function setupWebRowHtml(surface)", "function setupAgentRows("), /role="switch" data-chat-app="\$\{meta\.name\}"/);
  assert.match(slice("function setupAgentRowHtml(row)", "function setupAgentSettingsHtml("), /data-agent-app="\$\{row\.app\}"/);
  assert.doesNotMatch(slice("function renderSettings()", "function wireSettings()"), /data-agent-app|data-chat-app/);
  // No Other row, and no switch held on (David, 2026-09-16 and 2026-09-17).
  assert.doesNotMatch(html, /svOtherAgent|Copy prompts for another agent|KEEP_ONE|keep at least one on|isLastAgentAppOn/);
});

test("Your invite link is on the page with Copy, and nothing more to read", () => {
  const link = slice("function yourLinkHtml()", "async function copyInviteLinkFromSettings()");
  // Sven's cut (2026-10-08): the link is one row in its own card, "Invite
  // link" with the url as its second line. The two sentences are gone (and
  // the untrue "waits in Requests" promise must never come back).
  assert.match(link, /<div class="sv-group" id="yourLink" data-stop="1"><div class="sv-open-list">\s*<div class="sv-row">\s*<span class="sv-row-copy"><span class="sv-row-name">Invite link<\/span><span class="sv-row-sub sv-link-url">\$\{esc\(shown \|\| \(inviteLinkUnavailable \? "Not available right now" : "Loading…"\)\)\}<\/span><\/span>/);
  assert.doesNotMatch(link, /sv-open-title|sv-open-intro|sv-invite-note|Share it with someone|When they join|waits in Requests/);
  assert.match(link, /id="svCopyLink"[^>]*>\$\{inviteLinkCopied \? "Copied" : "Copy"\}/);
  assert.match(link, /\$\{inviteLinkError \? `<div class="row-err sv-err">\$\{esc\(inviteLinkError\)\}<\/div>` : ""\}/);
  // Copy is wired where the page paints.
  assert.match(slice("function renderSettings()", "function wireSettings()"), /copyLink\.addEventListener\("click", \(e\) => \{ e\.stopPropagation\(\); copyInviteLinkFromSettings\(\); \}\)/);
  // The renderer never mints or copies the link itself: main does both, so
  // the account token that mints it never reaches this process.
  const copy = slice("async function copyInviteLinkFromSettings()", "function slackSettingsHtml(info)");
  assert.match(copy, /await window\.relay\.copyOnboardingInviteLink\(\)/);
  assert.doesNotMatch(copy, /navigator\.clipboard/);
  const load = slice("async function loadSettings()", "// Provider state is live product state");
  assert.match(load, /await window\.relay\.onboardingInviteLink\(\)/);
  assert.match(load, /if \(!window\.relay\.onboardingInviteLink \|\| payload\.account\?\.paired === false\) return;/);
});

test("the You page reads: you, what Relay connects to, your link, preferences, then the account", () => {
  const settings = slice("function renderSettings()", "function wireSettings()");
  // Slack sits beside Your AIs (David, 2026-10-07): the two things Relay
  // connects to come first, then the link, the preferences card, and the
  // Blocked people + Account card (Sven's cut, 2026-10-08). The gated
  // extras keep their place after it.
  const order = ['<div class="sv-profile">', "setupEntryHtml()", "slackSettingsHtml(info)", "yourLinkHtml()", "quietPrefsHtml(info)", "milestoneRelaysHtml(info)", "blockedPeopleHtml()", "accountRowHtml()", "sv-colophon"]
    .map((marker) => settings.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), order);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Everything about the AIs lives on Your AIs; the Chat agents card left
  // You too (Shane, 2026-10-13): a mention runs with its agent's settings.
  assert.doesNotMatch(settings, /chatAgentDefaultsHtml|Chat agents|data-chat-agent-|setupAgentSettingsHtml/);
  const youPage = slice("function renderSettings()", "function wireTaskRuntimeControls(");
  assert.doesNotMatch(youPage, /executionDisable|executionMode|Device execution|data-provider-/);
  assert.doesNotMatch(slice("function wireSettings()", "\n  function "), /data-provider-|executionDisable|executionMode/);
  // Their handlers went with them: Your AIs wires them within its own page.
  assert.match(slice("function wireSetupPage()", "\n  function "), /wireTaskRuntimeControls\(page\);/);
});
