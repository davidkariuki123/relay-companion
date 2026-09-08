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

test("Your agent is one chosen app, in words: Opens relays, or Use this one", () => {
  const agent = slice("function yourAgentHtml()", "function yourLinkHtml()");
  assert.match(agent, /<div class="sv-open-title">Your agent<\/div>/);
  // The intro states what is true: setup installs the skill and the MCP for
  // everyone, so every app that is here is connected (Shane, 2026-09-07).
  assert.match(agent, /"Relay is set up in Claude Code and Codex on this Mac\. One of them opens relays\."/);
  assert.match(agent, /`Relay is set up in \$\{present\[0\]\} on this Mac\. It opens relays\.`/);
  assert.match(agent, /"Relay is set up in your sessions on this Mac\. Install Claude Code or Codex and it opens relays there\."/);
  assert.doesNotMatch(agent, /does not confirm|"Available/, "no disclaimer, and present means connected");
  assert.match(agent, /"Connected · opens relays in a new chat"/);
  assert.match(agent, /: "Connected";/);
  assert.match(agent, /appUnavailableReason\(app\)/, "the availability check still names why an app is off");
  assert.match(agent, /data-agent-choose="\$\{app\}">Use this one<\/button>/);
  // The terminal case is a third row in the same list, not a select
  // (Sven, 2026-09-08): one control, the same data.
  assert.doesNotMatch(agent, /svOpeningSurface|<select/);
  assert.match(agent, /<span class="sv-open-name">My own session<\/span><span class="sv-open-why">Relay copies the sentence for you<\/span>/);
  assert.match(agent, /data-agent-choose="session">Use this one<\/button>/);
  const wiring = slice("function setAgentOwnSession()", "function setAgentOpeningApp(app)");
  assert.match(wiring, /surface: "other"/);
  assert.doesNotMatch(html, /svOpeningSurface/);
});

test("Your link is on the page with Copy, and says what joining through it does", () => {
  const link = slice("function yourLinkHtml()", "async function copyInviteLinkFromSettings()");
  assert.match(link, /<div class="sv-open-title">Your link<\/div>/);
  // Redeeming an invite writes both contacts (apps/api invites.ts), so the
  // person lands in People. The old line promised Requests, which was untrue.
  assert.match(link, /Anyone with it can join Relay and reach you\. They land in your People\./);
  assert.doesNotMatch(link, /waits in Requests/);
  assert.match(link, /id="svCopyLink"[^>]*>\$\{inviteLinkCopied \? "Copied" : "Copy"\}/);
  // The renderer never mints or copies the link itself: main does both, so
  // the account token that mints it never reaches this process.
  const copy = slice("async function copyInviteLinkFromSettings()", "function deviceApprovalsHtml(info)");
  assert.match(copy, /await window\.relay\.copyOnboardingInviteLink\(\)/);
  assert.doesNotMatch(copy, /navigator\.clipboard/);
  const load = slice("async function loadSettings()", "// Provider state is live product state");
  assert.match(load, /await window\.relay\.onboardingInviteLink\(\)/);
  assert.match(load, /if \(!window\.relay\.onboardingInviteLink \|\| payload\.account\?\.paired === false\) return;/);
});

test("the page keeps its order: account, your agent, your link, then the gated and quiet sections", () => {
  const settings = slice("function renderSettings()", "function wireSettings()");
  const order = ["svAccountRow", "yourAgentHtml()", "yourLinkHtml()", "slackSettingsHtml(info)", "connectionsHtml(info", "quietPrefsHtml(info)", "sv-colophon"]
    .map((marker) => settings.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), order);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
