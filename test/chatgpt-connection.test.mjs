import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("the Companion requests a purpose-limited browser handoff for either chat app", () => {
  assert.match(client, /createMcpBrowserHandoff\(provider = "chatgpt"\) \{\s*return this\.#req\("POST", "\/v1\/mcp\/browser-handoff", \{ provider \}\);/);
  assert.match(preload, /connectChatGPT: \(\) => ipcRenderer\.invoke\("relay:connectChatGPT"\)/);
  assert.match(preload, /connectClaude: \(\) => ipcRenderer\.invoke\("relay:connectClaude"\)/);
  assert.match(main, /ipcMain\.handle\("relay:connectChatGPT", \(\) => connectChatGPT\(\)\)/);
  assert.match(main, /ipcMain\.handle\("relay:connectClaude", \(\) => connectClaude\(\)\)/);
});

test("main validates the first-party handoff URL before opening it", () => {
  const start = main.indexOf("async function connectChatApp(provider)");
  const end = main.indexOf("// After an account change", start);
  assert.ok(start >= 0 && end > start);
  const body = main.slice(start, end);
  assert.match(body, /target\.origin !== relayWeb\.origin/);
  assert.match(body, /target\.pathname !== expectedPath/);
  assert.match(body, /!\^\/mcp_handoff|!\/\^mcp_handoff/);
  assert.match(body, /await shell\.openExternal\(target\.toString\(\)\)/);
});

test("Claude setup copies Relay's stable website MCP URL", () => {
  assert.match(main, /function relayMcpUrl\(\)/);
  assert.match(main, /const base = new URL\(`\$\{webBase\(\)\}\/`\)/);
  assert.match(main, /return new URL\("\/mcp", base\)\.toString\(\)/);
  assert.match(main, /const loopback = base\.hostname === "localhost"/);
  assert.match(main, /if \(copiedMcpUrl\) clipboard\.writeText\(copiedMcpUrl\)/);
  assert.match(main, /claude: "\/connect\/claude"/);
});

test("required E2EE routes Claude through the local runtime with no hosted fallback", () => {
  const start = main.indexOf("async function connectChatApp(provider)");
  const end = main.indexOf("// After an account change", start);
  const body = main.slice(start, end);
  const required = body.indexOf('e2ee?.mode === "required"');
  const hosted = body.indexOf("client.createMcpBrowserHandoff(provider)");
  assert.ok(required >= 0 && hosted > required);
  assert.match(body, /client\.e2eeRemoteEndpoint\(\)/);
  assert.match(body, /requestE2eeClaudeConnection/);
  assert.match(body, /waitForE2eeClaudeConnection/);
  assert.match(body, /https:\/\/claude\.ai\/customize\/connectors/);
  assert.match(body, /ChatGPT connections are not available with Relay E2EE yet/);
});

test("the pill's You page carries no chat-connector rows; the setup flow keeps its own", () => {
  // The chat connectors (ChatGPT coming soon, Claude chat) left the pill's
  // Settings with the Minimal design (Sven, 2026-09-08): setup installs the
  // skill for everyone, and the You page says what is connected. The
  // connector hand-off itself still lives in main for the signup flow.
  assert.doesNotMatch(html, /Chat connections/);
  assert.equal((html.match(/<div class="sv-open-title">Connections<\/div>/g) || []).length, 1);
  assert.match(html, /function connectionsHtml\(info, includeAgentProviders\)/);
  assert.match(html, /const rows = includeAgentProviders \? providerConnectionRowsHtml\(\) : "";/);
  assert.doesNotMatch(html, /chatConnectionRowsHtml|id:"chatgpt-chat"|id:"claude-chat"|id="svConnectClaude"|connectClaudeFromSettings/);
  const render = html.slice(html.indexOf("function renderSettings()"), html.indexOf("function wireSettings()"));
  assert.match(render, /html \+= connectionsHtml\(info, payload\.features\?\.agentConnections === true\)/);
  assert.doesNotMatch(render, /chatConnectionsHtml|providerConnectionHtml/);
  assert.match(main, /ipcMain\.handle\("relay:connectClaude", \(\) => connectClaude\(\)\)/);
});

test("versioned first-send onboarding keeps durable progress for each account", () => {
  assert.match(main, /const COMPANION_ONBOARDING_VERSION = 2/);
  assert.match(main, /let onboardingVersions = overlayPrefs\.onboardingVersions/);
  assert.match(main, /onboardingRequired: currentAccount\.paired && \(networkOnboardingState.required \|\| completedOnboardingVersion < COMPANION_ONBOARDING_VERSION\)/);
  assert.match(main, /ipcMain\.handle\("relay:completeSetupTutorial", \(\) => completeSetupTutorial\(\)\)/);
  assert.match(html, /payload\.ui\?\.onboardingRequired === true/);
  assert.match(html, /signupStage === "first-relay"/);
  // The send itself ends the chapter (2026-09-08): no "sent" screen follows.
  assert.match(html, /if \(status === "sent"\) \{ landOnFirstRelay\(\); return; \}/);
  assert.doesNotMatch(html, /id="suChatSkip"/);
});
