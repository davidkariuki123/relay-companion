#!/usr/bin/env node
import os from "node:os";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync, spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { RelayClient } from "../src/client.js";
import {
  writeConfig,
  readConfig,
  apiUrl,
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  DEFAULT_DEV_API_URL,
  DEFAULT_STAGING_API_URL,
  UPDATE_CHANNEL_STABLE,
  UPDATE_CHANNEL_DEV,
  UPDATE_CHANNEL_STAGING,
  updateChannel,
} from "../src/config.js";
import { runTaskDaemon, pollTaskRuntimeOnce } from "../src/task-daemon.js";
import { runMcpServer } from "../src/mcp.js";
import {
  resolveCliTrampoline,
  runCliTrampoline,
  TRAMPOLINE_ENV,
  TRAMPOLINE_SHIM_ROOT_ENV,
  TRAMPOLINE_SHIM_VERSION_ENV,
} from "../src/cli-trampoline.js";
import {
  hookInstallNotices,
  purgeLocalState,
  windowsAutostartTaskStatus,
  repairDesktopSurfaces,
  repairExistingAgentHooks,
  repairExistingAgentRegistrations,
  accountRestartLines,
  restartRelayServices,
  runSetupInstall,
  runUninstall,
  windowsStartMenuShortcutMissing,
  windowsStartMenuShortcutPath,
} from "../src/install.js";
import { companionPackageRoot, readMigrationFailure, readRecoveryFailure, runUpdateOnce } from "../src/auto-update.js";
import { canonicalRuntimeLayout, readCanonicalRuntimeState } from "../src/canonical-runtime.js";
import { listUpdateWorkerJobs } from "../src/canonical-updater.js";
import { pillStatusPath, waitForPillReady } from "../src/pill-control.js";
import { liveToolRequirement, requiredLiveHosts, shouldRequireLiveTools } from "../src/setup-activation.js";
import { openRelay, openTask } from "../src/materializer.js";
import { runClaudeHook } from "../src/claude-hook.js";
import { runCodexHook } from "../src/codex-hook.js";
import { normalizePairingCode, persistPairedAccount } from "../src/account.js";
import { resetCompanionStateForAccount } from "../src/notifications.js";
import { finishSetupOpenRelay, normalizeSetupHost, setupOpenRelayToken, setupOpenStatus } from "../src/setup-open.js";
import { migratePersistedContentFields } from "../src/content-field-migration.js";
import { accountProductFeatures } from "../src/product-features.js";
import {
  importLegacyHistory,
  prepareE2eeHistoryImport,
} from "../src/e2ee-history-import.js";
import e2eeIdentity from "../src/e2ee-identity.cjs";

const { createPairingIdentity, persistPairedIdentity } = e2eeIdentity;

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function rejectRemovedCapabilityFlags(command, flags) {
  if (!flags.full && !flags["messages-only"]) return;
  // One release-boundary exception: an older updater invokes a newly installed
  // candidate's internal repair-runtime command with one of these flags. New
  // launchers never emit them, and every human-facing command rejects them.
  if (command === "repair-runtime" && process.env.RELAY_SKIP_DESKTOP_POSTINSTALL === "1") return;
  throw new Error(
    "--full and --messages-only were removed. Relay capabilities now require the signed-in account's developer role on dev.",
  );
}

async function requireTaskFeatures() {
  const client = new RelayClient();
  const features = await accountProductFeatures({
    client,
    env: process.env,
    config: readConfig(),
    apiUrl: apiUrl(),
    timeoutMs: 15_000,
  });
  if (!features.requests) {
    throw new Error("Requests are currently available only to Relay developer accounts on dev.");
  }
  return features;
}

function companionVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function prompt(question, fallback = "") {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer || fallback;
}

async function cmdPair(flags, { promptForDefaults = true } = {}) {
  let url = flags.api || process.env.RELAY_API_URL;
  if (!url) {
    url = promptForDefaults ? await prompt(`Relay API URL [${apiUrl()}]: `, apiUrl()) : DEFAULT_API_URL;
  }
  const appUrl = flags.web || process.env.RELAY_WEB_URL || DEFAULT_WEB_URL;
  let code = flags.code;
  if (!code) code = await prompt("Pairing code (from your Relay app): ");
  let name = flags.name;
  if (!name) {
    name = promptForDefaults ? await prompt(`Device name [${os.hostname()}]: `, os.hostname()) : os.hostname();
  }
  writeConfig({ apiUrl: url, webUrl: appUrl });
  const client = new RelayClient({ url });
  const pairingCode = normalizePairingCode(code);
  const encryptionIdentity = createPairingIdentity({ pairingCode, name, platform: process.platform });
  const res = await client.registerDevice({
    pairingCode,
    name,
    platform: process.platform,
    e2eeIdentity: encryptionIdentity.request,
  });
  // Persist the private key before the bearer token. If the second write fails,
  // the key is still recoverable; the reverse ordering could leave a registered
  // public identity whose private half was permanently lost.
  persistPairedIdentity(encryptionIdentity.state, res);
  // The same persistence the pill's Settings tab uses (src/account.js), so the
  // stored credential shape can never drift between the two pairing surfaces.
  persistPairedAccount({ apiUrl: url, webUrl: appUrl, deviceName: name, registration: res });
  await new RelayClient({ url }).ensureE2eeReady();
  resetCompanionStateForAccount({ user: res.user, deviceId: res.deviceId });
  console.log(`Paired as ${res.user.name} <${res.user.email}>. This device is now connected to Relay.`);
  // A re-pair on a machine whose services are already running must reach
  // them, exactly as the pill's Switch Account does; until 2026-08-18 this
  // path never restarted anything, so a CLI re-pair left the daemon and pill
  // on the previous account until the next logon. On a first `relay setup`
  // nothing is installed yet and this is a silent no-op.
  if (!flags["no-restart"]) {
    const restarted = await restartRelayServices({ services: ["daemon", "pill"] });
    for (const line of accountRestartLines(restarted)) console.log(line);
  }
}

function printActivationStatus(activation) {
  if (!activation) return;
  if (activation.host === "Codex") {
    if (activation.currentSessionReady) {
      if (activation.readinessMode === "deferred_tool_search") {
        console.log("Relay tools are available in this Codex session through Codex tool search (`relay_send`).");
        return;
      }
      if (activation.readinessMode === "deferred_tool_search_unverified") {
        console.log("Relay was added to Codex. Codex can load the Relay tools through tool search (`relay_send`).");
        return;
      }
      console.log("Relay tools are live in this Codex session (`relay_send` verified).");
      return;
    }
    if (activation.serverCatalogHasTool) {
      console.log(
        "Relay was added to Codex and the MCP server advertises relay_send, but this open Codex session has not exposed relay_send to the agent yet.",
      );
      return;
    }
    const detail = activation.reason ? ` (${activation.reason})` : "";
    console.log(`Relay was added to Codex, but this open Codex session does not expose relay_send yet${detail}.`);
    return;
  }
  if (activation.host === "Claude Code") {
    if (activation.ok) {
      console.log("Relay was added to Claude Code for new sessions. Existing Claude Code sessions may need their MCP tools reloaded from inside Claude.");
    } else {
      console.log("Relay could not verify the Claude Code MCP registration.");
    }
  }
}

function statusAreaReopenText() {
  if (process.platform === "darwin") return "the Relay app in Spotlight or the Relay icon in the menu bar";
  // Name the Start Menu first on Windows: the tray icon is usually behind the
  // overflow chevron, so it is the harder of the two to find, not the easier.
  if (process.platform === "win32") return "Relay in the Start Menu or the Relay icon in the system tray (behind the ^ near the clock)";
  return "the Relay icon in the system tray";
}

/** Register the Relay tools into Claude Code + Codex and start the receive daemon. */
async function applyInstall({
  requireLiveTools = false,
  requiredHosts = requiredLiveHosts(),
  claim = false,
  reload = true,
} = {}) {
  const {
    installed,
    missing,
    daemon,
    pill,
    activations = [],
    binStable = true,
    claudeHooks = null,
    codexHooks = null,
    desktopRestarts = [],
    sweptStaleEntries = [],
  } = await runSetupInstall({ claim, reload });
  if (installed.length) console.log(`Added Relay to ${installed.join(" and ")} on this machine.`);
  if (!binStable) {
    console.log(
      "Heads up: Relay is running from a temporary npx cache and couldn't global-install. It may stop working when that cache is cleaned — run `npm install -g relay-companion` to make it permanent.",
    );
  }
  for (const m of missing) {
    if (!/registration failed/.test(m)) console.log(`${m} was not found here, so it was skipped.`);
    else console.log(`Could not register ${m}.`);
  }
  for (const activation of activations) printActivationStatus(activation);
  for (const notice of hookInstallNotices({ claudeHooks, codexHooks })) console.log(notice);
  if (daemon.ok) console.log("Relay is running in the background and will start automatically when you log in.");
  else if (daemon.reason === "autostart_unsupported_platform") {
    console.log("Run `relay daemon` to receive relays (background autostart is macOS-only for now).");
  } else {
    const failure = [daemon.reason, daemon.detail].filter(Boolean).join(": ");
    const detail = failure ? ` (${failure})` : "";
    console.log(`Could not install Relay background autostart${detail}. Run \`relay daemon\` to receive relays.`);
  }
  if (pill?.ok) console.log(`The Relay pill is open and will start automatically when you log in. Reopen it from ${statusAreaReopenText()} after hiding it.`);
  else if (pill?.reason === "pill_runtime_missing") {
    console.log("Run `relay pill` to open the Relay pill.");
  } else if (pill?.reason === "autostart_unsupported_platform") {
    console.log(`Run \`relay pill\` to open the Relay pill. Reopen it from ${statusAreaReopenText()} after hiding it.`);
  } else if (pill) {
    const failure = [pill.reason, pill.detail].filter(Boolean).join(": ");
    const detail = failure ? ` (${failure})` : "";
    console.log(`Could not install Relay pill autostart${detail}. Run \`relay pill\` to open it.`);
  }
  // Nothing was installed because no agent lives on this machine. This is the
  // single most likely outcome for someone who was sent a relay and followed the
  // instructions, and it used to print the skip lines above and exit 0 -- with
  // the downloadable .command wrapper then adding "Relay is set up." The person
  // ends up with a paired device, a daemon and a pill, and no way to receive a
  // relay in an agent, having been told it worked.
  if (sweptStaleEntries.length) {
    // A stale entry is not harmless: Claude Desktop validates the schema, not the
    // filesystem, so it spawns and crashes on every single app launch.
    console.log(`Removed a broken Relay entry that pointed at a path that no longer exists (${sweptStaleEntries.join(", ")}).`);
  }

  if (!installed.length) {
    console.log("");
    console.log("Relay could not finish: no Claude or Codex app was found on this machine.");
    console.log("Relay delivers into an AI assistant, so it needs one of these first:");
    console.log("  Claude        https://claude.com/download        (desktop app)");
    console.log("  ChatGPT/Codex https://chatgpt.com/download       (desktop app)");
    console.log("  Claude Code   https://claude.com/claude-code     (terminal)");
    console.log("Install one, then run this command again.");
    console.log("");
    console.log(`In the meantime you can read and reply to your relays on the web: ${absoluteWebTarget("/app/relays")}`);
    return { installed, missing, daemon, pill, activations, agentMissing: true };
  }

  if (desktopRestarts.length) {
    console.log("");
    // These apps read their config only at process start, so the registration is
    // inert until a FULL quit. Closing the window is not enough, and saying so
    // vaguely is how people conclude it did not work.
    for (const app of desktopRestarts) {
      console.log(`Registered with ${app}. Fully quit it (Cmd-Q on macOS, Quit from the tray on Windows) and reopen to use Relay.`);
    }
  }

  const liveRequirement = liveToolRequirement({ activations, requiredHosts });
  if (requireLiveTools && !liveRequirement.ok) {
    // Registration only takes effect in a NEW agent session, so the session that
    // ran this command can never report itself ready -- verifyClaudeMcpRegistration
    // returns currentSessionReady:false on every path by construction. Treating
    // that as a failure turned a successful install into `exit 1`, and skipped the
    // open-relay step that is the entire reason the recipient ran this. Say what
    // to do instead of failing.
    const hostLabel = liveRequirement.missingHosts.length
      ? liveRequirement.missingHosts.join(" and ")
      : "this agent session";
    console.log("");
    console.log(`Relay is installed. Restart ${hostLabel} (or open a new session) to use it.`);
  }
  return { installed, missing, daemon, pill, activations };
}

/**
 * First contact installs the verified desktop runtime while signed out. Account
 * authorization happens in Relay's own pill/browser surface, where the person can
 * see the product and consent. --code remains only for old setup links during the
 * migration window; it is never required or prompted for by the new flow.
 */
async function cmdSetup(flags) {
  if (flags.restart) {
    if (flags.code) throw new Error("Relay setup --restart cannot be combined with the legacy --code path.");
    const { createInstallationAuthorizationController } = await import("../src/installation-authorization.js");
    await createInstallationAuthorizationController().restart();
    console.log("Restarted Relay's one-time account setup. The app will open with a fresh approval.");
    console.log("");
  }
  if (flags.code) {
    console.log("Using Relay's legacy pairing-code migration path.");
    await cmdPair(flags, { promptForDefaults: Boolean(flags.interactive) });
    console.log("");
  } else {
    const hasSavedCredential = Boolean(readConfig().deviceToken);
    let savedCredentialRejected = false;
    if (hasSavedCredential) {
      try {
        await new RelayClient().me();
      } catch (error) {
        savedCredentialRejected = [401, 403].includes(Number(error?.status));
      }
    }
    if (hasSavedCredential && !savedCredentialRejected) {
      console.log("Relay has a saved sign-in on this machine. Keeping that account while installing the current app.");
    } else if (savedCredentialRejected) {
      console.log("Relay’s service no longer accepts this computer’s saved sign-in. Installing the app and opening account recovery.");
    } else {
      console.log("Installing Relay first. The Relay pill will open signed out so you can review it and sign in there.");
    }
    console.log("");
  }
  const install = await applyInstall({
    requireLiveTools: Boolean(flags["require-live-tools"]) || shouldRequireLiveTools(),
    requiredHosts: requiredLiveHosts(),
    // An explicit setup is the migration/ownership handoff. Runtime verification
    // in runSetupInstall completes before either platform's autostart is changed.
    claim: true,
    // The signed thin bootstrap asks setup to write all registrations without
    // starting them, then performs the same exact-root lifecycle as the updater.
    // Ordinary setup keeps its historical install-and-start behaviour.
    reload: !(flags["no-restart"] && process.env.RELAY_BOOTSTRAP_ACTIVATED === "1"),
  });
  const token = setupOpenRelayToken(flags);
  if (token && readConfig().deviceToken) {
    console.log("");
    const host = normalizeSetupHost(flags.host || flags.in);
    const result = await finishSetupOpenRelay({
      token,
      host,
      log: (m) => process.stderr.write(`[relay] ${m}\n`),
    });
    const openStatus = setupOpenStatus(result.opened, openUrl);
    if (openStatus.opened) {
      console.log(`Opened relay ${result.relayId} in ${host === "codex" ? "Codex" : "Claude Code"}.`);
    } else if (openStatus.url) {
      console.log(`Relay ${result.relayId} is ready. Open this URL: ${openStatus.url}`);
    } else {
      console.log(`Relay ${result.relayId} is staged in the Relay pill.`);
    }
  } else if (token) {
    console.log("");
    console.log("Sign in from the Relay pill first; the relay will be available in that account afterward.");
  }
  // The relay is opened/staged first -- the recipient should still get the thing
  // they came for -- but setup did not achieve what it claims, so it must not
  // report success. `exitCode` rather than `exit()` so nothing above is truncated.
  if (install?.agentMissing) process.exitCode = 1;
}

/** Install the tools + daemon on a device that is already paired. */
async function cmdInstall(flags = {}) {
  await applyInstall({
    requireLiveTools: shouldRequireLiveTools(),
    requiredHosts: requiredLiveHosts(),
    claim: Boolean(flags.claim),
  });
}

function cmdRepairDesktop(flags = {}) {
  const reload = !flags["no-restart"];
  // Repair is deliberately local and non-destructive. It may rewrite Relay's
  // launchers and Relay-owned hook registrations, but it never rewrites account
  // config, deletes credentials/E2EE state, clears messages/outboxes/preferences,
  // or calls a cloud revocation endpoint.
  // The updater invokes this command from the verified candidate tree before it
  // switches/restarts services. First atomically migrate any existing raw hook
  // registrations to Relay's stable bridge; if that fails, do not claim the
  // candidate is safe to activate.
  const hookRepair = repairExistingAgentHooks();
  if (!hookRepair.ok) {
    throw new Error(`Could not repair Relay agent hooks (${hookRepair.reason || "migration failed"}).`);
  }
  const repaired = repairDesktopSurfaces({ reload, claim: Boolean(flags.claim) });
  if (!repaired.ok) {
    const failures = [
      !repaired.daemon?.ok && `daemon: ${repaired.daemon?.message || repaired.daemon?.reason || "install failed"}`,
      !repaired.pill?.ok && `pill: ${repaired.pill?.message || repaired.pill?.reason || "install failed"}`,
    ].filter(Boolean);
    throw new Error(`Could not repair Relay desktop services (${failures.join(", ")}).`);
  }
  const appText = repaired.pill?.appPath ? ` Relay.app is installed at ${repaired.pill.appPath}.` : "";
  const restartText = reload ? "Relay background services were reloaded." : "Relay background service files were refreshed without restarting them.";
  console.log(`${restartText}${appText}`);
  return repaired;
}

function cmdRepairRuntime(flags = {}) {
  writeConfig({});
  const reload = !flags["no-restart"];
  // Internal target overrides let a verified immutable candidate restore an
  // older legacy runtime whose own CLI predates `repair-runtime`.
  const targetBin = flags["target-bin"] ? path.resolve(String(flags["target-bin"])) : undefined;
  const targetNode = flags["target-node"] ? String(flags["target-node"]) : undefined;
  const target = {
    ...(targetBin ? { bin: targetBin } : {}),
    ...(targetNode ? { node: targetNode } : {}),
  };
  const registrations = repairExistingAgentRegistrations(target);
  if (!registrations.ok) {
    throw new Error(`Could not repair Relay agent registrations (${registrations.reason || "migration failed"}).`);
  }
  const repaired = repairDesktopSurfaces({ reload, ...target, claim: Boolean(flags.claim) || Boolean(targetBin) });
  if (!repaired.ok) {
    throw new Error("Could not repair Relay runtime services.");
  }
  return { ok: true, registrations, ...repaired };
}

/**
 * Remove the Relay tools from every agent and stop the background daemon. The
 * pairing survives by default so a reinstall is painless; `--purge` forgets this
 * machine entirely — revokes the device server-side, then deletes the pairing
 * and all companion state — so the next `relay setup` is a genuinely new device.
 */
async function cmdUninstall(flags = {}) {
  const purge = Boolean(flags.purge);
  let revocation = null;
  if (purge) {
    // Revoke first: the token needed to do it lives in the state deleted below.
    const cfg = readConfig();
    if (cfg.deviceToken) {
      try {
        await new RelayClient().revokeSelf();
        revocation = "revoked";
      } catch (err) {
        // A token the server no longer recognises is already gone, which is the
        // outcome purge wants; anything else is reported, never fatal — the human
        // asked to forget this machine and can revoke from Settings > Devices.
        revocation = err && err.status === 401 ? "already_revoked" : `failed: ${err && err.message ? err.message : err}`;
      }
    } else {
      revocation = "not_paired";
    }
  }

  const uninstalled = runUninstall();
  console.log("Removed Relay from Claude Code, Codex, and Claude Desktop, and stopped the background daemon.");
  const desktop = uninstalled && uninstalled.claudeDesktop;
  if (desktop && desktop.removedFrom && desktop.removedFrom.length) {
    console.log("Restart Claude Desktop so it stops loading the removed Relay server.");
  }
  if (desktop && desktop.failures && desktop.failures.length) {
    for (const f of desktop.failures) console.log(`Could not edit ${f.configPath} (${f.detail}); remove the "relay" entry by hand.`);
  }

  if (!purge) return;

  if (revocation === "revoked") console.log("Revoked this device on your Relay account.");
  else if (revocation === "already_revoked") console.log("This device was already revoked on your Relay account.");
  else if (revocation === "not_paired") console.log("This device was not paired, so there was nothing to revoke.");
  else console.log(`Could not revoke this device (${revocation}). Revoke it from sendrelays.com > Settings > Devices.`);

  const purged = purgeLocalState();
  for (const target of purged.removed) console.log(`Deleted ${target}`);
  for (const f of purged.failed) console.log(`Could not delete ${f.path} (${f.detail}); remove it by hand.`);
  console.log("");
  // The pairing outliving a purge is the one failure that silently defeats the
  // whole command: everything looks cleaned up and the next setup adopts the old
  // device. Say so plainly and fail the exit code.
  if (purged.pairingRemains) {
    console.log("WARNING: the pairing file survived, so this machine is NOT yet forgotten.");
    console.log("Delete it by hand, then run this again:");
    console.log(`  ${path.join(os.homedir(), ".relay", "config.json")}`);
    process.exitCode = 1;
    return;
  }
  if (!purged.ok) {
    console.log("The pairing is gone, so this machine is forgotten, but some files above could not be deleted.");
    console.log("They are inert leftovers — remove them by hand when whatever holds them exits.");
  }
  console.log("This machine has forgotten Relay. To remove the package itself, run:");
  console.log("  npm uninstall -g relay-companion");
}

async function cmdWhoami() {
  const cfg = readConfig();
  if (!cfg.deviceToken) {
    console.log("Not paired. Run: relay pair");
    return;
  }
  const client = new RelayClient();
  const me = await client.me();
  console.log(`${me.user.name} <${me.user.email}>  (api: ${apiUrl()})`);
}

async function cmdTasksOnce(flags = {}) {
  await requireTaskFeatures();
  const out = await pollTaskRuntimeOnce({ log: (m) => console.log(`[relay] ${m}`) });
  console.log(
    `Processed ${out.sessions.length} task session(s), ${out.messages.length} message(s), ${out.notifications.length} Relay companion item(s).`,
  );
}

function absoluteWebTarget(pathOrUrl = "/app/tasks") {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${webUrl()}${path}`;
}

function openUrl(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    console.log(url);
    return false;
  }
  return true;
}

// `relay open <id> --host <host>` — materialize the staged Relay row into a real
// native agent session inside the already-running Claude Desktop or Codex, then
// print { url, skipExternalOpen, openedInHost } so the overlay can fall back to
// shell.openExternal(url) when the host wasn't foregrounded directly.
//
// `relay open --task <taskId> --host <host>` — same materialization, but seeded
// from a Relay task (active or completed): the session opens with the task's
// objective + state. Historical coordination records remain readable, while
// their remaining lifecycle stays owned by the Relay UI/backend. Prints the
// identical JSON contract.
async function cmdOpen(positional, flags) {
  const log = (m) => process.stderr.write(`[relay] ${m}\n`);
  const host = String(flags.host || flags.in || "claude").toLowerCase();
  const features = await accountProductFeatures({
    client: new RelayClient(),
    env: process.env,
    config: readConfig(),
    apiUrl: apiUrl(),
  });
  if (flags.cowork) throw new Error("Claude Cowork is temporarily unavailable in Relay");
  if (flags.task) {
    await requireTaskFeatures();
    const result = await openTask({ taskId: String(flags.task), host, log });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const id = positional[0] || flags.id;
  if (!id) throw new Error("Usage: relay open <id> --host claude|codex [--fresh] [--cwd <dir>] [--model <id>] [--effort <level>]  (or: relay open --task <taskId> --host claude|codex)");
  // --fresh: ignore any remembered native session for this row and forge a new
  // one (the pill's "Open in new chat" action).
  // --cwd: open in a specific directory, overriding repo routing. Also re-forges,
  // since neither host can relocate an existing session.
  // --model / --effort: the task runtime picker's choice; a model change also
  // re-forges, since neither host can retarget a live session.
  const result = await openRelay({
    id,
    host,
    log,
    allowTaskRows: features.requests,
    forceFresh: Boolean(flags.fresh),
    cwd: flags.cwd ? String(flags.cwd) : "",
    model: flags.model ? String(flags.model) : "",
    effort: flags.effort ? String(flags.effort) : "",
    activateDesktop: !flags["quiet-provider"],
    cowork: false,
  });
  console.log(JSON.stringify(result, null, 2));
}

/** Launch (or signal) the desktop Relay companion pill and verify it is visible. */
async function cmdPill(flags = {}) {
  migratePersistedContentFields({ log: (message) => console.log(`[relay] ${message}`) });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const overlayMain = path.resolve(here, "../overlay/main.cjs");
  // require("electron") returns the path to the electron binary when resolved under node.
  let electronPath;
  try {
    const require = createRequire(import.meta.url);
    electronPath = require("electron");
  } catch (error) {
    throw new Error(
      "Electron is not installed. Run `npm install` in packages/companion first. (" +
        (error && error.message ? error.message : error) +
        ")",
    );
  }
  if (typeof electronPath !== "string") {
    throw new Error("Could not resolve the Electron binary. Run `npm install` in packages/companion.");
  }
  const reopenNonce = `cli-${process.pid}-${randomUUID()}`;
  let spawnError = null;
  const child = spawn(
    electronPath,
    [overlayMain, "--relay-reopen", reopenNonce],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    },
  );
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const result = await waitForPillReady(reopenNonce);
  if (!result.ok) {
    const detail = spawnError ? ` ${spawnError.message || spawnError}` : "";
    throw new Error(
      `Relay was started but did not confirm that its pill became visible.${detail} Check ${pillStatusPath()} and ~/.relay/pill.log.`,
    );
  }
  // Say when the pill is only up because THIS command asked: with "Show Relay
  // automatically" off it goes away again as soon as it is closed, and a flat "it's
  // visible" would read as the setting having quietly stopped working.
  if (result.status?.pillHidden === true) {
    console.log(
      `Relay pill is visible. "Show Relay automatically" is off in Settings, so it will hide again once you close it — ` +
        `turn that on in Settings to keep it around. Reopen it any time from ${statusAreaReopenText()}.`,
    );
    return;
  }
  console.log(`Relay pill is visible. Reopen it from ${statusAreaReopenText()} after hiding it.`);
}

// Diagnose (and optionally heal) swallowed notifications: relays that are
// unread on disk but marked presented with no pending-attention entry can
// never notify again. --requeue-unseen strands them back into the queue;
// --restart-pill makes the running pill reload the healed prefs.
async function cmdDoctor(flags = {}) {
  const home = process.env.RELAY_HOME || process.env.RELAY_COMPANION_HOME || path.join(os.homedir(), ".relay-companion");
  const statePath = path.join(home, "state.json");
  const prefsPath = path.join(home, "overlay-prefs.json");
  const readJson = (p) => {
    try {
      return JSON.parse(fsSync.readFileSync(p, "utf8")) || {};
    } catch {
      return {};
    }
  };
  const state = readJson(statePath);
  const prefs = readJson(prefsPath);
  const presented = new Set(Array.isArray(prefs.presentedRelayIds) ? prefs.presentedRelayIds.map(String) : []);
  const pending = new Set(Object.keys(prefs.pendingAttention && typeof prefs.pendingAttention === "object" ? prefs.pendingAttention : {}));
  const unread = Object.entries(state.packets || {})
    .filter(([, row]) => row && row.direction === "inbound" && row.state !== "read")
    .map(([id]) => id);
  const swallowed = unread.filter((id) => presented.has(id) && !pending.has(id));
  console.log(`relay doctor @ ${new Date().toISOString()}`);
  console.log(`  staged unread: ${unread.length}`);
  console.log(`  confirmed-seen ledger: ${presented.size}`);
  console.log(`  pending attention queue: ${pending.size}`);
  console.log(`  SWALLOWED (unread, marked seen, not queued): ${swallowed.length}`);
  for (const id of swallowed.slice(0, 20)) console.log(`    - ${id}`);
  if (swallowed.length > 20) console.log(`    … and ${swallowed.length - 20} more`);
  // A pill hidden on purpose never presents, so its queue grows and never drains.
  // That is correct behaviour and looks exactly like a fault; say which it is.
  if (prefs.pillHidden === true || prefs.soundsMuted === true) {
    console.log(
      `  notifications: ${[
        prefs.pillHidden === true ? "automatic display off" : "",
        prefs.soundsMuted === true ? "sounds off" : "",
      ].filter(Boolean).join(", ")} (Settings) — a growing pending queue is expected here, not a fault`,
    );
  }

  // Update health. A machine whose updates cannot land used to be invisible: the
  // daemon retried silently forever and the only way to notice was diffing
  // package.json against npm by hand (field report, Shane 2026-08-11 — pinned on
  // 0.1.77 while 62 versions shipped). Say it here, where people already look.
  const updateState = readJson(path.join(home, "update-state.json"));
  const failure = updateState.failure && typeof updateState.failure === "object" ? updateState.failure : null;
  console.log(`  running version: ${companionVersion()}`);
  // Say which tree answered, and which tree the human actually typed. The
  // trampoline makes a frozen npm shim harmless, but also invisible — this is
  // the one place that difference must stay visible (the original field
  // report was exactly `relay --version` lying about the machine).
  if (trampolineArrival) {
    console.log(
      `  typed \`relay\` shim: ${trampolineArrival.shimVersion || "unknown version"} at ${trampolineArrival.shimRoot || "unknown path"} — handed this run to the canonical runtime`,
    );
  } else {
    console.log(`  running from: ${companionPackageRoot()}`);
  }
  console.log(`  update channel: ${updateChannel()}`);
  // The update record is written BEFORE each launch (auto-update.js launchPending),
  // so a single fresh record is an attempt in flight, not a diagnosis.
  const updateLogPath = path.join(os.homedir(), ".relay", "update.log");
  const failureInFlight = failure && Number(failure.count) === 1 && Date.now() - Number(failure.lastAt || 0) < 30 * 60 * 1000;
  // Canonical migration/recovery keep their own durable attempt records; doctor
  // used to read only `failure` and printed "update health: ok" for the entire day
  // Sven's machine burned 24GB in canonical install/activation loops.
  const updateStatePath = path.join(home, "update-state.json");
  const canonicalFailures = [];
  try {
    const migration = readMigrationFailure(updateStatePath);
    if (migration) canonicalFailures.push({ label: "runtime migration", ...migration });
  } catch {}
  try {
    const recovery = readRecoveryFailure(updateStatePath);
    if (recovery) canonicalFailures.push({ label: "runtime recovery", ...recovery });
  } catch {}
  if (failure && Number(failure.count) > 0 && !failureInFlight) {
    const since = failure.firstAt ? new Date(Number(failure.firstAt)).toISOString() : "unknown";
    console.log(`  UPDATES ARE FAILING: ${failure.count} consecutive attempt(s) to install ${failure.target} since ${since}`);
    console.log(`    cause: see ${updateLogPath}`);
    console.log("    if autostart is broken, run: relay repair-installation");
  } else if (failureInFlight) {
    console.log(`  update attempt in flight: ${failure.target} (launched ${new Date(Number(failure.lastAt)).toISOString()})`);
  } else if (!canonicalFailures.length) {
    console.log("  update health: ok (no failed update attempts recorded)");
  }
  for (const record of canonicalFailures) {
    const since = record.firstAt ? new Date(Number(record.firstAt)).toISOString() : "unknown";
    console.log(`  CANONICAL ${record.label.toUpperCase()} FAILING: ${record.count} attempt(s) at ${record.target} since ${since}`);
    console.log(`    cause: see ${updateLogPath}`);
  }
  // The canonical runtime itself: pointer state, disk footprint, live workers, and
  // the last thing the updater actually said. 37 stranded releases / 24GB burned
  // for 25 minutes while this command printed nothing at all.
  try {
    const layout = canonicalRuntimeLayout({});
    const pointer = readCanonicalRuntimeState({});
    if (pointer) {
      console.log(`  canonical runtime: ${pointer.version || pointer.candidate?.version || "unknown"} (${pointer.state || (pointer.active ? "active" : "inactive")})`);
    }
    let releaseNames = [];
    try {
      releaseNames = fsSync.readdirSync(layout.releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {}
    if (releaseNames.length) {
      let sizeLabel = "";
      if (process.platform !== "win32") {
        const du = spawnSync("du", ["-sk", layout.releasesDir], { encoding: "utf8", timeout: 30_000 });
        const kb = Number(String(du.stdout || "").trim().split(/\s+/)[0]);
        if (Number.isFinite(kb) && kb > 0) sizeLabel = `, ${(kb / 1024 / 1024).toFixed(1)} GB`;
      }
      console.log(`  release trees on disk: ${releaseNames.length}${sizeLabel}`);
      if (releaseNames.length > 3) {
        console.log("    MORE THAN EXPECTED — failed updates were stranding releases; this build prunes them on the next update attempt");
      }
    }
    if (process.platform === "darwin") {
      const workers = listUpdateWorkerJobs({});
      const legacy = workers.filter((job) => job.kind === "legacy");
      const fixed = workers.find((job) => job.kind === "fixed") || null;
      const live = workers.filter((job) => job.pid);
      if (workers.length) {
        console.log(`  update workers in launchd: ${live.length} running, ${legacy.length} legacy label(s)`);
        if (legacy.length) console.log("    every legacy label is removed automatically at startup");
        if (fixed && !fixed.pid) console.log("    fixed worker label is inactive and ready for the next admitted update");
      }
    }
    try {
      const tail = fsSync.readFileSync(updateLogPath, "utf8");
      const lines = tail.slice(-65_536).split("\n").filter((line) => /canonical update|canonical activation/.test(line));
      if (lines.length) console.log(`  last updater event: ${lines.at(-1).replace(/^\[relay-update\]\s*/, "")}`);
    } catch {}
  } catch {}
  if (process.platform === "win32") {
    const taskStatus = windowsAutostartTaskStatus();
    const missingTasks = taskStatus.missing;
    if (missingTasks.length) {
      console.log(`  MISSING Scheduled Task(s): ${missingTasks.join(", ")}`);
      console.log("    fix with: relay repair-installation");
    } else if (taskStatus.unavailable.length) {
      console.log("  Scheduled Tasks: unable to verify from this process");
      console.log("    run relay doctor in a normal terminal to check autostart");
    }
    // Without this, Start → "relay" finds nothing and the tray icon (parked in the
    // Windows 11 overflow chevron) is the only way back to the pill.
    if (windowsStartMenuShortcutMissing()) {
      console.log(`  MISSING Start Menu shortcut: ${windowsStartMenuShortcutPath()}`);
      console.log("    fix with: relay repair-installation");
    } else {
      console.log("  Start Menu shortcut: ok (Start → \"relay\" opens the pill)");
    }
  }
  if (flags["requeue-unseen"] && prefs.pillHidden === true) {
    console.log("Refusing --requeue-unseen while \"Show Relay automatically\" is off: nothing can present, so it would only grow the queue.");
    console.log("Turn that setting on in Relay's Settings tab first.");
  } else if (flags["requeue-unseen"] && swallowed.length) {
    prefs.presentedRelayIds = [...presented].filter((id) => !swallowed.includes(id));
    fsSync.writeFileSync(prefsPath, `${JSON.stringify(prefs, null, 2)}\n`);
    console.log(`Requeued ${swallowed.length} relay(s): removed from the confirmed-seen ledger.`);
    if (flags["restart-pill"] && process.platform === "darwin") {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/work.relay.companion.pill`], { stdio: "ignore" });
      console.log("Pill restarted; the queue will replay them sequentially when you are present.");
    } else {
      console.log("Restart the pill to pick this up: launchctl kickstart -k gui/$UID/work.relay.companion.pill");
    }
  }
}

// View or switch the release channel this machine follows. Stable tracks npm's
// `latest` dist-tag; dev and staging track their matching deliberately promoted
// tags.
// The daemon re-reads the channel on every poll, so a switch to dev takes
// effect within about a minute with no restart. Switching back to stable never
// downgrades: the machine keeps its current build until `latest` catches up at
// the next promotion (the updater only ever moves forward).
// Flip this machine between environments as ONE switch. Dev enables the dev
// API/channel; staging selects a production-like candidate with no developer
// capabilities; prod restores the production API/stable channel. All three
// share one account and inbox. Going back to prod does not downgrade the
// installed build (the updater only moves forward).
function cmdEnv(positional = [], flags = {}) {
  const target = String(positional[0] || "").trim().toLowerCase();
  const cfg = readConfig();
  const configuredApiUrl = cfg.apiUrl || DEFAULT_API_URL;
  const current = cfg.stagingApiUrl && configuredApiUrl === cfg.stagingApiUrl
    ? "staging"
    : configuredApiUrl === DEFAULT_API_URL
      ? "prod"
      : "dev";
  if (!target) {
    console.log(`[relay] env: ${current} (api: ${cfg.apiUrl || DEFAULT_API_URL}, update channel: ${updateChannel()})`);
    console.log("[relay] switch with: relay env dev | relay env staging | relay env prod");
    return;
  }
  if (target === "prod" || target === "stable") {
    writeConfig({ apiUrl: DEFAULT_API_URL, updateChannel: UPDATE_CHANNEL_STABLE });
    console.log(`[relay] env set to prod (api: ${DEFAULT_API_URL}, channel: stable)`);
    console.log("[relay] note: this does not downgrade the installed build; run `npm i -g relay-companion@latest` to match users exactly");
    return;
  }
  if (target !== "dev" && target !== "staging") {
    console.error(`[relay] unknown env "${target}" — use "dev", "staging", or "prod"`);
    process.exitCode = 1;
    return;
  }
  const isStaging = target === "staging";
  const savedApiUrl = isStaging ? cfg.stagingApiUrl : cfg.devApiUrl;
  const defaultApiUrl = isStaging ? DEFAULT_STAGING_API_URL : DEFAULT_DEV_API_URL;
  const selectedApiUrl = String(flags.api || savedApiUrl || defaultApiUrl || "").trim().replace(/\/+$/, "");
  if (!selectedApiUrl) {
    console.error(`[relay] the ${target} API URL is not known yet — pass it once: relay env ${target} --api https://<relay-api-${target}-url>`);
    process.exitCode = 1;
    return;
  }
  const selectedChannel = isStaging ? UPDATE_CHANNEL_STAGING : UPDATE_CHANNEL_DEV;
  const savedApiKey = isStaging ? "stagingApiUrl" : "devApiUrl";
  writeConfig({
    apiUrl: selectedApiUrl,
    [savedApiKey]: selectedApiUrl,
    updateChannel: selectedChannel,
  });
  const featureNote = isStaging ? "production feature set" : "developer feature set";
  console.log(`[relay] env set to ${target} (api: ${selectedApiUrl}, channel: ${selectedChannel}) — same account, ${featureNote}`);
}

function cmdUpdateChannel(positional = []) {
  const requested = String(positional[0] || "").trim().toLowerCase();
  if (!requested) {
    const source = process.env.RELAY_UPDATE_CHANNEL ? " (from RELAY_UPDATE_CHANNEL)" : "";
    console.log(`[relay] update channel: ${updateChannel()}${source}`);
    console.log(`[relay] switch with: relay update-channel ${UPDATE_CHANNEL_DEV} | relay update-channel ${UPDATE_CHANNEL_STAGING} | relay update-channel ${UPDATE_CHANNEL_STABLE}`);
    return;
  }
  if (![UPDATE_CHANNEL_DEV, UPDATE_CHANNEL_STAGING, UPDATE_CHANNEL_STABLE].includes(requested)) {
    console.error(`[relay] unknown channel "${requested}" — use "${UPDATE_CHANNEL_DEV}", "${UPDATE_CHANNEL_STAGING}", or "${UPDATE_CHANNEL_STABLE}"`);
    process.exitCode = 1;
    return;
  }
  // Release code and its server contract are one environment. Keeping these as
  // independent switches allowed a dev Companion to keep calling production,
  // where unreleased routes (notably Slack) correctly do not exist. Preserve
  // the old command as an alias, but make the resulting state coherent.
  if (requested === UPDATE_CHANNEL_DEV) return cmdEnv(["dev"]);
  if (requested === UPDATE_CHANNEL_STAGING) return cmdEnv(["staging"]);
  if (requested === UPDATE_CHANNEL_STABLE) return cmdEnv(["prod"]);
}

async function cmdE2eeHistoryImport(flags) {
  const client = new RelayClient();
  const prepared = await prepareE2eeHistoryImport(client);
  const { me, items, summary } = prepared;
  console.log(`[relay] encrypted history import plan for ${me.user.name} <${me.user.email}>`);
  console.log(`[relay] ${summary.messages} authored Relays: ${summary.direct} direct, ${summary.groups} group, ${summary.requests} Requests`);
  console.log(`[relay] ${summary.attachments} attachments; ${summary.edited} edited; ${summary.deleted} deleted`);
  console.log("[relay] destination ids and dates will be fresh; no legacy mapping is stored by Relay");
  if (!flags.execute) {
    console.log(`[relay] dry run only — execute with: relay e2ee-history-import --execute --confirm ${me.user.email}`);
    return;
  }
  const confirmation = String(flags.confirm || "").trim().toLowerCase();
  if (confirmation !== String(me.user.email || "").trim().toLowerCase()) {
    throw new Error(`Refusing to write history: --confirm must exactly match ${me.user.email}.`);
  }
  let maxItems = Number.POSITIVE_INFINITY;
  if (flags.max !== undefined) {
    maxItems = Number(flags.max);
    if (!(maxItems > 0) || !Number.isInteger(maxItems)) {
      throw new Error("--max must be a positive whole number when supplied.");
    }
  }
  const result = await importLegacyHistory(client, items, {
    accountId: me.user.id,
    maxItems,
    onProgress: ({ index, total }) => console.log(`[relay] imported ${index}/${total}`),
  });
  console.log(`[relay] import complete: ${result.imported} new, ${result.alreadyImported} already checkpointed, ${result.remaining} remaining`);
  console.log(`[relay] local retry checkpoint: ${result.checkpointPath}`);
}

// Set when this process is the trampoline's hop target (see main()).
let trampolineArrival = null;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  // The typed `relay` command is the npm global shim and would otherwise stay
  // at install-time version forever while the canonical runtime moves on
  // underneath it. Hand human-facing commands to the active release; the
  // services and updater-internal commands are exempt (see cli-trampoline.js).
  const hop = resolveCliTrampoline({ command, argv: rest });
  if (hop) {
    process.exit(runCliTrampoline(hop));
  }
  // If we ARE the hop target, remember where the human's typed `relay` lives
  // (doctor reports it), then strip the markers: they are a per-invocation
  // loop guard, and a long-lived child (daemon, pill, an agent session) that
  // inherited them would silently never trampoline again.
  if (process.env[TRAMPOLINE_ENV]) {
    trampolineArrival = {
      shimVersion: process.env[TRAMPOLINE_SHIM_VERSION_ENV] || null,
      shimRoot: process.env[TRAMPOLINE_SHIM_ROOT_ENV] || null,
    };
    delete process.env[TRAMPOLINE_ENV];
    delete process.env[TRAMPOLINE_SHIM_VERSION_ENV];
    delete process.env[TRAMPOLINE_SHIM_ROOT_ENV];
  }
  const { flags, positional } = parseFlags(rest);
  rejectRemovedCapabilityFlags(command, flags);
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(companionVersion());
      return;
    case "setup":
      return cmdSetup(flags);
    case "pair":
      return cmdPair(flags);
    case "install":
      return cmdInstall(flags);
    case "repair-installation":
    case "repair-desktop":
      return cmdRepairDesktop(flags);
    case "repair-runtime":
      return cmdRepairRuntime(flags);
    case "uninstall":
      return cmdUninstall(flags);
    case "whoami":
      return cmdWhoami();
    case "tasks":
      return cmdTasksOnce(flags);
    case "open":
      return cmdOpen(positional, flags);
    case "claude-hook":
      // Internal: Claude Code hook runtime (installed by `relay install` into
      // ~/.claude/settings.json). Reads the hook event JSON on stdin and must
      // never fail the hosting Claude session.
      return runClaudeHook();
    case "codex-hook":
      // Internal: Codex hook runtime. It offers private Relay context without
      // changing human read state or starting a turn.
      return runCodexHook();
    case "daemon":
      return runTaskDaemon({ intervalMs: Number(flags.interval) || 4000 });
    case "pill":
      return cmdPill(flags);
    case "mcp":
      return runMcpServer();
    case "wake-on":
      // Let Claude Desktop sessions be woken by an incoming relay (see
      // src/desktop-wake.js). Verified before it is trusted; reversible.
      return import("../src/desktop-wake.js").then(({ syncDesktopWake }) => {
        for (const r of syncDesktopWake({ log: (m) => console.log(`[relay] ${m}`) })) {
          console.log(`[relay] CLI ${r.version}: ${r.ok ? r.reason : `FAILED (${r.reason})`}`);
        }
      });
    case "wake-off":
      return import("../src/desktop-wake.js").then(({ uninstallAllDesktopWake }) => {
        for (const r of uninstallAllDesktopWake({ log: (m) => console.log(`[relay] ${m}`) })) {
          console.log(`[relay] CLI ${r.version}: ${r.reason}`);
        }
      });
    case "wake-status":
      return import("../src/desktop-wake.js").then(({ wakeStatus }) => {
        for (const r of wakeStatus()) console.log(`[relay] CLI ${r.version}: ${r.installed ? "wake enabled" : "not enabled"}`);
      });
    case "channel":
      // EXPERIMENTAL: Claude Code channel server (see src/channel-server.js).
      // Register in .mcp.json and start the session with
      //   claude --dangerously-load-development-channels server:relay
      return import("../src/channel-server.js").then(({ runChannelServer }) => runChannelServer());
    case "update":
    case "self-update":
      return runUpdateOnce().then(() => {});
    case "update-channel":
      return cmdUpdateChannel(positional);
    case "env":
      return cmdEnv(positional, flags);
    case "e2ee-history-import":
      return cmdE2eeHistoryImport(flags);
    case "doctor":
      return cmdDoctor(flags);
    default:
      console.log(
        [
          "Relay companion",
          "",
          "Usage:",
          "  relay setup                                           Install and open Relay; sign in from the Relay pill",
          "  relay setup --restart                                 Replace a stuck or expired one-time setup approval",
          "  relay version                                         Print the installed Relay companion version",
          "  relay setup --code CODE --open-relay TOKEN --host codex|claude",
          "  relay setup --code CODE                               Legacy migration only: pair by code, then install",
          "  relay install                                        Add Relay to your agents",
          "  relay uninstall                                       Remove Relay from your agents and stop the daemon (keeps the pairing)",
          "  relay uninstall --purge                               Also revoke this device and delete all local Relay state, as if never installed",
          "  relay repair-installation [--no-restart]             Non-destructively repair Relay.app and services; preserves account, encryption, messages, outbox, and preferences",
          "  relay repair-desktop [--no-restart]                  Compatibility alias for repair-installation",
          "  relay repair-runtime [--no-restart]                  Internal: refresh existing Relay registrations and runtime services",
          "  relay pair [--api URL] [--web URL] [--code CODE] [--no-restart] Pair this machine only (no agent install); restarts running Relay services onto the new account",
          "  relay tasks                                           Pull and process the developer Request runtime once",
          "  relay open <id> --host claude|codex [--fresh]        Materialize a staged Relay row into a native agent session (--fresh forces a new one)",
          "  relay open --task <taskId> --host claude|codex        Materialize a developer Request into a native agent session",
          "  relay daemon [--interval MS]                          Run Relay delivery; developer accounts also receive Requests",
          "  relay pill                                            Launch the Relay pill",
          "  relay mcp                                             Run tools allowed by the signed-in account",
          "  relay update                                          Update Relay",
          "  relay update-channel [dev|staging|stable]             Show or switch the release channel",
          "  relay <command> --no-trampoline                       Run the invoked install itself instead of handing off to the canonical runtime",
          "  relay <command> --claim                               Let this tree take over the machine's autostart even when it is not the canonical runtime",
          "  relay env [dev|staging|prod] [--api URL]              Switch API + release channel together",
          "  relay e2ee-history-import                             Dry-run the signed-in account's one-off encrypted history copy",
          "  relay e2ee-history-import --execute --confirm EMAIL   Encrypt and copy that account's authored legacy history",
          "  relay whoami                                          Show the paired account",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
