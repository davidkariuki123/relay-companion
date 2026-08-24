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
  const developerAccount = user?.accountKind === "human" && user?.isDeveloper === true;
  const developer = (environment === "local" || environment === "dev") && developerAccount;
  return Object.freeze({
    environment,
    developer,
    requests: developer,
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
    // turn on with it (David, 2026-08-18).
    agentConnections: developer,
    // relay_ai_sessions / relay_ai_session and the daemon's session controller
    // (the observations upload + remote session operations they run on).
    aiSessions: developer,
    // relay_connector_* — the server-side Composio gateway.
    connectors: developer,
  });
}

module.exports = { runtimeEnvironment, productFeatures };
