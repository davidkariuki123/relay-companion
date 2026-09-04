import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

// The request-permission section redesign (David, 2026-08-18): the section
// wore the 11px caption header while every sibling wore sv-open-title, and
// led with a four-line paragraph nobody read, above two permanently-open
// menu trays. It is now one value row per app — the "Open Relays with"
// species — that unfolds the standard open-actions tray inline on tap.

test("the section header and intro are the shared settings species, not the caption label", () => {
  const section = between(html, 'id="permPrefs"', "sv-colophon");
  assert.match(section, /<div class="sv-open-title">What Tasks may do<\/div>/);
  assert.match(section, /<div class="sv-open-intro">[^<]*<\/div>/);
  // The intro is ONE line of the same style the sibling section uses — the
  // old sv-explain paragraph (and its style) must not come back.
  assert.doesNotMatch(html, /sv-explain/);
  assert.doesNotMatch(section, /td-label/);
  // Same enclosure material as its siblings: the raised sv-open-list.
  assert.match(section, /<div class="sv-open-list">/);
});

test("each app is a value row: logo, name, current mode, chevron", () => {
  const section = between(html, 'id="permPrefs"', "sv-colophon");
  assert.match(section, /class="sv-open-row perm-vrow" data-perm-open="\$\{esc\(v\.key\)\}" aria-expanded=/);
  assert.match(section, /<img class="sv-open-logo" src="\$\{logo\}"/);
  assert.match(section, /<span class="sv-open-name">\$\{esc\(v\.label\)\}<\/span>/);
  // The collapsed row states the current mode; the open row hides the value
  // (the tray below it is the value) and keeps only the turned chevron.
  assert.match(section, /<span class="perm-value">\$\{open \? "" : esc\(cur\.name\)\}/);
  assert.match(html, /\.perm-app\.open \.perm-chev \{ transform:rotate\(90deg\); \}/);
});

test("tapping a row unfolds the standard open-actions tray inline, one app at a time", () => {
  const section = between(html, 'id="permPrefs"', "sv-colophon");
  assert.match(section, /\$\{open \? `<div class="open-actions perm-tray">/);
  // permTrayOpen holds ONE vendor key: opening a row is exclusive, tapping it
  // again folds it.
  assert.match(html, /let permTrayOpen = null;/);
  assert.match(html, /permTrayOpen = permTrayOpen === key \? null : key;/);
  // The tray reuses the open-actions species wholesale — mode rows are the
  // same ap-row buttons, in each vendor's own words, with the vendor square.
  assert.match(section, /class="oa-item ap-row perm-row\$\{cur\.id === m\.id \? " on" : ""\}" data-perm="\$\{esc\(v\.key\)\}" data-mode="\$\{esc\(m\.id\)\}"/);
  assert.match(section, /vendorSq\(v\.sample\)/);
});

test("choosing a mode persists it and folds the tray back to the value row", () => {
  const wiring = between(html, 'querySelectorAll("[data-perm]")', "wireSettings()");
  assert.match(wiring, /setProtoPref\(`proto\.perm\.\$\{b\.getAttribute\("data-perm"\)\}`, b\.getAttribute\("data-mode"\)\)/);
  assert.match(wiring, /permTrayOpen = null;/);
  assert.match(wiring, /renderSettings\(\);/);
});

test("the section still mounts only with the requests feature", () => {
  assert.match(html, /if \(payload\.features\?\.requests === true\) html \+= `\s*<div class="sv-open-section" id="permPrefs" data-stop="1">/);
});

test("Connections uses the shared section species and concise privacy copy", () => {
  assert.match(html, /class="sv-provider-section" data-stop="1">\s*<div class="sv-open-title">Connections<\/div>\s*<div class="sv-provider-list sv-agent-provider-list">/);
  assert.doesNotMatch(html, /Chat connections/);
  assert.equal((html.match(/<div class="sv-open-title">Connections<\/div>/g) || []).length, 1);
  assert.match(html, /const rows = `\$\{includeAgentProviders \? providerConnectionRowsHtml\(\) : ""\}\$\{chatConnectionRowsHtml\(info\)\}`/);
  assert.doesNotMatch(html, /sv-provider-intro/);
  assert.doesNotMatch(html, /Relay uses each app's local profile/);
});

test("Agent connections says subscription sign-in, never implementation jargon or fake reconnect", () => {
  assert.match(html, /"Sign in to Claude Code" : "Sign in to Codex"/);
  assert.match(html, /"Use Claude subscription" : "Use ChatGPT subscription"/);
  assert.match(html, /item\.connected\s*\? "Connected"/);
  assert.match(html, /item\.connected[\s\S]*connectDisabled/);
  assert.doesNotMatch(html, /Connect local profile|This Mac's existing local profile/);
  assert.doesNotMatch(html, /item\.connected \? "Reconnect"/);
});

test("healthy providers collapse to the real app mark, connection count, and Ready", () => {
  assert.match(html, /const logo = id === "claude" \? "claudeCodeMark\.svg" : "codexMark\.svg"/);
  assert.match(html, /const headerMeta = healthy \? countLabel : status/);
  assert.match(html, /class="sv-agent-provider-ready">Ready<\/span>/);
  assert.match(html, /data-provider-details="\$\{esc\(id\)\}"/);
  assert.match(html, /sv-agent-provider-detail\$\{open \? " open" : ""\}/);
  assert.match(html, /aria-hidden="\$\{open \? "false" : "true"\}"\$\{open \? "" : " inert"\}/);
  assert.match(html, /providerDetailsOpen = willOpen \? provider : ""/);
  assert.match(html, /detail\.setAttribute\("aria-hidden", open \? "false" : "true"\)/);
  assert.match(html, /detail\.toggleAttribute\("inert", !open\)/);
  assert.doesNotMatch(html, /<span class="sv-provider-status">\$\{esc\(requirement\)\}<\/span>/);
});

test("provider routes never inherit another provider's model or historical transcript", () => {
  const start = between(main, "async function startTaskFromPreview", "function forgeTaskSessionQuietly");
  assert.match(start, /selectedHost === "codex" && \/\^claude-\/i\.test\(requestedModel\)/);
  assert.match(start, /selectedHost === "claude" && \/\^gpt-\/i\.test\(requestedModel\)/);

  const taskIpc = between(main, 'ipcMain.handle("relay:taskStart"', '// The agent document of an ordinary Relay');
  const localIpc = between(main, 'ipcMain.handle("relay:relayWorkStart"', '// The session face\'s feed');
  assert.match(taskIpc, /model: \(route && route\.model\) \|\| ""/);
  assert.match(localIpc, /model: \(route && route\.model\) \|\| ""/);

  const preview = between(main, "async function previewTaskSession", "const providerCompletionInflight");
  assert.match(preview, /requestedProvider === "codex" && codexPath \? "codex"/);
  assert.match(preview, /requestedProvider === "claude" && claudePath \? "claude"/);
});

test("Chat agents uses labelled compact controls below each agent identity", () => {
  const section = between(html, 'function chatAgentDefaultsHtml()', "function deviceApprovalsHtml");
  assert.match(section, /class="sv-agent-identity"/);
  assert.match(section, /class="sv-agent-fields"/);
  assert.match(section, /class="sv-agent-field-label">Model<\/span><select class="sv-agent-select" data-chat-agent-model=/);
  assert.match(section, /class="sv-agent-field-label">Thinking<\/span><select class="sv-agent-select" data-chat-agent-effort=/);
  assert.match(html, /\.sv-agent-defaults \.sv-open-row \{ display:block;/);
  assert.match(html, /\.sv-agent-fields \{ display:grid; grid-template-columns:minmax\(0,1\.35fr\) minmax\(0,1fr\);/);
  assert.match(html, /\.sv-agent-select \{ width:100%; min-width:0;/);
  assert.doesNotMatch(html, /\.sv-agent-defaults select \{ min-width:122px; max-width:44%;/);
});
