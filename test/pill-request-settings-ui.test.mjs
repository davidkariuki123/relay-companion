import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

// YOUR AIS, COMPACT (Shane, 2026-10-13). The page listed Claude Code and Codex
// five times (On this computer, Open Relays in, What Tasks may do,
// Connections, Chat agents) and the Claude connector twice. Now: two
// sections, one row per AI, the switch only once it is connected, and on
// developer accounts each coding agent's run settings under its own row.
const page = () => between(html, "function setupPageHtml()", "/** The You page's door");
const agentRow = () => between(html, "function setupAgentRowHtml(row)", "function setupAgentSettingsHtml(");
const runSettings = () => between(html, "function setupAgentSettingsHtml(", "function setupPageHtml()");
const webRow = () => between(html, "function setupWebRowHtml(surface)", "function setupAgentRows(");

test("Your AIs is two sections: chat AIs in the cloud, coding agents on this computer", () => {
  const source = page();
  assert.match(source, /<div class="sv-open-title">Chat AIs<\/div>\s*<div class="sv-open-intro">Connected to your account, so they reach your Relays on every device\.<\/div>/);
  assert.match(source, /<div class="sv-open-title">Coding agents on this \$\{machine\}<\/div>\s*<div class="sv-open-intro">Work in your files\. Switch on the ones that open your Relays\.<\/div>/);
  assert.match(source, /\$\{setupWebRowHtml\("claude"\)\}\$\{setupWebRowHtml\("chatgpt"\)\}/);
  assert.match(source, /rows\.map\(setupAgentRowHtml\)/);
  // The sections that repeated the same apps are gone, everywhere.
  for (const gone of ["What Tasks may do", "Open Relays in", ">Connections<", ">Chat agents<", "Connect all", "On the web"]) {
    assert.equal(html.includes(gone), false, gone);
  }
  for (const gone of ["function permPrefsHtml", "function yourAgentHtml", "function taskRuntimeHtml", "function connectionsHtml", "function chatAgentDefaultsHtml", "function setupConnectAll"]) {
    assert.equal(html.includes(gone), false, gone);
  }
});

test("a chat AI shows Connect until it is connected, then its opens-Relays switch", () => {
  const source = webRow();
  assert.match(source, /live\.length \? \{ dot:"ok", text:"Connected to Relay" \}\s*: \{ dot:"", text:"Not connected to Relay" \}/);
  assert.match(source, /live\.length \? `<button class="sv-switch" type="button" role="switch" data-chat-app="\$\{meta\.name\}"/);
  assert.match(source, /: `<button class="sv-choose" type="button" data-setup-web-connect="\$\{surface\}">Connect<\/button>`/);
  // The name, not the whole row, unfolds what is connected (and Disconnect).
  assert.match(source, /<button class="setup-row-open" type="button" data-setup-web="\$\{surface\}"/);
});

test("a coding agent is one row across its places, with the switch only once connected", () => {
  const rows = between(html, "function setupAgentRows(hosts)", "function setupVerbHtml(");
  assert.match(rows, /\? "Terminal" : "Desktop app"/);
  assert.match(rows, /key:"claude-code", name:"Claude Code"[\s\S]*pick\(\["claude-code"\]\)/);
  assert.match(rows, /key:"codex", name:"Codex"[\s\S]*pick\(\["chatgpt-app", "codex"\]\)/);
  const source = agentRow();
  assert.match(source, /connected\.length \? \{ dot:"ok", text:"Connected to Relay", where:/);
  assert.match(source, /const control = busy \? "" : connected\.length \? toggle : gaps\[0\] \? setupVerbHtml\(gaps\[0\]\.status, gaps\[0\]\.host\.id\) : "";/);
  assert.match(source, /data-agent-app="\$\{row\.app\}"/);
  assert.match(source, /data-conductor-app="1"/);
  // A place not connected while another is keeps its own verb.
  assert.match(source, /`Not connected in \$\{line\.label\}`/);
});

test("run settings sit under each coding agent, developer accounts only, and never name a mention", () => {
  const source = runSettings();
  assert.match(source, /if \(!runsAgentsHere\(\)\) return "";/);
  assert.match(html, /function runsAgentsHere\(\) \{\s*const features = payload\.features \|\| \{\};\s*return features\.taskExecution === true \|\| features\.agentMentions === true \|\| features\.relayWork === true;/);
  // Model, thinking and permission: three separate lines, three separate controls.
  assert.match(source, /pick\("Model", "data-chat-agent-model"/);
  assert.match(source, /pick\("Thinking", "data-chat-agent-effort"/);
  assert.match(source, /pick\("Permission", "data-agent-permission"/);
  assert.match(source, /<label class="setup-kv"><span>\$\{label\}<\/span><span class="setup-kv-pick"><select class="setup-kv-select"/);
  // The plan sign-in Relay needs to start the agent is said first, on the row.
  assert.match(source, /`Sign in to \$\{plan\} to run Tasks`/);
  assert.match(source, /data-provider-connect="\$\{provider\}"/);
  assert.doesNotMatch(between(html, "function setupAgentRows(hosts)", "/** The You page's door"), /@Claude|@Codex/);
});

test("models say Latest, so the list never needs a version bump", () => {
  assert.match(html, /claude: \[\["opus","Latest Opus"\],\["fable","Latest Fable"\],\["sonnet","Latest Sonnet"\],\["haiku","Latest Haiku"\]\]/);
  assert.match(html, /codex: \[\["auto","Latest"\],/);
  // The composer's model rail says the same, and resolves to the same aliases.
  assert.match(html, /"Claude Code":\s*\{ models:\["Latest Opus","Latest Fable","Latest Sonnet","Latest Haiku"\]/);
  assert.match(html, /"Latest Opus": "opus",/);
  assert.doesNotMatch(html, /"Opus 5\.5"|"Fable 5\.1"|"Sonnet 5\.5"|"Haiku 4\.5"/);
});

test("one permission per agent: Claude Code can ask before each step", () => {
  const vendors = between(html, "const PERM_VENDORS = [", "const PERM_DEFAULTS");
  assert.match(vendors, /\{ id: "default", name: "Ask before each step" \}/);
  assert.match(vendors, /\{ id: "full", name: "Full access" \}/);
  const wiring = between(html, "function wireSetupPage()", "if (setupFocus) {");
  const permission = between(wiring, 'page.querySelectorAll("[data-agent-permission]")', 'page.querySelectorAll("[data-chat-agent-model],[data-chat-agent-effort]")');
  assert.match(permission, /savePillSetting\(\{ taskPermissions: \{ \[vendor\]: select\.value \} \}\);/);
  assert.match(permission, /setProtoPref\(`proto\.perm\.\$\{vendor\}`, select\.value\);/);
  const route = wiring.slice(wiring.indexOf('page.querySelectorAll("[data-chat-agent-model],[data-chat-agent-effort]")'));
  assert.match(route, /window\.relay\.saveChatAgentPreferences\(\{ \[provider\]:route \}\)/);
});

test("the MCP inventory, the provider on/off switch and the device-execution controls are gone", () => {
  for (const gone of ["providerInventory", "setProviderEnabled", "data-provider-enable", "data-provider-details", "executionDisable", "nativeExecutionMode", "id=\"executionMode\"", "sv-agent-provider"]) {
    assert.equal(html.includes(gone), false, `inbox: ${gone}`);
  }
  for (const gone of ["relay:providerInventory", "relay:providerAuthSetEnabled", "relay:executionDisable", "relay:executionMode", "provider-inventory-cache"]) {
    assert.equal(main.includes(gone), false, `main: ${gone}`);
    assert.equal(preload.includes(gone), false, `preload: ${gone}`);
  }
  // A Task's readiness is the CLI installed and signed in, nothing else.
  assert.match(html, /return Boolean\(item\?\.authLoaded && item\?\.connected\);/);
});

test("provider routes never inherit another provider's model or historical transcript", () => {
  const start = between(main, "async function handOffToAgent", "// The kick prompt is the task's REAL first user message.");
  assert.match(start, /host === "codex" && \/\^claude-\/i\.test\(requestedModel\)/);
  assert.match(start, /host === "claude" && \/\^gpt-\/i\.test\(requestedModel\)/);

  const localIpc = between(main, 'ipcMain.handle("relay:agentHandoff"', "// The session face's feed and its Steer verb.");
  assert.match(localIpc, /model: \(route && route\.model\) \|\| ""/);

  const preview = between(main, "async function previewTaskSession", "const providerCompletionInflight");
  assert.match(preview, /requestedProvider === "codex" && codexPath \? "codex"/);
  assert.match(preview, /requestedProvider === "claude" && claudePath \? "claude"/);
});
