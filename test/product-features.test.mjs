import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accountProductFeatures, productFeatures, runtimeEnvironment } from "../src/product-features.js";
import { handleCall, toolsForAccount } from "../src/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const DEVELOPER = { accountKind: "human", isDeveloper: true };
const ORDINARY_USER = { accountKind: "human", isDeveloper: false };
const DEVELOPER_SURFACES = {
  slack: true, peopleMentions: true, agentMentions: true,
  relayWork: true, agentConnections: true, aiSessions: true, connectors: true, messageMutations: true,
};
const ORDINARY_SURFACES = {
  slack: false, peopleMentions: true, agentMentions: false,
  relayWork: false, agentConnections: false, aiSessions: false, connectors: false, messageMutations: false,
};

test("developer capabilities require both the server-owned role and a non-production environment", () => {
  assert.deepEqual(productFeatures({ env: { NODE_ENV: "development" }, user: ORDINARY_USER }), {
    environment: "local", developer: false, requests: false, todo: false, cowork: false, ...ORDINARY_SURFACES,
  });
  assert.deepEqual(productFeatures({ env: { NODE_ENV: "development" }, user: DEVELOPER }), {
    environment: "local", developer: true, requests: true, todo: true, cowork: false, ...DEVELOPER_SURFACES,
  });
  assert.deepEqual(productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER }), {
    environment: "dev", developer: true, requests: true, todo: true, cowork: false, ...DEVELOPER_SURFACES,
  });
  assert.deepEqual(productFeatures({ env: { RELAY_UPDATE_CHANNEL: "staging" }, user: DEVELOPER }), {
    environment: "staging", developer: false, requests: false, todo: false, cowork: false, ...ORDINARY_SURFACES,
  });
  assert.deepEqual(productFeatures({ env: { RELAY_ENV: "staging" }, user: DEVELOPER }), {
    environment: "staging", developer: false, requests: false, todo: false, cowork: false, ...ORDINARY_SURFACES,
  });
  assert.deepEqual(productFeatures({ env: {}, user: DEVELOPER }), {
    environment: "production", developer: false, requests: false, todo: false, cowork: false, ...ORDINARY_SURFACES,
  });
});

test("live server role outranks the cached pairing profile", async () => {
  const promoted = await accountProductFeatures({
    client: { token: "dev_test", async me() { return { user: DEVELOPER }; } },
    config: { user: ORDINARY_USER },
    env: { RELAY_UPDATE_CHANNEL: "dev" },
  });
  assert.equal(promoted.requests, true);

  const demoted = await accountProductFeatures({
    client: { token: "dev_test", async me() { return { user: ORDINARY_USER }; } },
    config: { user: DEVELOPER },
    env: { RELAY_UPDATE_CHANNEL: "dev" },
  });
  assert.equal(demoted.requests, false);

  const production = await accountProductFeatures({
    client: { token: "dev_test", async me() { return { user: DEVELOPER }; } },
    config: { user: DEVELOPER },
    env: { RELAY_UPDATE_CHANNEL: "stable" },
  });
  assert.equal(production.developer, false);
  assert.equal(production.requests, false);
});

test("developer status brings the complete Task substrate on dev but never Cowork", () => {
  const features = productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER });
  assert.equal(features.requests, true);
  assert.deepEqual(
    {
      slack: features.slack, peopleMentions: features.peopleMentions, agentMentions: features.agentMentions,
      relayWork: features.relayWork, agentConnections: features.agentConnections,
      aiSessions: features.aiSessions, connectors: features.connectors, messageMutations: features.messageMutations,
    },
    DEVELOPER_SURFACES,
  );
  assert.equal(features.cowork, false);
});

test("an explicit production environment wins over a local API URL, so the clone can show prod", () => {
  // The sealed local clone runs against a refused localhost port (which reads
  // as "local"); RELAY_ENV=production is how it shows exactly what ships.
  const clone = productFeatures({ env: { RELAY_ENV: "production" }, apiUrl: "http://127.0.0.1:9" });
  assert.equal(clone.environment, "production");
  assert.deepEqual(
    {
      slack: clone.slack, peopleMentions: clone.peopleMentions, agentMentions: clone.agentMentions,
      relayWork: clone.relayWork, agentConnections: clone.agentConnections,
      aiSessions: clone.aiSessions, connectors: clone.connectors, messageMutations: clone.messageMutations,
    },
    ORDINARY_SURFACES,
  );
});

test("localhost is local even without NODE_ENV", () => {
  assert.equal(runtimeEnvironment({ env: {}, apiUrl: "http://127.0.0.1:4000" }), "local");
});

test("disabled Tasks disappear from the model schema and are rejected before transport", async () => {
  const ordinary = { requests: false, aiSessions: false, connectors: false };
  const send = toolsForAccount(ordinary).find((tool) => tool.name === "relay_send");
  assert.deepEqual(send.inputSchema.properties.kind.enum, ["message"]);
  assert.equal(send.inputSchema.properties.targetSurfaces, undefined);
  const client = { sendRelay() { throw new Error("transport must not run"); } };
  await assert.rejects(
    handleCall(client, "relay_send", {
      recipient: { contactId: "contact_1" },
      kind: "task",
      title: "Run this check",
      forHuman: "Please run this.",
      idempotencyKey: "request-disabled",
    }, { features: ordinary }),
    /available only to Relay developer accounts/,
  );
});

test("the shipped MCP catalog is send · receive · open: no native-session reach, no connector gateway", async () => {
  // Sven, 2026-08-17: "ai sessions wont be in v1" — and the connector tools
  // are requests substrate. The messaging tools stay available to ordinary
  // accounts; nothing
  // that starts, messages or inspects a native session is listed anywhere.
  const shipped = productFeatures({ env: {}, user: ORDINARY_USER });
  const ordinary = toolsForAccount(shipped).map((tool) => tool.name);
  assert.deepEqual(ordinary, [
    "relay_todo_update", "relay_todo_reorder", "relay_send", "relay_share_link", "relay_contacts_search", "relay_groups_list", "relay_group_create", "relay_group_update",
    "relay_group_delete", "relay_contact_update", "relay_inbox_list", "relay_sent_list", "relay_thread_fetch",
    "relay_chats_list", "relay_chat_fetch", "relay_chat_send", "relay_mark_read",
  ]);
  // A developer on production gets the same catalog as every ordinary user.
  const productionDeveloper = productFeatures({ env: {}, user: DEVELOPER });
  assert.deepEqual(toolsForAccount(productionDeveloper).map((tool) => tool.name), ordinary);
  // The complete catalog requires the role and the dev channel together.
  const developer = productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER });
  assert.equal(toolsForAccount(developer).length, 33);
  assert.ok(toolsForAccount(developer).some((tool) => tool.name === "relay_task_unclaim"));
  assert.ok(toolsForAccount(developer).some((tool) => tool.name === "relay_message_edit"));
  assert.ok(toolsForAccount(developer).some((tool) => tool.name === "relay_message_delete"));
  // A call that arrives anyway (a stale client, a hand-written request) is refused before transport.
  const client = new Proxy({}, { get(_target, key) { throw new Error(`transport must not run (${String(key)})`); } });
  for (const [name, args] of [
    ["relay_ai_sessions", { action: "list" }],
    ["relay_ai_session", { action: "start", provider: "claude", message: "hi", idempotencyKey: "k1" }],
    ["relay_connector_call_tool", { provider: "gmail", toolName: "GMAIL_FETCH", idempotencyKey: "k2" }],
  ]) {
    await assert.rejects(handleCall(client, name, args, { features: shipped }), /available only to Relay developer accounts/);
  }
  for (const name of ["relay_message_edit", "relay_message_delete"]) {
    await assert.rejects(
      handleCall(client, name, { relayId: "relay_1", idempotencyKey: "stale_tool_call" }, { features: shipped }),
      /available only to Relay developer accounts on dev/,
    );
  }
});

test("the first payload render follows the account-gated Todo feature", () => {
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  const body = source.slice(source.indexOf("function renderAll()"), source.indexOf("markAllReadEl.addEventListener", source.indexOf("function renderAll()")));
  assert.match(body, /syncTabs\(\);/);
  assert.match(source, /view === "tasks" && payload\.features\?\.todo !== true/);
  assert.match(source, /payload\.features\?\.todo !== true && activeView === "tasks"/);
  assert.match(source, /payload\.features\?\.todo === true && incomingAccount/,
    "hidden environments must not fetch Todo data in the background");
  assert.match(source, /data-view="tasks">Todo/);
  assert.match(source, /view === "slack" && payload\.features\?\.slack !== true/);
});

test("customer builds keep person mentions while hiding Slack and agent mentions", () => {
  const staging = productFeatures({ env: { RELAY_UPDATE_CHANNEL: "staging" }, user: DEVELOPER });
  assert.equal(staging.peopleMentions, true);
  assert.equal(staging.agentMentions, false);
  assert.equal(staging.slack, false);

  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  assert.match(source, /payload\.features\?\.peopleMentions === true && thread\.isGroup/);
  assert.match(source, /payload\.features\?\.agentMentions === true \? agentMentionSpans\(text\) : \[\]/);
  assert.doesNotMatch(source, /payload\.features\?\.requests === true \? agentMentionSpans/);
});

test("disabled Tasks and Cowork do not remain in Settings", () => {
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  assert.match(source, /if \(payload\.features\?\.requests === true\) html \+= `\s*<div class="sv-open-section" id="permPrefs"/);
  const settings = source.slice(source.indexOf("function renderSettings()"), source.indexOf("function wireSettings()"));
  assert.doesNotMatch(settings, /Claude Cowork/);
  assert.doesNotMatch(source, /\bproductFeatures\b/, "renderer must use feature flags from its payload");
});

test("the You page always offers which app opens relays, and the fresh open goes there", () => {
  // Sven, 2026-08-17: "settings ... just needs to have which client you use
  // (codex and claude) ... and users can change it." The setting used to render
  // only with Tasks, so every prod user was pinned to Claude Code; and a
  // fresh open passed no host, so the frontmost-window heuristic — not the
  // person's choice — decided where the relay landed. The chosen app is a
  // promise: the section is unconditional for a paired account and every
  // fresh open honours it.
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  const settings = source.slice(source.indexOf("function renderSettings()"), source.indexOf("function wireSettings()"));
  assert.match(settings, /if \(info\.paired\) \{\s*html \+= yourLinkHtml\(\);\s*html \+= yourAgentHtml\(\);/);
  assert.match(settings, /if \(info\.paired\) \{\s*html \+= yourLinkHtml\(\);/);
  assert.match(source, /<div class="sv-open-section" id="yourAgent" data-stop="1">\s*<div class="sv-open-title">Your agent<\/div>/);
  const open = source.slice(source.indexOf("function openRelayFromUI("), source.indexOf("let unreadCount = 0;"));
  assert.match(open, /mode === "fresh" && window\.relay\.openFresh\) window\.relay\.openFresh\(id, host \|\| hostKeyFor\(agentAppName\(\)\), note\)/);
  // The same default on every un-hosted open: plain, current, and the sent copy.
  assert.match(open, /else window\.relay\.open\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\);/);
  assert.match(open, /window\.relay\.openInCurrent\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
  assert.match(open, /window\.relay\.openSent\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
});

test("Agent connection rows stay gated, and the chat-connector rows are gone", () => {
  // The You page says what is connected; setup installs the skill for
  // everyone (Shane, 2026-09-07). "ChatGPT coming soon" and "Claude · Set up"
  // were a second place to configure an agent, and Sven's Settings has none.
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  const settings = source.slice(source.indexOf("function renderSettings()"), source.indexOf("function wireSettings()"));
  assert.match(settings, /html \+= connectionsHtml\(info, payload\.features\?\.agentConnections === true\)/);
  assert.match(source, /const rows = includeAgentProviders \? providerConnectionRowsHtml\(\) : "";/);
  assert.doesNotMatch(source, /chatConnectionRowsHtml|connectClaudeFromSettings|Relay in ChatGPT is coming soon/);
  assert.doesNotMatch(settings, /providerConnectionHtml|chatConnectionsHtml/);
  const load = source.slice(source.indexOf("async function loadSettings()"), source.indexOf("// Provider state is live product state"));
  assert.match(load, /const connectionsOn = payload\.features\?\.agentConnections === true;/);
  assert.match(load, /const authTask = \(async \(\) => \{\s*if \(!connectionsOn\) return;/, "the subscription-profile probe never runs off the row");
  assert.match(load, /const inventoryTask = \(async \(\) => \{\s*if \(!connectionsOn \|\| !window\.relay\.providerInventory\) return;/, "the CLI-backed inventory scan never runs off the row");
});

test("People is a top-level screen without a redundant back header", () => {
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  assert.doesNotMatch(source, /id="contactsHead"|id="contactsBack"/);
});

test("the daemon's session controller neither uploads nor listens when AI sessions are off the product row", async () => {
  // Prod v1 (Sven, 2026-08-17): no native-session reach. The controller tick
  // is the daemon's only path to the session directory upload
  // (POST /v1/sessions/observations — absolute cwd + transcript paths) and to
  // remote session operations; with aiSessions off it must not touch the
  // client at all. Developer accounts run it every tick, and a failing controller
  // still never throws into the delivery loop.
  const { sessionControllerTick } = await import("../src/task-daemon.js");
  const logs = [];
  const log = (m) => logs.push(m);
  const untouchable = new Proxy({}, { get(_t, key) { throw new Error(`client touched: ${String(key)}`); } });
  const shipped = productFeatures({ env: {}, user: ORDINARY_USER });
  let ran = 0;
  assert.deepEqual(await sessionControllerTick({ client: untouchable, log, features: shipped, run: async () => { ran += 1; } }), { ran: false });
  assert.equal(ran, 0);
  assert.deepEqual(logs, []);
  const developer = productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER });
  assert.deepEqual(await sessionControllerTick({ client: untouchable, log, features: developer, run: async () => { ran += 1; } }), { ran: true });
  assert.equal(ran, 1);
  const failing = new Error("503 during a rolling deploy");
  const result = await sessionControllerTick({ client: untouchable, log, features: developer, run: async () => { throw failing; } });
  assert.equal(result.ran, true);
  assert.equal(result.error, failing);
  assert.deepEqual(logs, ["session directory unavailable: 503 during a rolling deploy"]);
});

test("one role-aware daemon polls tasks only for a developer account", async () => {
  const { daemonDeliveryTick } = await import("../src/task-daemon.js");
  const shipped = productFeatures({ env: {}, user: ORDINARY_USER });
  let ordinaryRuns = 0;
  let taskRuns = 0;
  const ordinaryRelays = [];
  const shippedResult = await daemonDeliveryTick({
    client: {},
    features: shipped,
    ordinaryPoll: async () => { ordinaryRuns += 1; return { ordinaryRelays, inboxOk: true }; },
    taskPoll: async () => { taskRuns += 1; throw new Error("task transport must not run"); },
  });
  assert.equal(shippedResult.ordinaryOnly, true);
  assert.equal(shippedResult.ordinaryRelays, ordinaryRelays);
  assert.equal(ordinaryRuns, 1);
  assert.equal(taskRuns, 0);

  const developer = productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER });
  const developerResult = await daemonDeliveryTick({
    client: {},
    features: developer,
    ordinaryPoll: async () => { ordinaryRuns += 1; throw new Error("ordinary fallback must not run"); },
    taskPoll: async () => {
      taskRuns += 1;
      return { sessions: [], messages: [], notifications: [], ordinaryRelays: [], events: [] };
    },
  });
  assert.equal(developerResult.ordinaryOnly, false);
  assert.equal(ordinaryRuns, 1);
  assert.equal(taskRuns, 1);
});

test("production agent-work entry points enforce the feature row before native transport", () => {
  const main = fs.readFileSync(path.join(here, "../overlay/main.cjs"), "utf8");
  assert.match(main, /function agentWorkEnabledForRow\(row\)/);
  assert.match(main, /if \(!agentWorkEnabledForRow\(row\)\) return agentWorkUnavailable\(\);/);
  assert.match(main, /function providerWorkIdentity\(relayId\) \{[\s\S]*?if \(!agentWorkEnabledForRow\(row\)\) return null;/);
  assert.match(main, /function workEventAuthorized\(event, relayId\) \{[\s\S]*?if \(!agentWorkEnabledForRow\(rowById/);
  assert.match(main, /async function scheduleList\(\) \{\s*if \(!PRODUCT_FEATURES\.requests\) return \[\];/);
  assert.match(main, /async function scheduleSave\(input\) \{\s*if \(!PRODUCT_FEATURES\.requests\)/);

  const cli = fs.readFileSync(path.join(here, "../bin/relay.js"), "utf8");
  const gate = cli.slice(cli.indexOf("async function requireTaskFeatures("), cli.indexOf("function companionVersion()"));
  assert.match(gate, /accountProductFeatures\(\{/);
  assert.match(gate, /if \(!features\.requests\)/);
  assert.match(gate, /only to Relay developer accounts/);
  assert.match(cli, /--full and --messages-only were removed/);
});

test("detection feeds independent app switches with strict availability checks", () => {
  const source = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
  const pick = source.slice(source.indexOf("let agentSurfaces = null;"), source.indexOf("function chatOrder()"));
  assert.match(pick, /const key = app === "Codex" \? "_codexDesktop" : app === "Claude Code" \? "_claudeDesktop" : "";/);
  assert.match(pick, /const key = app === "Codex" \? "_codexCli" : app === "Claude Code" \? "_claudeCli" : "";/);
  assert.match(pick, /return entry\?\.available === true;/,
    "unknown availability never claims a connected provider");
  assert.match(pick, /return available\.includes\("desktop"\) \? "desktop" : "terminal";/,
    "desktop is the default when present and terminal is the CLI-only fallback");
  assert.match(pick, /const AGENT_APPS_PREF = "proto\.agentApps\.v2";/);
  assert.match(pick, /return requestedAgentApps\(\)\.filter\(appAvailable\);/);
  assert.match(pick, /preference\?\.surface === "other"/);
  assert.match(pick, /proto\.agentApps\.v3:/);
  assert.match(pick, /return selected\.length === 1 \? selected\[0\] : "your agent";/);
  assert.match(pick, /\["Codex", "Claude Code"\]\.filter/);
  assert.match(pick, /function agentOpensInApp\(app = agentAppChoice\(\)\)/);
  assert.match(pick, /try \{ next = await window\.relay\.capabilities\(\); \}/, "the renderer asks main, never probes the disk itself");
  const settings = source.slice(source.indexOf("function renderSettings()"), source.indexOf("function wireSettings()"));
  const agent = source.slice(source.indexOf("function yourAgentHtml()"), source.indexOf("function yourLinkHtml()"));
  assert.match(agent, /\$\{AGENT_APP_OPTIONS\.map\(\(app\) => \{/);
  assert.match(agent, /const logo = app === "Codex" \? "codexMark\.svg" : "claudeCodeMark\.svg";/, "the page uses Relay's shipped app marks");
  assert.match(agent, /role="switch" data-agent-app="\$\{app\}"/);
  assert.doesNotMatch(agent, /<select|svOpeningSurface/, "no competing surface selector");
  assert.match(settings, /setAgentAppEnabled\(button\.getAttribute\("data-agent-app"\)/);
  assert.match(source, /loadAgentSurfaces\(\)\.catch\(\(\) => \{\}\);/, "capabilities load at boot");
  assert.match(source, /const seq = \+\+settingsLoadSeq;\s*loadAgentSurfaces\(\)/, "and again whenever Settings loads");
});
