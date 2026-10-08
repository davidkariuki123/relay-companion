"use strict";

// RELAY'S SETTINGS, ONE LIST FOR THE PILL AND FOR AGENTS (2026-10-06).
//
// Every setting the person can change in the pill is defined here once: what
// it is called, where it lives in the pill, how to read and write it, and how
// far an agent may change it through relay_settings. The pill and the tool go
// through the same definitions, so they cannot disagree.
//
// Local values live in ~/.relay/settings.json. The pill writes it, agents
// write it (through the MCP server, a different process) and the pill watches
// it, so an agent's change reaches an open pill within a second or two. There
// is no cross-process lock: the only one Relay has resolves a process identity
// through PowerShell on Windows, far too slow for the pill's main thread.
// Every write instead re-reads the file and changes one key, so two writers
// lose an update only if they land within the same few milliseconds, on
// settings a person changes by hand.
//
// What an agent may do, per change, is one of three answers:
//   agent      it applies at once and the agent tells the person;
//   confirm    the agent asks and the pill shows the person Allow / Not now;
//   pill_only  the agent tells the person where to find it.
// The rule is the direction of the change. An agent can always make agents
// do less; it cannot give agents more freedom on its own, because the tool
// cannot tell the person's request from text the agent read in a received
// Relay, a web page or a file. Account, sign-in and Slack connections are the
// person's to change in the pill.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");
const relayRules = require("../bootstrap/relay-rules.cjs");

const SCHEMA_VERSION = 1;
// A request waits this long for the person before it lapses.
const CONFIRM_TTL_MS = 15 * 60_000;

function settingsPath(options = {}) {
  return relayRules.preferencesPath(options);
}

function readStore(options = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(options), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Re-read, change, write. `change` edits its argument in place. */
function updateStore(change, options = {}) {
  const next = readStore(options);
  change(next);
  next.schemaVersion = SCHEMA_VERSION;
  next.updatedAt = new Date().toISOString();
  atomicWriteJsonSync(settingsPath(options), next, { mode: 0o600 });
  return next;
}

/** The same key the pill uses for account-scoped choices: user id, else email. */
function accountKeyFor(user) {
  return String(user?.id || user?.userId || user?.email || "").trim();
}

function accountSettings(store, accountKey) {
  const entry = accountKey ? store.accounts?.[accountKey] : null;
  return entry && typeof entry === "object" ? entry : {};
}

function patchAccount(accountKey, patch, options = {}) {
  if (!accountKey) throw new Error("This setting belongs to a Relay account, and this computer is not signed in.");
  return updateStore((store) => {
    const accounts = store.accounts && typeof store.accounts === "object" ? store.accounts : {};
    accounts[accountKey] = { ...accountSettings(store, accountKey), ...patch };
    store.accounts = accounts;
  }, options);
}

function patchDevice(patch, options = {}) {
  return updateStore((store) => Object.assign(store, patch), options);
}

// What the pill reads: the raw stored values for this computer and account.
// A key that is absent stays absent, so the pill's own fallbacks (a choice
// made during setup, an older pill's saved value) still answer it.
function pillSnapshot(accountKey, options = {}, store = readStore(options)) {
  const account = accountSettings(store, accountKey);
  // Names whose switches these are, so the pill never reads one account's
  // apps as another's across Switch Account.
  const snapshot = { accountKey: accountKey || null };
  if (store.theme === "dark" || store.theme === "light") snapshot.theme = store.theme;
  if (store.taskPermissions && typeof store.taskPermissions === "object") snapshot.taskPermissions = { ...store.taskPermissions };
  if (Array.isArray(account.agentApps)) snapshot.agentApps = [...account.agentApps];
  if (Array.isArray(account.chatApps)) snapshot.chatApps = [...account.chatApps];
  if (typeof account.conductor === "boolean") snapshot.conductor = account.conductor;
  snapshot.pending = pendingRequests(store);
  return snapshot;
}

// An older pill kept these in its own browser storage. It hands them over
// once; only keys this file does not already hold are taken, so a choice an
// agent or another window made since is never overwritten.
function adoptLegacy(accountKey, legacy = {}, options = {}) {
  return updateStore((store) => {
    if (!store.theme && (legacy.theme === "dark" || legacy.theme === "light")) store.theme = legacy.theme;
    const permissions = store.taskPermissions && typeof store.taskPermissions === "object" ? store.taskPermissions : {};
    for (const vendor of ["claude", "codex"]) {
      const mode = legacy.taskPermissions?.[vendor];
      if (!permissions[vendor] && TASK_MODES[vendor].some((option) => option.value === mode)) permissions[vendor] = mode;
    }
    if (Object.keys(permissions).length) store.taskPermissions = permissions;
    if (!accountKey) return;
    const accounts = store.accounts && typeof store.accounts === "object" ? store.accounts : {};
    const account = accountSettings(store, accountKey);
    if (!Array.isArray(account.agentApps) && Array.isArray(legacy.agentApps)) account.agentApps = legacy.agentApps.filter((app) => AGENT_APPS.includes(app));
    if (!Array.isArray(account.chatApps) && Array.isArray(legacy.chatApps)) account.chatApps = legacy.chatApps.filter((app) => CHAT_APPS.includes(app));
    if (typeof account.conductor !== "boolean" && typeof legacy.conductor === "boolean") account.conductor = legacy.conductor;
    accounts[accountKey] = account;
    store.accounts = accounts;
  }, options);
}

// The pill's own switches, saved as the person chose them: the whole app list
// at once, as the pill holds it. Agents change one app at a time through the
// open_with_* settings instead.
function savePillChoices(accountKey, patch = {}, options = {}) {
  return updateStore((store) => {
    if (patch.theme === "dark" || patch.theme === "light") store.theme = patch.theme;
    if (patch.taskPermissions && typeof patch.taskPermissions === "object") {
      const permissions = { ...(store.taskPermissions || {}) };
      for (const vendor of ["claude", "codex"]) {
        const mode = patch.taskPermissions[vendor];
        if (TASK_MODES[vendor].some((option) => option.value === mode)) permissions[vendor] = mode;
      }
      store.taskPermissions = permissions;
    }
    const accountPatch = {};
    if (Array.isArray(patch.agentApps)) accountPatch.agentApps = AGENT_APPS.filter((app) => patch.agentApps.includes(app));
    if (Array.isArray(patch.chatApps)) accountPatch.chatApps = CHAT_APPS.filter((app) => patch.chatApps.includes(app));
    if (typeof patch.conductor === "boolean") accountPatch.conductor = patch.conductor;
    if (!Object.keys(accountPatch).length) return;
    if (!accountKey) return;
    const accounts = store.accounts && typeof store.accounts === "object" ? store.accounts : {};
    accounts[accountKey] = { ...accountSettings(store, accountKey), ...accountPatch };
    store.accounts = accounts;
  }, options);
}

const AGENT_APPS = ["Claude Code", "Codex"];
const CHAT_APPS = ["Claude", "ChatGPT"];
// Each vendor's own modes, least freedom first. The order decides which
// direction a change goes.
const TASK_MODES = {
  claude: [
    { value: "acceptEdits", label: "Accept Edits" },
    { value: "auto", label: "Auto" },
    { value: "bypassPermissions", label: "Bypass Permissions" },
  ],
  codex: [
    { value: "ask", label: "Ask for approval" },
    { value: "guardian", label: "Approve for me" },
    { value: "full", label: "Full access" },
  ],
};
const TASK_DEFAULTS = { claude: "auto", codex: "full" };
const CHAT_AGENT_MODELS = {
  claude: [["opus", "Opus 5.5"], ["fable", "Fable 5.1"], ["sonnet", "Sonnet 5.5"], ["haiku", "Haiku 4.5"]],
  codex: [["gpt-6.1-sol", "6.1 Sol"], ["gpt-6-astra", "6 Astra"], ["gpt-6-sol", "6 Sol"], ["gpt-6-luna", "6 Luna"], ["gpt-5.6-sol", "5.6 Sol"], ["gpt-5.6-terra", "5.6 Terra"], ["gpt-5.6-luna", "5.6 Luna"]],
};
const CHAT_AGENT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["auto", "low", "medium", "high", "xhigh", "max"],
};

function rank(options, value) {
  return options.findIndex((option) => option.value === value);
}

function appSwitch({ id, app, list, key, label, where, description, available }) {
  return {
    id,
    label,
    where,
    description,
    type: "boolean",
    scope: "account",
    available,
    read: (ctx) => {
      const saved = accountSettings(readStore(ctx.options), ctx.accountKey)[key];
      return Array.isArray(saved) ? saved.includes(app) : true;
    },
    write: (ctx, value) => {
      const saved = accountSettings(readStore(ctx.options), ctx.accountKey)[key];
      const current = new Set(Array.isArray(saved) ? saved : list);
      if (value) current.add(app); else current.delete(app);
      patchAccount(ctx.accountKey, { [key]: list.filter((item) => current.has(item)) }, ctx.options);
    },
  };
}

function taskMode(vendor, label) {
  return {
    id: `task_permissions_${vendor === "claude" ? "claude_code" : "codex"}`,
    label: `What Tasks may do: ${label}`,
    where: "You › What Tasks may do",
    description: `The ${label} permission mode for Tasks the person starts from Relay.`,
    type: "choice",
    scope: "device",
    options: TASK_MODES[vendor],
    available: (ctx) => ctx.features?.requests !== false,
    read: (ctx) => {
      const saved = readStore(ctx.options).taskPermissions?.[vendor];
      return rank(TASK_MODES[vendor], saved) >= 0 ? saved : TASK_DEFAULTS[vendor];
    },
    write: (ctx, value) => updateStore((store) => {
      store.taskPermissions = { ...(store.taskPermissions || {}), [vendor]: value };
    }, ctx.options),
    // Giving Tasks more freedom is the person's call.
    raises: (current, next) => rank(TASK_MODES[vendor], next) > rank(TASK_MODES[vendor], current),
  };
}

function chatAgentField(provider, field) {
  const label = provider === "claude" ? "@Claude" : "@Codex";
  const options = field === "model"
    ? CHAT_AGENT_MODELS[provider].map(([value, name]) => ({ value, label: name }))
    : CHAT_AGENT_EFFORTS[provider].map((value) => ({ value, label: value }));
  return {
    id: `chat_agent_${provider}_${field === "model" ? "model" : "thinking"}`,
    label: `${label} ${field === "model" ? "model" : "thinking"}`,
    where: "You › Chat agents",
    description: `The default ${field === "model" ? "model" : "thinking effort"} for ${label} work sessions on this account, on every computer.`,
    type: "choice",
    scope: "account",
    options,
    available: (ctx) => ctx.features?.agentMentions === true && Boolean(ctx.client?.chatAgentPreferences),
    read: async (ctx) => (await ctx.client.chatAgentPreferences())?.[provider]?.[field] ?? null,
    write: async (ctx, value) => {
      const current = (await ctx.client.chatAgentPreferences())?.[provider] || {};
      await ctx.client.updateChatAgentPreferences({ [provider]: { ...current, [field]: value } });
    },
  };
}

function pillOnly({ id, label, where, description, available }) {
  return { id, label, where, description, type: "action", scope: "account", pillOnly: true, available };
}

const SETTINGS = [
  {
    id: "milestone_relays",
    label: "Milestone Relays",
    where: "You › Milestone Relays",
    description: "Whether agents on this computer create a Relay link unasked when finished work matters to someone. Nothing is sent either way.",
    type: "boolean",
    scope: "device",
    read: (ctx) => relayRules.milestoneRelaysEnabled(ctx.options),
    write: (ctx, value) => {
      relayRules.setMilestoneRelays(value, ctx.options);
      const rules = require("../bootstrap/relay-skill.cjs").applyMilestonePreference(ctx.options);
      if (rules?.ok === false) throw new Error(`The setting was saved, but Claude Code's rules file could not follow it: ${rules.error || rules.status}.`);
    },
    raises: (_current, next) => next === true,
  },
  {
    id: "show_automatically",
    label: "Show Relay automatically",
    where: "You › Notifications",
    description: "Whether the Relay pill comes forward when new messages arrive. Off keeps it in the status area until the person opens it.",
    type: "boolean",
    scope: "device",
    read: (ctx) => readStore(ctx.options).pillHidden !== true,
    write: (ctx, value) => {
      if (value === false && ctx.trayAvailable === false) {
        throw new Error("Relay must keep showing itself on this computer: there is no status-area icon to bring it back from.");
      }
      patchDevice({ pillHidden: value !== true }, ctx.options);
    },
  },
  {
    id: "play_sounds",
    label: "Play sounds",
    where: "You › Notifications",
    description: "Whether Relay plays a sound for new messages.",
    type: "boolean",
    scope: "device",
    read: (ctx) => readStore(ctx.options).soundsMuted !== true,
    write: (ctx, value) => patchDevice({ soundsMuted: value !== true }, ctx.options),
  },
  {
    id: "notification_style",
    label: "New messages",
    where: "You › Notifications",
    description: "Which new messages make the Relay pill show a banner: every message, only direct messages and mentions (busy groups just count), or none (only the count changes). Hiding the pill entirely is show_automatically.",
    type: "choice",
    scope: "device",
    options: [
      { value: "all", label: "Every message" },
      { value: "direct", label: "Direct messages and mentions" },
      { value: "count", label: "Just the count" },
    ],
    read: (ctx) => ["all", "direct", "count"].includes(readStore(ctx.options).notifyStyle) ? readStore(ctx.options).notifyStyle : "all",
    write: (ctx, value) => patchDevice({ notifyStyle: value }, ctx.options),
  },
  {
    id: "theme",
    label: "Appearance",
    where: "The sun and moon button at the top of the pill",
    description: "Dark or light.",
    type: "choice",
    scope: "device",
    options: [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }],
    read: (ctx) => readStore(ctx.options).theme === "light" ? "light" : "dark",
    write: (ctx, value) => patchDevice({ theme: value }, ctx.options),
  },
  appSwitch({ id: "open_with_claude", app: "Claude", list: CHAT_APPS, key: "chatApps", label: "Open Relays with Claude", where: "You › Your agent", description: "Offer Claude (the Claude app or claude.ai) when the person opens a Relay." }),
  appSwitch({ id: "open_with_chatgpt", app: "ChatGPT", list: CHAT_APPS, key: "chatApps", label: "Open Relays with ChatGPT", where: "You › Your agent", description: "Offer ChatGPT when the person opens a Relay." }),
  appSwitch({ id: "open_with_claude_code", app: "Claude Code", list: AGENT_APPS, key: "agentApps", label: "Open Relays with Claude Code", where: "You › Your agent", description: "Offer Claude Code when the person opens a Relay. Takes effect only where Claude Code is installed; the first app switched on starts Tasks." }),
  appSwitch({ id: "open_with_codex", app: "Codex", list: AGENT_APPS, key: "agentApps", label: "Open Relays with Codex", where: "You › Your agent", description: "Offer Codex when the person opens a Relay. Takes effect only where Codex is installed." }),
  {
    id: "open_with_conductor",
    label: "Open Relays with Conductor",
    where: "You › Your agent",
    description: "Offer Conductor, which opens a new workspace per Relay. Shown in the pill only where Conductor is installed.",
    type: "boolean",
    scope: "account",
    available: (ctx) => ctx.features?.conductor === true,
    read: (ctx) => accountSettings(readStore(ctx.options), ctx.accountKey).conductor !== false,
    write: (ctx, value) => patchAccount(ctx.accountKey, { conductor: value === true }, ctx.options),
  },
  taskMode("claude", "Claude Code"),
  taskMode("codex", "Codex"),
  {
    id: "device_execution",
    label: "Device execution",
    where: "You (shown while it is on)",
    description: "Whether Execute may launch Tasks in the agent apps on this computer. It is switched on by the person's first Execute, which asks them.",
    type: "boolean",
    scope: "device",
    available: (ctx) => ctx.features?.taskExecution === true,
    read: async (ctx) => (await ctx.executionModule()).executionEnabled(ctx.config) === true,
    write: async (ctx, value) => (await ctx.executionModule()).setExecutionPreferences(ctx.config, { enabled: value === true }),
    raises: (_current, next) => next === true,
  },
  chatAgentField("claude", "model"),
  chatAgentField("claude", "effort"),
  chatAgentField("codex", "model"),
  chatAgentField("codex", "effort"),
  pillOnly({ id: "account", label: "Account", where: "You › the account row at the top", description: "Sign out, switch account, or open account settings on the web." }),
  pillOnly({ id: "slack", label: "Slack", where: "You › Slack", description: "Connect or disconnect Slack.", available: (ctx) => ctx.features?.slack === true }),
  pillOnly({ id: "blocked_contacts", label: "Blocked contacts", where: "Contacts › Blocked contacts", description: "Block or unblock people." }),
];
const BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

function availableSettings(ctx) {
  return SETTINGS.filter((setting) => !setting.available || setting.available(ctx));
}

function coerce(setting, value) {
  if (setting.type === "boolean") {
    if (typeof value === "boolean") return value;
    const word = String(value ?? "").trim().toLowerCase();
    if (["true", "on", "yes"].includes(word)) return true;
    if (["false", "off", "no"].includes(word)) return false;
    throw new Error(`${setting.id} is on or off: pass true or false.`);
  }
  if (setting.type === "choice") {
    const match = setting.options.find((option) => option.value === value || option.label.toLowerCase() === String(value ?? "").trim().toLowerCase());
    if (!match) throw new Error(`${setting.id} must be one of: ${setting.options.map((option) => option.value).join(", ")}.`);
    return match.value;
  }
  throw new Error(`${setting.id} is changed by the person in the Relay app: ${setting.where}.`);
}

/** How far an agent may make this change: agent, confirm or pill_only. */
function agentMode(setting, current, next) {
  if (setting.pillOnly) return "pill_only";
  if (setting.raises?.(current, next)) return "confirm";
  return "agent";
}

function describeAgentAccess(setting) {
  if (setting.pillOnly) return "pill_only";
  return setting.raises ? "restrict_now_raise_with_approval" : "change";
}

async function listSettings(ctx) {
  const rows = [];
  for (const setting of availableSettings(ctx)) {
    const row = { id: setting.id, label: setting.label, where: setting.where, description: setting.description, scope: setting.scope, agent: describeAgentAccess(setting) };
    if (!setting.pillOnly) {
      try { row.value = await setting.read(ctx); } catch (error) { row.value = null; row.unavailable = error?.message || String(error); }
      if (setting.options) row.options = setting.options;
    }
    rows.push(row);
  }
  return rows;
}

function findSetting(ctx, id) {
  const setting = BY_ID.get(String(id || "").trim());
  if (!setting || (setting.available && !setting.available(ctx))) {
    throw new Error(`There is no Relay setting called ${JSON.stringify(String(id || ""))} here. Call relay_settings with action='list' for the ones that exist.`);
  }
  return setting;
}

/**
 * Change one setting. `actor` is "person" for the pill (no limits) or
 * "agent" for relay_settings. An agent's change that would give agents more
 * freedom becomes a request the person answers in the pill.
 */
async function setSetting(ctx, id, rawValue, { actor = "agent", requestedBy = "" } = {}) {
  const setting = findSetting(ctx, id);
  if (setting.pillOnly) {
    return { status: "pill_only", setting: setting.id, where: setting.where };
  }
  const value = coerce(setting, rawValue);
  const current = await setting.read(ctx);
  if (current === value) return { status: "unchanged", setting: setting.id, value };
  if (actor === "agent") {
    const mode = agentMode(setting, current, value);
    if (mode === "confirm") {
      const request = addPendingRequest({ setting: setting.id, label: setting.label, type: setting.type, value, valueLabel: valueLabel(setting, value), requestedBy }, ctx.options);
      return { status: "awaiting_approval", setting: setting.id, value, current, requestId: request.id, where: setting.where, expiresAt: request.expiresAt };
    }
    if (mode !== "agent") return { status: "pill_only", setting: setting.id, where: setting.where };
  }
  await setting.write(ctx, value);
  return { status: "changed", setting: setting.id, value, previous: current, where: setting.where };
}

function valueLabel(setting, value) {
  if (setting.type === "boolean") return value ? "on" : "off";
  return setting.options?.find((option) => option.value === value)?.label || String(value);
}

// ---- Requests waiting for the person (confirm mode) ----

function pendingRequests(store, now = Date.now()) {
  return (Array.isArray(store.pending) ? store.pending : [])
    .filter((request) => request && typeof request.id === "string" && Date.parse(request.expiresAt) > now);
}

function addPendingRequest({ setting, label, type, value, valueLabel: shown, requestedBy }, options = {}) {
  const now = Date.now();
  const request = {
    id: `set_${crypto.randomBytes(6).toString("hex")}`,
    setting,
    label,
    type,
    value,
    valueLabel: shown,
    requestedBy: String(requestedBy || "").slice(0, 60) || "An agent",
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString(),
  };
  updateStore((store) => {
    // One open request per setting: a newer ask replaces the older one.
    store.pending = [...pendingRequests(store, now).filter((item) => item.setting !== setting), request];
  }, options);
  return request;
}

/** The person's answer in the pill. Allow applies the value as theirs. */
async function answerPendingRequest(ctx, requestId, allow) {
  const store = readStore(ctx.options);
  const request = pendingRequests(store).find((item) => item.id === requestId);
  updateStore((next) => { next.pending = pendingRequests(next).filter((item) => item.id !== requestId); }, ctx.options);
  if (!request) return { status: "expired" };
  if (!allow) return { status: "declined", setting: request.setting };
  return setSetting(ctx, request.setting, request.value, { actor: "person" });
}

module.exports = {
  AGENT_APPS,
  CHAT_APPS,
  CONFIRM_TTL_MS,
  SETTINGS,
  TASK_DEFAULTS,
  TASK_MODES,
  accountKeyFor,
  adoptLegacy,
  agentMode,
  answerPendingRequest,
  listSettings,
  patchDevice,
  pendingRequests,
  pillSnapshot,
  readStore,
  savePillChoices,
  setSetting,
  settingsPath,
};
