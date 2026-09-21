"use strict";

function runtimeEnvironment({ env = process.env, config = {}, apiUrl = "" } = {}) {
  const explicit = String(env.RELAY_ENV || config.environment || "").trim().toLowerCase();
  if (["local", "development"].includes(explicit)) return "local";
  if (explicit === "dev") return "dev";
  if (explicit === "staging") return "staging";
  if (["prod", "production", "stable"].includes(explicit)) return "production";

  const endpoint = String(apiUrl || env.RELAY_API_URL || config.apiUrl || "").trim();
  try {
    const hostname = new URL(endpoint).hostname;
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return "local";
  } catch {}
  if (String(env.NODE_ENV || "").toLowerCase() === "development") return "local";
  const channel = String(env.RELAY_UPDATE_CHANNEL || config.updateChannel || "").trim().toLowerCase();
  if (channel === "dev") return "dev";
  if (channel === "staging") return "staging";
  return "production";
}

function productFeatures(options = {}) {
  const config = options.config || {};
  const environment = runtimeEnvironment(options);
  const user = options.user || config.user || null;
  // Developer status is a durable server-owned account role, but its product
  // entitlement exists only on local/dev. Staging deliberately exercises the
  // production product surface even when it is offline with a cached developer
  // profile; the API independently enforces the same deployment boundary.
  // Tasks are the exception: they left the developer row on 2026-09-17.
  //
  // The server reports the role twice: isDeveloper is masked to the dev
  // deployment (and Relay Mobile), developerAccount is the raw role on every
  // deployment. Either proves the account; only the environment decides which
  // tier of capability it unlocks below.
  const developerAccount = user?.accountKind === "human" && (user?.developerAccount === true || user?.isDeveloper === true);
  const developer = (environment === "local" || environment === "dev") && developerAccount;
  return Object.freeze({
    environment,
    developer,
    // The developer-account tier (Shane and David, 2026-09-21): capabilities
    // the role unlocks on staging and production too, so a developer keeping
    // the production build can test them with another developer while
    // ordinary accounts on the same build never see them. The API enforces
    // the same boundary per capability (hasDeveloperAccountFeatures).
    developerAccount,
    orgAdmin: user?.accountKind === "human" && user?.canViewAdminDashboard === true,
    // Google Contacts sync is still under Dev validation, so it follows the
    // same server-owned developer-account gate as the other unreleased tools.
    googleContacts: developer,
    // Tasks are the shipped product on every deployment and for every account
    // (David, 2026-09-17). The server enforces the same rule: any personal
    // account may send, receive and act on a Task, on dev, staging and
    // production alike. Until then a staging or production agent was handed a
    // catalog with no Task in it and wrote a work request as a message.
    requests: true,
    // Native Task launch is the first developer-account-tier capability: a
    // developer on any deployment, never an ordinary account.
    taskExecution: developerAccount,
    // The pre-Requests task protocol (/v1/tasks, the agent inbox, task
    // sessions) the daemon polls and relay_task_create drives. Its routes
    // stay behind the developer gate on the server.
    legacyTaskProtocol: developer,
    // Todo is paused everywhere, including local/dev developer accounts.
    // Keep its data and implementation available for a later re-enable.
    todo: false,
    // Topics (invite-only boards kept in sync by members' agents under an
    // approved mandate) are being proven by the developers first.
    topics: developer,
    // Slack is an internal proving surface alongside Tasks. Staging and
    // production exercise the customer product, even for developer accounts.
    slack: developer,
    // Human mentions are ordinary conversation affordances. Agent mentions
    // start local runs, so they retain the same boundary as Tasks.
    peopleMentions: true,
    agentMentions: developer,
    // Cowork is intentionally unavailable. Do not add an override here: its
    // former transport inspected Claude Desktop process/session credentials.
    cowork: false,
    // The reader's For-{agent} composer ("Tell Claude Code anything…") and its
    // Work face: a private local run of your own agent — the requests layer
    // wearing a composer.
    relayWork: developer,
    // Settings → Agent connections: provider subscription profiles and the
    // MCP / connected-apps inventory. Substrate for runs, not for reading —
    // so it rides the Tasks switch: the day Tasks turns on in an
    // environment, its Settings surfaces (permission modes + connections)
    // turn on with it (David, 2026-08-18). That day is 2026-09-17.
    agentConnections: true,
    // relay_ai_sessions / relay_ai_session and the daemon's session controller
    // (the observations upload + remote session operations they run on).
    aiSessions: developer,
    // relay_connector_* — the server-side Composio gateway.
    connectors: developer,
    // Editing or deleting a message you sent is ordinary messaging, on every
    // channel and for every account, the same as sending it (David,
    // 2026-09-17). The flag stays as the one switch the MCP catalog, the
    // pill's side menu and the edit/delete IPC all read.
    messageMutations: true,
  });
}

module.exports = { runtimeEnvironment, productFeatures };
