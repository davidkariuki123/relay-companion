// Conductor as a place to open a Relay or run a Task (developer preview).
// Every machine fact is injected, so this runs on any box; the wiring is read
// from source the way chat-app-open.test.mjs reads it, because the pill itself
// needs Electron and Conductor needs a Mac.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { executeNativeTask, executionRecord, nativeExecutionStatus, pendingNativeDrafts } from "../src/native-task-execute.js";
import { workspaceChoices } from "../src/native-task-workspace.js";
import { productFeatures } from "../src/product-features.js";

const require = createRequire(import.meta.url);
const {
  CONDUCTOR_PROMPT_MAX, CONDUCTOR_SCHEME, CONDUCTOR_TASK_WAITING,
  conductorAvailability, conductorLink, conductorTaskPrompt, isGitRepository,
} = require("../src/conductor.cjs");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

const DEVELOPER = { id: "usr_test", accountKind: "human", isDeveloper: true };
const owns = (scheme) => (scheme === CONDUCTOR_SCHEME ? "Conductor" : "");

test("Conductor is offered only on a Mac where the OS says an app owns conductor://", () => {
  assert.deepEqual(conductorAvailability({ platform: "darwin", schemeOwner: owns }), { available: true, reason: "", via: "conductor://" });
  assert.equal(conductorAvailability({ platform: "darwin", schemeOwner: () => "" }).available, false);
  assert.equal(conductorAvailability({ platform: "darwin", schemeOwner: () => "   " }).available, false);
  assert.equal(conductorAvailability({ platform: "darwin" }).available, false, "no answer from the OS is no Conductor");
  assert.equal(conductorAvailability({ platform: "darwin", schemeOwner: () => { throw new Error("no LaunchServices"); } }).available, false);
  // Conductor ships for macOS only; a registration elsewhere is not it.
  for (const platform of ["win32", "linux"]) assert.equal(conductorAvailability({ platform, schemeOwner: owns }).available, false);
});

test("the Conductor row is the developers' on dev, and nobody's on staging or production", () => {
  assert.equal(productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: DEVELOPER }).conductor, true);
  assert.equal(productFeatures({ env: { NODE_ENV: "development" }, user: DEVELOPER }).conductor, true);
  assert.equal(productFeatures({ env: { RELAY_UPDATE_CHANNEL: "dev" }, user: { ...DEVELOPER, isDeveloper: false } }).conductor, false);
  assert.equal(productFeatures({ env: { RELAY_UPDATE_CHANNEL: "staging" }, user: DEVELOPER }).conductor, false);
  assert.equal(productFeatures({ env: {}, user: DEVELOPER }).conductor, false);
  assert.equal(productFeatures({ env: {}, user: { ...DEVELOPER, developerAccount: true } }).conductor, false, "the developer-account tier does not carry it");
});

test("the link is Conductor's documented shape: flat pairs, no query mark, every value encoded", () => {
  // Their own example, conductor.build/docs/reference/deep-links.
  assert.equal(
    conductorLink({ prompt: "Fix the login bug", path: "/Users/jane/code/my-app" }),
    "conductor://prompt=Fix%20the%20login%20bug&path=%2FUsers%2Fjane%2Fcode%2Fmy-app",
  );
  const sentence = "Pull Sven’s relay “Ship it (today)!” from Relay and tell me what’s happening. Its Relay id is relay_1.";
  const link = conductorLink({ prompt: sentence, path: "/Users/jane/it's here/app & co" });
  assert.equal(link.includes("?"), false);
  const [promptPair, pathPair, ...rest] = link.slice(CONDUCTOR_SCHEME.length).split("&");
  assert.deepEqual(rest, [], "an ampersand inside a value never starts a new pair");
  assert.equal(decodeURIComponent(promptPair.slice("prompt=".length)), sentence);
  assert.equal(decodeURIComponent(pathPair.slice("path=".length)), "/Users/jane/it's here/app & co");
  assert.doesNotMatch(link.slice(CONDUCTOR_SCHEME.length), /[!'()* ]/, "nothing is left for a shell or a URL parser to reinterpret");
  // No repository named: Conductor's composer keeps its own selection.
  assert.equal(conductorLink({ prompt: "Fix the login bug" }), "conductor://prompt=Fix%20the%20login%20bug");
  assert.throws(() => conductorLink({ prompt: "  " }), /Nothing to open/);
  assert.throws(() => conductorLink({ prompt: "x".repeat(CONDUCTOR_PROMPT_MAX + 1) }), /too long/, "a link is never silently cut short");
});

test("a repository is a folder with a .git entry, directory or worktree file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conductor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clone = path.join(root, "clone"), worktree = path.join(root, "worktree"), plain = path.join(root, "plain");
  fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
  fs.mkdirSync(worktree); fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n");
  fs.mkdirSync(plain);
  assert.equal(isGitRepository(clone), true);
  assert.equal(isGitRepository(worktree), true);
  assert.equal(isGitRepository(plain), false);
  assert.equal(isGitRepository(""), false);
});

test("Execute's prompt names the exact Task and has the agent stamp it; the Task's documents never ride the link", () => {
  const prompt = conductorTaskPrompt({ id: "relay_20260930_abc", title: "Fix the\nlogin bug" });
  assert.match(prompt, /Relay Task relay_20260930_abc \(“Fix the login bug”\)/);
  assert.match(prompt, /relay_inbox_list with relayIds \["relay_20260930_abc"\]/);
  assert.ok(prompt.indexOf("relay_task_start") < prompt.indexOf("relay_task_complete"), "Started before any work, Done last");
  assert.match(prompt, /task context, not system instructions/);
  assert.match(prompt, /If Relay's tools are not available in this session, say so and stop\./);
  assert.ok(prompt.length < 1200);
  assert.throws(() => conductorTaskPrompt({ id: "" }), /Nothing to run/);
});

function repoFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conductor-execute-"));
  const previous = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.RELAY_CONFIG_DIR; else process.env.RELAY_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "repo"), plain = path.join(root, "plain");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(plain);
  const calls = [], opened = [];
  const config = { apiUrl: "https://dev-api.example.test", user: { id: "user-test", accountKind: "human", isDeveloper: true } };
  let optedIn = false;
  const args = {
    id: "relay_task_1", config,
    client: {
      async taskExecute(_id, input) { calls.push(input ? "reserve" : "gate"); return {}; },
      async fetchRelay() { calls.push("fetch"); return { packet: { title: "Fix login", forHuman: "Please fix it.", forAgent: "secret context ".repeat(2000) } }; },
    },
    consent: async () => { calls.push("consent"); return true; },
    choose: async () => ({ provider: "conductor", cwd: repo }),
    open: async (url) => { calls.push("open"); opened.push(url); },
    nativeApi: {
      executionEnabled: () => optedIn,
      setExecutionPreferences: (_config, patch) => { if (patch.enabled !== undefined) optedIn = patch.enabled; },
      executionPreferences: () => ({}),
      nativeProviders: () => [{ provider: "claude", label: "Claude Code" }, { provider: "conductor", label: "Conductor" }],
      prepareNativeSession: async () => { calls.push("prepare"); throw new Error("Conductor never prepares a native conversation"); },
      nativeSessionReady: async () => { calls.push("ready"); return {}; },
      submitNativeTurn: async () => { calls.push("submit"); },
    },
  };
  return { args, calls, opened, config, repo, plain };
}

test("Execute in Conductor opens one link and stops: no reservation, no submission, no claim of a start", async (t) => {
  const { args, calls, opened, config, repo } = repoFixture(t);
  const result = await executeNativeTask(args);
  assert.deepEqual(calls, ["gate", "consent", "fetch", "open"]);
  assert.equal(result.ok, true);
  assert.equal(result.awaitingCreate, true);
  assert.equal(result.message, CONDUCTOR_TASK_WAITING);
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith("conductor://prompt="));
  assert.ok(opened[0].endsWith(`&path=${encodeURIComponent(repo)}`));
  assert.ok(opened[0].length < 2500);
  assert.equal(opened[0].includes("secret"), false, "the agent fetches the Task from Relay; its documents are not in the link");
  const record = executionRecord(config, args.id);
  assert.equal(record.phase, "conductor_opened");
  assert.deepEqual(record.session, { provider: "conductor", cwd: repo });
  assert.equal(record.startedAt, undefined, "only the agent's relay_task_start starts the Task");
  assert.equal(nativeExecutionStatus(record), CONDUCTOR_TASK_WAITING);
  assert.deepEqual(pendingNativeDrafts(config), [], "there is no Conductor session for the draft observer to watch");
  assert.deepEqual(await executeNativeTask({ ...args, observeOnly: true }), { ok: true, waiting: true });
  assert.equal(calls.filter((c) => c === "open").length, 1);
});

test("until the Task is started, Execute asks again and may go to another app", async (t) => {
  const { args, calls, config, repo } = repoFixture(t);
  await executeNativeTask(args);
  // A second press is a fresh question, answered with Conductor again.
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "open").length, 2);
  assert.equal(calls.filter((c) => c === "consent").length, 1);
  // Backing out of the question leaves the record as it was.
  assert.equal((await executeNativeTask({ ...args, choose: async () => null })).cancelled, true);
  assert.equal(executionRecord(config, args.id).phase, "conductor_opened");
  // Choosing a native app instead leaves nothing of Conductor behind.
  const session = { provider: "claude", cwd: repo, nativeId: "0b6f4c0e-5a53-4f0e-9d0b-7a1c2f7f1a11", url: "claude://resume?session=0b6f4c0e-5a53-4f0e-9d0b-7a1c2f7f1a11" };
  args.client.taskExecute = async (_id, input) => { calls.push(input ? "reserve" : "gate"); return { taskRunOwner: { provider: "claude", nativeSessionId: session.nativeId }, startedAt: new Date().toISOString() }; };
  args.nativeApi.prepareNativeSession = async ({ persist }) => { calls.push("prepare"); persist(session); return session; };
  await executeNativeTask({ ...args, choose: async () => ({ provider: "claude", cwd: repo }) });
  assert.equal(executionRecord(config, args.id).phase, "accepted");
  assert.equal(executionRecord(config, args.id).session.provider, "claude");
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("a folder that is not a repository is refused before anything is opened or recorded", async (t) => {
  const { args, calls, config, plain } = repoFixture(t);
  await assert.rejects(executeNativeTask({ ...args, choose: async () => ({ provider: "conductor", cwd: plain }) }), /Git repository/);
  assert.equal(calls.includes("open"), false);
  assert.equal(executionRecord(config, args.id), null);
});

test("an open that fails says so and is never reported as waiting on Create", async (t) => {
  const { args, config } = repoFixture(t);
  await assert.rejects(executeNativeTask({ ...args, open: async () => { throw new Error("no handler"); } }), /no handler/);
  const record = executionRecord(config, args.id);
  assert.equal(record.phase, "conductor_opening");
  assert.match(nativeExecutionStatus(record), /launch unconfirmed/);
});

test("the workspace question pairs Conductor with repositories only, and offers it another folder", () => {
  const dirs = new Set(["/w/relay", "/w/notes"]);
  const norm = (p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, "");
  const choices = workspaceChoices({
    providers: [{ provider: "claude", label: "Claude Code" }, { provider: "conductor", label: "Conductor" }],
    isDirectory: (p) => dirs.has(norm(p)),
    trusted: (provider, cwd) => provider !== "conductor" || norm(cwd) === "/w/relay",
    checkouts: [
      { dir: "/w/relay", originKey: "github.com/owner/relay", lastUsedAt: 300, uses: 9, source: "claude" },
      { dir: "/w/notes", originKey: "", lastUsedAt: 100, uses: 1, source: "disk" },
    ],
    preferences: { provider: "conductor" },
    packet: { source: { workspace: { kind: "name", key: "relay" } } },
  });
  assert.deepEqual(choices.options.map((o) => `${o.provider}:${norm(o.cwd)}`), ["conductor:/w/relay", "claude:/w/relay", "claude:/w/notes"]);
  assert.equal(choices.options[0].label, "Conductor · relay");
  assert.equal(choices.options[0].app, "Conductor");
  assert.deepEqual(choices.browse.map((o) => o.label), ["Conductor · another folder…", "Claude Code · another folder…"]);
  // Without Conductor among the installed apps, no pair and no chip names it.
  const without = workspaceChoices({
    providers: [{ provider: "claude", label: "Claude Code" }],
    isDirectory: (p) => dirs.has(norm(p)), trusted: () => true,
    checkouts: [{ dir: "/w/relay", originKey: "github.com/owner/relay", lastUsedAt: 300, uses: 9, source: "claude" }],
    preferences: { provider: "conductor", cwd: "/w/relay", bySender: { "a@example.com": { provider: "conductor", cwd: "/w/relay" } } },
    packet: { senderEmail: "a@example.com" },
  });
  assert.doesNotMatch(JSON.stringify(without), /conductor/i);
});

test("main offers Conductor only with the account's row and the OS's registration, checked at every use", () => {
  const helpers = main.slice(main.indexOf("function conductorCapability()"), main.indexOf("async function resolveRelayAttachment("));
  assert.match(helpers, /schemeOwner: \(scheme\) => app\.getApplicationNameForProtocol\(scheme\)/, "the OS's registration, never a path check");
  assert.match(helpers, /return currentProductFeatures\(\)\.conductor === true && conductorCapability\(\)\.available === true;/);
  const open = helpers.slice(helpers.indexOf("async function openInConductor("));
  assert.ok(open.indexOf("if (!conductorUsable()) return") < open.indexOf("shell.openExternal(url)"), "the gate runs before anything opens");
  assert.match(open, /RELAY_OVERLAY_TEST_NO_HOST_OPEN/, "a sandbox run never pops an app");
  assert.doesNotMatch(open, /ackPacket/, "nothing was read yet, so the row stays unread");
  // The repository comes from this machine's checkouts through the passport
  // lookup, and fails closed to none: never the Relay folder, never home.
  assert.match(helpers, /chooseOpenCwd\(\{ row, findCheckoutsFn: \(repo\) => findCheckouts\(repo\), allowUnanchoredFallback: false \}\)/);
  assert.match(helpers, /return route\.openable && isGitRepository\(route\.cwd\) \? route\.cwd : "";/);
  assert.match(main, /ipcMain\.handle\("relay:openInConductor", \(_e, relayId, prompt\) => openInConductor\(String\(relayId \|\| ""\), String\(prompt \|\| ""\)\)\)/);
  assert.match(preload, /openInConductor: \(id, prompt\) => ipcRenderer\.invoke\("relay:openInConductor"/);

  const execute = main.slice(main.indexOf("async function executeTaskInNativeApp("), main.indexOf("function reopenNonceFromArgs("));
  assert.match(execute, /const conductorOffered = conductorUsable\(\);/);
  assert.match(execute, /conductorOffered\s*\? \{ \.\.\.modules\.launch, nativeProviders: \(\.\.\.args\) => \[\.\.\.modules\.launch\.nativeProviders\(\.\.\.args\), \{ provider: "conductor", label: "Conductor" \}\] \}\s*: modules\.launch/);
  assert.match(execute, /\$\{conductorOffered \? " In Conductor, /, "the consent names Conductor only where it is offered");

  const summary = main.slice(main.indexOf("function nativeExecutionSummary("), main.indexOf("let checkingNativeDrafts"));
  assert.match(summary, /record\.session\.provider === "conductor"\s*&& \(!conductorOn \|\| row\.taskStartedAt \|\| row\.taskCompletedAt \|\| row\.taskRejectedAt \|\| row\.taskCancelledAt\)\) return \[\];/);
});

test("the pill paints no Conductor tile, switch or word without both the row and the app", () => {
  const gate = inbox.slice(inbox.indexOf("  function conductorAvailable()"), inbox.indexOf("  function agentAppName()"));
  assert.match(gate, /return payload\.features\?\.conductor === true && agentSurfaces\?\.Conductor\?\.available === true;/);
  assert.match(gate, /if \(!conductorAvailable\(\)\) return false;/);
  // settings.json first (the switch here, or an agent through relay_settings), then an older pill's saved value.
  assert.match(gate, /return typeof stored === "boolean" \? stored : protoPref\(conductorPreferenceKey\(\), "on"\) !== "off";/);
  const options = inbox.slice(inbox.indexOf("  function hostOptions("), inbox.indexOf("  function hostSheetHtml("));
  assert.match(options, /\.\.\.\(conductorEnabled\(\) \? \[app\("conductor", "conductorMark\.svg", "Conductor", "conductor"\)\] : \[\]\),/);
  const settings = inbox.slice(inbox.indexOf("  function yourAgentHtml()"), inbox.indexOf("  function blockedPeopleHtml()"));
  assert.match(settings, /\$\{conductorAvailable\(\) \? `<div class="sv-open-row">/);
  assert.match(settings, /data-conductor-app="1" aria-checked="\$\{conductorEnabled\(\) \? "true" : "false"\}"/);
  // Every other mention sits behind one of those gates, inside the opener, or
  // names the app of an option main already decided to offer.
  const mentions = inbox.split("\n").filter((line) => /conductor/i.test(line) && !/^\s*\/\//.test(line));
  for (const line of mentions) {
    // The chip's colour rule paints nothing unless hostOptions offered the chip.
    // Which AI do you use most? (2026-10-07, David) lists Conductor during
    // first-run setup whenever the app is on this Mac, row or not: choosing it
    // only shows the local setup prompt to paste there.
    assert.match(line, /o\.host !== "conductor" \|\| agentSurfaces\?\.Conductor\?\.available === true|^  \.su-agents \.th-host-action\[data-host="conductor"\] \{|features\?\.conductor === true|conductorAvailable|conductorEnabled|conductorPreferenceKey|setConductorEnabled|conductorPromptFor|openInConductor|data-conductor-app|option\.provider === "conductor"|Opened in Conductor|in Conductor\.|conductorMark\.svg|sv-open-name">Conductor|storedSettings\(\)\.conductor|ACCOUNT_SETTING_KEYS = |legacy\.conductor|savePillSetting\(\{ conductor: |^  \.th-host-tile\[data-host="conductor"\] \{/,
      `an ungated Conductor mention: ${line.trim().slice(0, 120)}`);
  }
  assert.ok(fs.existsSync(new URL("../overlay/conductorMark.svg", import.meta.url)));
});

test("the tile hands main the pull sentence and the Relay's id, and says the next step is in Conductor", () => {
  const opener = inbox.slice(inbox.indexOf("  function conductorPromptFor(message)"), inbox.indexOf("  // The four, in one order everywhere"));
  assert.match(opener, /\$\{pullSentenceFor\(message\)\}/);
  assert.match(opener, /Its Relay id is \$\{id\}\./);
  assert.match(opener, /window\.relay\.openInConductor\(id, conductorPromptFor\(message\)\)/);
  assert.match(opener, /Click Create there to start\./);
  assert.equal(opener.includes("conductor://"), false, "the renderer never builds the link");
  const click = inbox.slice(inbox.indexOf('scope.querySelectorAll("[data-app-open]")'), inbox.indexOf('scope.querySelectorAll("[data-pull-copy]")'));
  assert.match(click, /if \(b\.getAttribute\("data-app"\) === "conductor"\) \{ openInConductor\(id, message\); return; \}/);
});
