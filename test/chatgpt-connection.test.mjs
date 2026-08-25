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

test("ordinary users see ChatGPT as coming soon and Claude as connectable", () => {
  assert.match(html, /<div class="sv-open-title">Chat connections<\/div>/);
  assert.match(html, /<span class="sv-provider-name">ChatGPT<\/span>\s*<span class="sv-provider-status">Relay for regular ChatGPT is coming soon\.<\/span>/);
  assert.match(html, /<button class="sv-provider-btn" type="button" disabled>Coming soon<\/button>/);
  assert.doesNotMatch(html, /id="svConnectChatGPT"/);
  assert.doesNotMatch(html, /connectChatGptFromSettings/);
  assert.match(html, /id="svConnectClaude"/);
  const render = html.slice(html.indexOf("function renderSettings()"), html.indexOf("function wireSettings()"));
  const chat = render.indexOf("html += chatConnectionsHtml(info)");
  const developerGate = render.indexOf("if (payload.features?.agentConnections === true)");
  assert.ok(chat >= 0 && developerGate > chat, "chat setup is outside the developer-only agent section");
  assert.match(html, /connectClaude\.addEventListener\("click", connectClaudeFromSettings\)/);
});

test("the final tutorial is durable for new signups but defaults off for existing users", () => {
  assert.match(main, /let setupTutorialPending = overlayPrefs\.setupTutorialPending === true/);
  assert.match(main, /onConnected: async \(registration\) => \{\s*setupTutorialPending = true;\s*writeOverlayPrefs\(\)/);
  assert.match(main, /ipcMain\.handle\("relay:completeSetupTutorial", \(\) => completeSetupTutorial\(\)\)/);
  assert.match(html, /payload\.ui\?\.setupTutorialPending === true/);
  assert.doesNotMatch(html, /id="suConnectChatGPT"/);
  assert.match(html, /id="suConnectClaude"/);
  assert.match(html, /<span class="su-chat-name">Sign in with Claude<\/span>/);
  assert.match(html, /id="suChatDone"/);
  assert.match(html, /id="suChatSkip"/);
});
