import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("the pill carries no chat-connector rows and no connector hand-off", () => {
  // The chat connectors (ChatGPT coming soon, Claude chat) left the pill's
  // Settings with the Minimal design (Sven, 2026-09-08): setup installs the
  // skill for everyone, and the You page says what is connected. The
  // connector hand-off left main and the preload with them.
  assert.doesNotMatch(html, /Chat connections/);
  assert.equal((html.match(/<div class="sv-open-title">Connections<\/div>/g) || []).length, 1);
  assert.match(html, /function connectionsHtml\(info, includeAgentProviders\)/);
  assert.match(html, /const rows = includeAgentProviders \? providerConnectionRowsHtml\(\) : "";/);
  assert.doesNotMatch(html, /chatConnectionRowsHtml|id:"chatgpt-chat"|id:"claude-chat"|id="svConnectClaude"|connectClaudeFromSettings/);
  const render = html.slice(html.indexOf("function renderSettings()"), html.indexOf("function wireSettings()"));
  assert.match(render, /html \+= connectionsHtml\(info, payload\.features\?\.agentConnections === true\)/);
  assert.doesNotMatch(render, /chatConnectionsHtml|providerConnectionHtml/);
  assert.doesNotMatch(main, /relay:connectClaude|relay:connectChatGPT/);
  assert.doesNotMatch(preload, /connectClaude|connectChatGPT/);
});

test("versioned first-send onboarding keeps durable progress for each account", () => {
  assert.match(main, /const COMPANION_ONBOARDING_VERSION = 2/);
  assert.match(main, /let onboardingVersions = overlayPrefs\.onboardingVersions/);
  assert.match(main, /onboardingRequired: currentAccount\.paired && \(networkOnboardingState.required \|\| completedOnboardingVersion < COMPANION_ONBOARDING_VERSION\)/);
  assert.match(main, /ipcMain\.handle\("relay:completeSetupTutorial", \(\) => completeSetupTutorial\(\)\)/);
  assert.match(html, /payload\.ui\?\.onboardingRequired === true/);
  assert.match(html, /signupStage === "first-relay"/);
  // The send opens the next chapter (2026-09-13): celebration, first link,
  // Grow your network; Open Relay completes it.
  assert.match(html, /if \(status === "sent"\) \{ renderFirstRelayChapter\(\); return; \}/);
  assert.doesNotMatch(html, /id="suChatSkip"/);
});
