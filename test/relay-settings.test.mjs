import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const settings = require("../src/relay-settings.cjs");

function context(t, overrides = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-settings-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, env: { RELAY_CONFIG_DIR: path.join(homeDir, ".relay") } };
  return { options, accountKey: "usr_self", features: { requests: true }, trayAvailable: true, ...overrides };
}

test("settings live in ~/.relay/settings.json beside the milestone switch, and absent keys stay absent for the pill", (t) => {
  const ctx = context(t);
  assert.equal(path.basename(settings.settingsPath(ctx.options)), "settings.json");
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options), { accountKey: "usr_self", pending: [] }, "nothing saved yet: the pill's own fallbacks answer");

  settings.savePillChoices("usr_self", { agentApps: ["Codex", "Nope"], chatApps: [], conductor: false, theme: "light", taskPermissions: { claude: "acceptEdits", codex: "bogus" } }, ctx.options);
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options), {
    accountKey: "usr_self",
    theme: "light",
    taskPermissions: { claude: "acceptEdits" },
    agentApps: ["Codex"],
    chatApps: [],
    conductor: false,
    pending: [],
  });
  assert.deepEqual(settings.pillSnapshot("usr_other", ctx.options), { accountKey: "usr_other", theme: "light", taskPermissions: { claude: "acceptEdits" }, pending: [] }, "app choices belong to the account");
});

test("an older pill's stored choices are handed over without overwriting anything already in the file", (t) => {
  const ctx = context(t);
  settings.savePillChoices("usr_self", { agentApps: ["Claude Code"] }, ctx.options);
  settings.adoptLegacy("usr_self", { agentApps: ["Codex"], chatApps: ["ChatGPT"], conductor: false, theme: "light", taskPermissions: { codex: "ask" } }, ctx.options);
  const snapshot = settings.pillSnapshot("usr_self", ctx.options);
  assert.deepEqual(snapshot.agentApps, ["Claude Code"], "a choice made since is kept");
  assert.deepEqual(snapshot.chatApps, ["ChatGPT"]);
  assert.equal(snapshot.conductor, false);
  assert.equal(snapshot.theme, "light");
  assert.deepEqual(snapshot.taskPermissions, { codex: "ask" });
});

test("list names every setting with its value, where it lives and what an agent may do", async (t) => {
  const ctx = context(t);
  const rows = await settings.listSettings(ctx);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ["milestone_relays", "show_automatically", "play_sounds", "notification_style", "theme", "open_with_claude", "open_with_chatgpt", "open_with_claude_code", "open_with_codex", "task_permissions_claude_code", "task_permissions_codex", "account", "blocked_contacts"]) {
    assert.ok(byId.has(id), id);
    assert.ok(byId.get(id).where, `${id} says where it lives in the pill`);
  }
  // Features the account does not have are not mentioned.
  for (const id of ["open_with_conductor", "device_execution", "slack", "chat_agent_claude_model"]) assert.equal(byId.has(id), false, id);
  assert.equal(byId.get("milestone_relays").value, true);
  assert.equal(byId.get("milestone_relays").agent, "restrict_now_raise_with_approval");
  assert.equal(byId.get("play_sounds").agent, "change");
  assert.equal(byId.get("account").agent, "pill_only");
  assert.equal(Object.hasOwn(byId.get("account"), "value"), false);
  assert.equal(byId.get("task_permissions_codex").value, "full");
  assert.deepEqual(byId.get("theme").options.map((option) => option.value), ["dark", "light"]);
});

test("an agent makes agents do less at once, and anything that gives them more freedom waits for the person", async (t) => {
  const ctx = context(t);
  const off = await settings.setSetting(ctx, "milestone_relays", "off");
  assert.equal(off.status, "changed");
  assert.equal(settings.readStore(ctx.options).milestoneRelays, false);

  const on = await settings.setSetting(ctx, "milestone_relays", true, { requestedBy: "Claude Code" });
  assert.equal(on.status, "awaiting_approval");
  assert.equal(settings.readStore(ctx.options).milestoneRelays, false, "nothing changed yet");
  const [pending] = settings.pillSnapshot("usr_self", ctx.options).pending;
  assert.equal(pending.setting, "milestone_relays");
  assert.equal(pending.requestedBy, "Claude Code");
  assert.equal(pending.valueLabel, "on");

  // A newer ask for the same setting replaces the older one.
  await settings.setSetting(ctx, "milestone_relays", true, { requestedBy: "Codex" });
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options).pending.map((item) => item.requestedBy), ["Codex"]);

  // Lowering a Task mode applies; raising one waits.
  assert.equal((await settings.setSetting(ctx, "task_permissions_codex", "guardian")).status, "changed");
  assert.equal((await settings.setSetting(ctx, "task_permissions_codex", "Full access")).status, "awaiting_approval");
  assert.equal(settings.readStore(ctx.options).taskPermissions.codex, "guardian");

  // Neutral preferences apply in either direction.
  assert.equal((await settings.setSetting(ctx, "play_sounds", false)).status, "changed");
  assert.equal(settings.readStore(ctx.options).soundsMuted, true);
  assert.equal((await settings.setSetting(ctx, "notification_style", "direct")).status, "changed");
  assert.equal(settings.readStore(ctx.options).notifyStyle, "direct");
  await assert.rejects(settings.setSetting(ctx, "notification_style", "loud"));
  assert.equal((await settings.setSetting(ctx, "open_with_codex", false)).status, "changed");
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options).agentApps, ["Claude Code"]);
  assert.equal((await settings.setSetting(ctx, "theme", "light")).status, "changed");
  assert.equal((await settings.setSetting(ctx, "theme", "light")).status, "unchanged");

  // The person's own account stays theirs.
  assert.deepEqual(await settings.setSetting(ctx, "account", "anything"), { status: "pill_only", setting: "account", where: "You › Account" });
  await assert.rejects(settings.setSetting(ctx, "no_such_setting", true), /no Relay setting called/);
  await assert.rejects(settings.setSetting(ctx, "theme", "purple"), /must be one of: dark, light/);
});

test("the person answers a waiting request in the pill: Allow applies it, Not now drops it", async (t) => {
  const ctx = context(t);
  await settings.setSetting(ctx, "task_permissions_codex", "ask");
  const asked = await settings.setSetting(ctx, "task_permissions_codex", "full");
  assert.equal((await settings.answerPendingRequest(ctx, asked.requestId, false)).status, "declined");
  assert.equal(settings.readStore(ctx.options).taskPermissions.codex, "ask");
  assert.equal((await settings.answerPendingRequest(ctx, asked.requestId, true)).status, "expired", "an answered request cannot be answered again");

  const again = await settings.setSetting(ctx, "task_permissions_codex", "full");
  const allowed = await settings.answerPendingRequest(ctx, again.requestId, true);
  assert.equal(allowed.status, "changed");
  assert.equal(settings.readStore(ctx.options).taskPermissions.codex, "full");
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options).pending, []);
});

test("a request the person never answers lapses", (t) => {
  const ctx = context(t);
  const past = new Date(Date.now() - 1000).toISOString();
  fs.mkdirSync(path.dirname(settings.settingsPath(ctx.options)), { recursive: true });
  fs.writeFileSync(settings.settingsPath(ctx.options), JSON.stringify({ pending: [{ id: "set_old", setting: "milestone_relays", value: true, expiresAt: past }] }));
  assert.deepEqual(settings.pillSnapshot("usr_self", ctx.options).pending, []);
});

test("the pill refuses to hide itself where nothing could bring it back", async (t) => {
  const ctx = context(t, { trayAvailable: false });
  await assert.rejects(settings.setSetting(ctx, "show_automatically", false), /no status-area icon/);
  assert.equal(settings.readStore(ctx.options).pillHidden, undefined);
});

test("account settings need a signed-in account", async (t) => {
  const ctx = context(t, { accountKey: "" });
  await assert.rejects(settings.setSetting(ctx, "open_with_chatgpt", false), /not signed in/);
});
