import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

test("Slack disconnect confirmation is a footer inside the existing Slack card", () => {
  const settings = between(html, "function slackSettingsHtml(info)", "function renderSettings()");
  const cardStart = settings.indexOf('<div class="sv-slack-card');
  // The row is the page's shared .sv-row species now (Sven's cut, 2026-10-08).
  const row = settings.indexOf('<div class="sv-row sv-slack-row">');
  const confirmation = settings.indexOf('<div class="sv-slack-confirm"');
  const cardEnd = settings.indexOf('</div>\n      ${slackConnectionError');

  assert.ok(cardStart >= 0 && row > cardStart && confirmation > row && cardEnd > confirmation);
  // Disconnect only opens that footer; it is the one id the panel answers to.
  assert.match(settings.slice(row, confirmation), /id="svSlackDisconnect" aria-controls="svSlackDisconnectConfirmPanel"/);
  assert.match(settings.slice(confirmation, cardEnd), /id="svSlackDisconnectConfirmPanel"/);
  assert.doesNotMatch(settings, /sv-integration-backdrop|aria-modal="true"/);
  assert.match(settings, /Disconnect Slack\?/);
  assert.match(settings, /Your Slack chats stop syncing\. Messages already here stay\./);
  // One line on the card says what Slack does; no second paragraph under it.
  assert.doesNotMatch(settings, /sv-slack-foot/);
});

test("the calm footer animates the card open and respects reduced motion", () => {
  assert.match(html, /\.sv-slack-confirm \{[^}]*display:grid;[^}]*grid-template-rows:0fr;[^}]*transition:grid-template-rows 280ms/);
  assert.match(html, /\.sv-slack-card\.is-confirming \.sv-slack-confirm \{[^}]*grid-template-rows:1fr;[^}]*opacity:1;/);
  assert.match(html, /\.sv-slack-confirm-clip \{[^}]*min-height:0;[^}]*overflow:hidden;/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.sv-slack-confirm[\s\S]*?transition-duration:0\.01ms;/);
});

test("opening and cancelling toggles the existing card instead of rebuilding Settings", () => {
  const wiring = between(
    html,
    'const slackDisconnect = document.getElementById("svSlackDisconnect")',
    'const slackDisconnectConfirmButton = document.getElementById("svSlackDisconnectConfirm")',
  );

  assert.match(wiring, /slackCard\?\.classList\.toggle\("is-confirming", expanded\)/);
  assert.match(wiring, /slackDisconnectPanel\.removeAttribute\("inert"\)/);
  assert.match(wiring, /slackDisconnectPanel\.setAttribute\("inert", ""\)/);
  assert.match(wiring, /slackDisconnect\.addEventListener\("click", \(\) => setSlackDisconnectExpanded\(true\)\)/);
  assert.match(wiring, /cancelSlackDisconnect = \(\) => setSlackDisconnectExpanded\(false, \{ returnFocus:true \}\)/);
  assert.doesNotMatch(wiring, /renderSettings\(\)/);
});

test("the inline confirmation exposes its state and supports Escape", () => {
  assert.match(html, /aria-controls="svSlackDisconnectConfirmPanel" aria-expanded="\$\{slackDisconnectConfirm \? "true" : "false"\}"/);
  assert.match(html, /role="region" aria-labelledby="slackDisconnectTitle" aria-hidden="\$\{slackDisconnectConfirm \? "false" : "true"\}"/);
  assert.match(html, /requestAnimationFrame\(\(\) => slackDisconnectCancel\?\.focus\(\{ preventScroll:true \}\)\)/);
  assert.match(html, /event\.key === "Escape" && slackDisconnectConfirm && !slackConnectionBusy/);
  assert.match(html, /slackDisconnect\?\.focus\(\{ preventScroll:true \}\)/);
});

test("confirm still calls the Slack disconnect bridge and reports busy state", () => {
  assert.match(html, /\$\{slackConnectionBusy \? "Disconnecting…" : "Disconnect Slack"\}/);
  const confirm = between(
    html,
    'const slackDisconnectConfirmButton = document.getElementById("svSlackDisconnectConfirm")',
    // The provider rows that followed moved to Your AIs (2026-10-08); the
    // account row is the next thing wired on You.
    'const accountEl = document.getElementById("svAccount")',
  );
  assert.match(confirm, /result = await window\.relay\.slackDisconnect\(\)/);
  assert.match(confirm, /slackDisconnectConfirm = false/);
  assert.match(confirm, /if \(result\?\.ok\) slackConnectionInfo = \{ state:"disconnected" \}/);
});
