import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RelayClient } from "./client.js";
import {
  ensureRuntimeSession,
  freshMessages,
  hasActiveTurns,
  markMessagesProcessed,
  orderTaskMessages,
  readTaskLedger,
  writeTaskLedger,
} from "./runtime.js";
import {
  buildHumanNotifications,
  defaultStageRelayCompanionItem,
  freshNotifications,
  markNotificationsProcessed,
  markCompanionItemsReadThrough,
  removeSuppressedCompanionItems,
  stagePlainRelayItem as defaultStagePlainRelayItem,
  updateStagedRelayAttachments,
} from "./notifications.js";
import { companionPackageRoot, createAutoUpdater, currentCompanionVersion } from "./auto-update.js";
import { startLogRotation } from "./log-rotate.js";
import { startDesktopStartupMigration } from "./desktop-migration.js";
import { ensureWindowsAutostartTasks, repairAgentMcpRegistrations } from "./install.js";
import { apiUrl, readConfig } from "./config.js";
import { activeSessionOperationCount, runSessionDirectoryOnce } from "./session-controller.js";
import { createE2eeClaudeRuntimeController } from "./e2ee-claude-runtime.js";
import { productFeatures } from "./product-features.js";
import { migratePersistedContentFields } from "./content-field-migration.js";
import agentRelayContext from "./agent-relay-context.cjs";
import { storeDir } from "./host-paths.js";
import { readCanonicalRuntime } from "./canonical-runtime.js";
import { autostartWillReplace } from "./autostart-registration.js";
import { startRelayCodexProjectRepairLoop } from "./codex-project-repair.js";

const { recordAgentRelayIndex } = agentRelayContext;

function idempotencyKey(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function messagesForSession(session, messages) {
  // A human_message is scoped to sender + recipients, so it also lands in the
  // sender's own agent inbox — don't echo their own words back into their run.
  return messages.filter(
    (message) =>
      message.taskId === session.taskId &&
      !(message.kind === "human_message" && message.senderUserId && message.senderUserId === session.ownerUserId),
  );
}

function markProcessedOnce(ledger, processed, messages) {
  const unseen = [];
  for (const message of messages) {
    if (processed.has(message.id)) continue;
    processed.add(message.id);
    unseen.push(message);
  }
  if (unseen.length) markMessagesProcessed(ledger, unseen);
  return unseen;
}

function freshTaskEvents(ledger, events) {
  ledger.taskEvents ||= {};
  return events.filter((event) => {
    const seen = ledger.taskEvents[event.id];
    return !seen || seen.sequence !== event.sequence;
  });
}

function markTaskEventsProcessed(ledger, events) {
  ledger.taskEvents ||= {};
  const processedAt = new Date().toISOString();
  for (const event of events) {
    ledger.taskEvents[event.id] = {
      taskId: event.taskId,
      sequence: event.sequence,
      type: event.type,
      processedAt,
    };
  }
}

function freshPlainRelays(ledger, items) {
  ledger.plainRelays ||= {};
  return items.filter((item) => {
    const seen = ledger.plainRelays[item.relayId];
    return (
      !seen ||
      seen.updatedAt !== item.updatedAt ||
      seen.state !== item.state ||
      (seen.restoredAt || "") !== (item.restoredAt || "")
    );
  });
}

function markPlainRelaysProcessed(ledger, items) {
  ledger.plainRelays ||= {};
  const processedAt = new Date().toISOString();
  for (const item of items) {
    ledger.plainRelays[item.relayId] = {
      state: item.state,
      updatedAt: item.updatedAt || item.createdAt || "",
      restoredAt: item.restoredAt || "",
      processedAt,
    };
  }
}

// Terminal tasks never grow new events, so polling them is pure N+1 overhead —
// on long-lived accounts this was most of the daemon's request volume every cycle.
const LIVE_TASK_STATES = new Set(["draft", "resolving", "inviting", "active", "completing"]);
async function pollVisibleTaskEvents({ client, ledger, tasks, log }) {
  if (typeof client.taskEvents !== "function") return [];
  const visibleEvents = [];
  const liveTasks = (tasks.tasks || []).filter((task) => LIVE_TASK_STATES.has(task.state));
  for (const task of liveTasks) {
    try {
      const result = await client.taskEvents(task.id);
      // The daemon posts its own daemon.heartbeat events; observing + logging +
      // ledgering them back is pure self-noise. Ignore them entirely.
      const relevant = (result.events || []).filter((event) => event.type !== "daemon.heartbeat");
      const fresh = freshTaskEvents(ledger, relevant);
      if (fresh.length) {
        markTaskEventsProcessed(ledger, fresh);
        for (const event of fresh) {
          log(`observed task event ${event.id} (${event.type}) for task ${task.id}`);
        }
        visibleEvents.push(...fresh);
      }
    } catch (err) {
      log(`task event polling failed for ${task.id}: ${err.message}`);
    }
  }
  return visibleEvents;
}

// Content signature for the ledger write-skip below. updatedAt is stamped fresh
// on every write by design, so it is excluded — with it included no two polls
// could ever match and the skip would be dead code.
export function ledgerContentSignature(ledger) {
  return JSON.stringify({ ...ledger, updatedAt: null });
}

// The ledger's dedupe maps grow forever (processedMessages, taskEvents, plainRelays,
// notifications, sessions). Left unbounded, the daemon JSON.parse+stringify+fsyncs a
// multi-megabyte file every 4s poll. Keep the newest N entries by processedAt so the
// dedupe windows stay correct for anything the API still returns, while capping size.
const LEDGER_MAP_CAP = 500;
function pruneLedgerMap(map, cap = LEDGER_MAP_CAP) {
  if (!map || typeof map !== "object") return;
  const entries = Object.entries(map);
  if (entries.length <= cap) return;
  entries.sort((a, b) => {
    const ta = Date.parse(a[1]?.processedAt || a[1]?.lastDaemonEventAt || 0) || 0;
    const tb = Date.parse(b[1]?.processedAt || b[1]?.lastDaemonEventAt || 0) || 0;
    return tb - ta; // newest first
  });
  for (const [key] of entries.slice(cap)) delete map[key];
}
function pruneLedger(ledger) {
  pruneLedgerMap(ledger.processedMessages);
  pruneLedgerMap(ledger.taskEvents);
  pruneLedgerMap(ledger.plainRelays);
  pruneLedgerMap(ledger.notifications);
}

/**
 * How many packets to pull per batch request. The server caps this at 100; ask
 * for the same so a full backlog drains in ceil(N/100) round trips.
 */
const PACKET_BATCH_SIZE = 100;

/**
 * Fetch packets for `items` in as few round trips as the server allows, falling
 * back to the one-at-a-time route against a server too old to know the batch
 * endpoint (a companion always outruns the API deploy on someone's machine).
 * Returns a Map of relayId -> {packet, attachmentUrls}; ids the server withheld
 * are simply absent, and the caller skips them.
 */
async function fetchPacketsForItems({ client, items, log }) {
  const byId = new Map();
  if (!items.length) return byId;
  if (typeof client.fetchRelayPackets === "function") {
    let batched = true;
    for (let i = 0; i < items.length; i += PACKET_BATCH_SIZE) {
      const slice = items.slice(i, i + PACKET_BATCH_SIZE);
      try {
        const res = await client.fetchRelayPackets(slice.map((item) => item.relayId));
        for (const [id, value] of Object.entries((res && res.packets) || {})) byId.set(id, value);
      } catch (err) {
        // 404 means this API predates the batch route; anything else is a real
        // failure but the per-id path is still worth trying before giving up.
        log(`batch packet fetch failed (${err.message}); falling back to per-relay fetch`);
        batched = false;
        break;
      }
    }
    if (batched) return byId;
    byId.clear();
  }
  for (const item of items) {
    try {
      byId.set(item.relayId, await client.fetchRelay(item.relayId));
    } catch (err) {
      log(`ordinary Relay fetch failed for ${item.relayId}: ${err.message}`);
    }
  }
  return byId;
}

/**
 * Download a freshly staged relay's attachments NOW, while the packet's signed
 * URLs are seconds old, and patch the acquired localPaths onto the staged row.
 * Ingest is the one moment the URLs are guaranteed live — a lazy download on a
 * click days later starts from an expired signature. Failures only log: the
 * open path re-runs the same idempotent download (with a URL refresh) anyway.
 */
async function prefetchStagedRelayAttachments({ item, packet, attachmentUrls, log }) {
  const attachments = Array.isArray(packet?.attachments) ? packet.attachments : [];
  if (!attachments.length) return;
  try {
    const { materializeAttachmentFiles } = await import("./materializer.js");
    const materialized = await materializeAttachmentFiles(
      { id: item.relayId, attachments, attachmentUrls: attachmentUrls || {} },
      { log },
    );
    const withLocal = (materialized.attachments || []).filter((a) => a && a.localPath).length;
    if (withLocal && updateStagedRelayAttachments(item.relayId, materialized.attachments)) {
      log(`prefetched ${withLocal}/${attachments.length} attachment(s) for ${item.relayId}`);
    }
  } catch (err) {
    log(`attachment prefetch failed for ${item.relayId}: ${err && err.message ? err.message : err}`);
  }
}

async function pollPlainInbox({
  client,
  ledger,
  stagePlainRelay,
  log,
  persistLedger = () => {},
  agentContextHome = storeDir(),
  agentContextScope = client?.token || "",
}) {
  if (typeof client.inbox !== "function" || typeof client.fetchRelay !== "function") return [];
  try {
    // Summary projection: identity and change-detection fields only. The bodies
    // arrive with the packets below, for the few relays that are actually new.
    const inbox = await client.inbox({ summary: true });
    // Reconcile cross-surface changes for ordinary accounts, which never call
    // the task-scoped endpoints that used to be the only inboxState source. A relay
    // deleted on the web (or read-all'd from another device) must leave this pill
    // too, not linger as a permanent unread ghost.
    if (inbox.inboxState) {
      const removed = removeSuppressedCompanionItems(inbox.inboxState.suppressedItemIds || []);
      if (removed) log(`removed ${removed} Relay item(s) moved to Recently Deleted elsewhere`);
      const markedRead = markCompanionItemsReadThrough(inbox.inboxState.readAllAt);
      if (markedRead) log(`marked ${markedRead} Relay item(s) read from another surface`);
    }
    const fresh = freshPlainRelays(ledger, inbox.items || []);
    const packets = await fetchPacketsForItems({ client, items: fresh, log });
    const staged = [];
    for (const item of fresh) {
      const relay = packets.get(item.relayId);
      // Withheld or failed: leave it out of the ledger so the next poll retries.
      if (!relay || !relay.packet) continue;
      try {
        const seen = ledger.plainRelays[item.relayId];
        stagePlainRelay(
          { item, packet: relay.packet, attachmentUrls: relay.attachmentUrls || {} },
          { forceUnread: Boolean(item.restoredAt && seen?.restoredAt !== item.restoredAt) },
        );
        staged.push(item);
        log(`staged ordinary Relay from ${item.sender?.name || "someone"}: ${item.title || item.relayId}`);
        // Commit progress as it happens. The ledger used to be written only
        // after the whole pass, so a restart mid-pass (auto-update restarts are
        // routine) threw away every relay staged so far and the next pass began
        // again from zero — the re-stage storm that made new relays wait behind
        // a backlog they had already been through.
        markPlainRelaysProcessed(ledger, [item]);
        persistLedger();
      } catch (err) {
        log(`ordinary Relay staging failed for ${item.relayId}: ${err.message}`);
      }
    }
    // Reuse the summary response already fetched for human delivery. The hook
    // index contains metadata plus, for untitled typed texts, the text itself
    // (an untitled relay has no other content); it is account-scoped, and its
    // writer skips byte-identical snapshots, so this adds no network/DB poll
    // and no four-second idle disk write.
    try {
      recordAgentRelayIndex(agentContextHome, agentContextScope, inbox);
    } catch (err) {
      log(`recent Relay context persistence failed: ${err.message}`);
    }
    // Prefetch attachments only after every stage + ledger commit has landed,
    // so a slow download can never delay the relays queued behind it.
    for (const item of staged) {
      const relay = packets.get(item.relayId);
      if (!relay || !relay.packet) continue;
      await prefetchStagedRelayAttachments({
        item,
        packet: relay.packet,
        attachmentUrls: relay.attachmentUrls || {},
        log,
      });
    }
    staged.inboxOk = true;
    return staged;
  } catch (err) {
    log(`ordinary Relay inbox polling failed: ${err.message}`);
    const failed = [];
    // Carried on the array so both callers keep their existing shape. A wedged
    // client (see SELF_HEAL_FAILURE_STREAK) can only be recognised by whether
    // the inbox call itself succeeded, not by how much it staged.
    failed.inboxOk = false;
    return failed;
  }
}

async function pollHumanNotifications({
  client,
  ledger,
  stageCompanionItem,
  stagePlainRelay,
  log,
  persistLedger = () => {},
}) {
  const ordinaryRelays = await pollPlainInbox({ client, ledger, stagePlainRelay, log, persistLedger });
  try {
    const [me, tasks, relays, connectors] = await Promise.all([
      client.me(),
      client.listTasks(),
      client.listRelays(),
      client.listConnectors(),
    ]);
    const events = await pollVisibleTaskEvents({ client, ledger, tasks, log });
    const removed = removeSuppressedCompanionItems(relays.inboxState?.suppressedItemIds || []);
    if (removed) log(`removed ${removed} Relay item(s) moved to Recently Deleted elsewhere`);
    const markedRead = markCompanionItemsReadThrough(relays.inboxState?.readAllAt);
    if (markedRead) log(`marked ${markedRead} Relay item(s) read from another surface`);
    const notifications = buildHumanNotifications({
      user: me.user,
      tasks: tasks.tasks || [],
      relays: relays.relays || [],
      connectors: connectors.connectors || [],
      inboxState: relays.inboxState || {},
    });
    const fresh = freshNotifications(ledger, notifications);
    const staged = [];
    for (const notification of fresh) {
      try {
        stageCompanionItem(notification);
        staged.push(notification);
        log(`staged Relay companion item ${notification.kind}: ${notification.title}`);
      } catch (err) {
        log(`Relay companion staging failed for ${notification.kind}: ${err.message}`);
      }
    }
    if (staged.length) markNotificationsProcessed(ledger, staged);
    return { notifications: staged, ordinaryRelays, events };
  } catch (err) {
    log(`Relay companion attention polling failed: ${err.message}`);
    return { notifications: [], ordinaryRelays, events: [] };
  }
}

/**
 * Poll only the ordinary Relay inbox. This is the complete receive loop used by
 * ordinary accounts: it deliberately has no task, task-session,
 * connector, or task-notification client calls.
 */
export async function pollOrdinaryRelayOnce({
  client = new RelayClient(),
  log = () => {},
  stagePlainRelay = defaultStagePlainRelayItem,
  agentContextHome = storeDir(),
  agentContextScope = client?.token || "",
} = {}) {
  const ledger = readTaskLedger();
  // Write-skip (2026-08-05 always-on-cost audit): an idle account rewrote an
  // identical ~150KB ledger every 4s poll, forever. Only touch the disk when a
  // poll actually changed the dedupe state.
  const ledgerBaseline = ledgerContentSignature(ledger);
  // Staging commits each relay as it lands (see pollPlainInbox). An idle poll
  // stages nothing and so still writes nothing.
  const persistLedger = () => {
    pruneLedger(ledger);
    writeTaskLedger(ledger);
  };
  const ordinaryRelays = await pollPlainInbox({
    client,
    ledger,
    stagePlainRelay,
    log,
    persistLedger,
    agentContextHome,
    agentContextScope,
  });
  pruneLedger(ledger);
  if (ledgerContentSignature(ledger) !== ledgerBaseline) writeTaskLedger(ledger);
  return { ordinaryRelays, inboxOk: ordinaryRelays.inboxOk !== false };
}

export async function pollTaskRuntimeOnce({
  client = new RelayClient(),
  log = () => {},
  stageCompanionItem = defaultStageRelayCompanionItem,
  stagePlainRelay = defaultStagePlainRelayItem,
  adapters,
} = {}) {
  const ledger = readTaskLedger();
  const ledgerBaseline = ledgerContentSignature(ledger); // see pollOrdinaryRelayOnce
  let inbox = { messages: [], sessions: [] };
  try {
    inbox = await client.agentInbox();
  } catch (err) {
    log(`task agent inbox polling failed: ${err.message}`);
  }
  const fresh = freshMessages(ledger, inbox.messages || []);
  const processedMessageIds = new Set();
  const processedMessages = [];
  const touched = [];

  for (const session of inbox.sessions || []) {
    let claimedSession = session;
    try {
      const claimState = session.state === "queued" || session.state === "idle" || session.state === "stale"
        ? "starting"
        : session.state;
      const claimed = await client.heartbeatSession(session.id, {
        state: claimState,
        sessionRef: session.sessionRef || {},
        lastError: null,
        idempotencyKey: idempotencyKey("claim"),
      });
      claimedSession = claimed.session || session;
    } catch (err) {
      if (err.status === 409 || err.body?.error === "version_conflict") {
        log(`session ${session.id} is leased by another companion; skipping`);
        continue;
      }
      log(`claim failed for ${session.id}: ${err.message}`);
      continue;
    }
    const sessionMessages = orderTaskMessages(messagesForSession(claimedSession, fresh));
    let runtime;
    try {
      runtime = await ensureRuntimeSession({ session: claimedSession, messages: sessionMessages, ledger, adapters });
    } catch (err) {
      log(`runtime failed for ${session.id}: ${err.message}`);
      continue;
    }
    // Only mark messages processed once they were actually delivered into a live
    // host turn. A degraded fallback (no host installed → state "stale", or a
    // fallback sessionRef) did NOT deliver them; leaving them fresh means they
    // redeliver the moment the host is available, instead of the agent waiting
    // forever for an answer the human already gave.
    const delivered =
      runtime.state !== "stale" && runtime.sessionRef?.mode !== "degraded_fallback";
    if (delivered) {
      processedMessages.push(...markProcessedOnce(ledger, processedMessageIds, sessionMessages));
    } else if (sessionMessages.length) {
      log(`host unavailable for ${session.id}; ${sessionMessages.length} message(s) left for redelivery`);
    }
    touched.push(runtime);
    try {
      await client.heartbeatSession(session.id, {
        state: runtime.state,
        sessionRef: runtime.sessionRef,
        lastError: runtime.state === "stale" ? runtime.sessionRef?.reason || "host_unavailable" : null,
        idempotencyKey: idempotencyKey("heartbeat"),
      });
      // Only emit a task_events row on a real state change (or every ~5 min as a
      // liveness ping). Posting one per session per 4s poll flooded the DB, the
      // ledger, and the unrotated daemon log, and crowded real events out of the
      // API's 200-row window. The heartbeatSession call above still renews the
      // lease every poll — a lease renewal needs no event row.
      ledger.sessions[session.id] ||= {};
      const bookkeeping = ledger.sessions[session.id];
      const nowMs = Date.now();
      const stateChanged = bookkeeping.lastPostedState !== runtime.state;
      const stale = !bookkeeping.lastDaemonEventAt || nowMs - bookkeeping.lastDaemonEventAt > 5 * 60 * 1000;
      if (stateChanged || stale) {
        await client.postDaemonEvent(session.taskId, {
          sessionId: session.id,
          type: "daemon.heartbeat",
          body: `Relay companion heartbeat for ${runtime.host}.`,
          payload: { runtimeState: runtime.state, sessionRef: runtime.sessionRef },
          idempotencyKey: idempotencyKey("daemon_event"),
        });
        bookkeeping.lastPostedState = runtime.state;
        bookkeeping.lastDaemonEventAt = nowMs;
      }
    } catch (err) {
      log(`heartbeat failed for ${session.id}: ${err.message}`);
    }
  }

  if (processedMessages.length) {
    for (const message of processedMessages) {
      log(`received task message ${message.id} (${message.kind}) for task ${message.taskId}`);
    }
  }

  const humanPolling = await pollHumanNotifications({
    client,
    ledger,
    stageCompanionItem,
    stagePlainRelay,
    log,
    persistLedger: () => {
      pruneLedger(ledger);
      writeTaskLedger(ledger);
    },
  });
  pruneLedger(ledger);
  if (ledgerContentSignature(ledger) !== ledgerBaseline) writeTaskLedger(ledger);
  return {
    sessions: touched,
    messages: processedMessages,
    notifications: humanPolling.notifications,
    ordinaryRelays: humanPolling.ordinaryRelays,
    events: humanPolling.events,
    inboxOk: humanPolling.ordinaryRelays.inboxOk !== false,
  };
}

// Run updater maintenance independently from API authentication and task polling.
// This matters at login/offline recovery: client.me() or a Task fetch can be slow or
// repeatedly fail, but a newly published companion may contain the very fix needed to
// recover. createAutoUpdater handles the real one-minute registry rate limit; this
// lightweight loop only lets pending/busy/retry state react within a few seconds.
/**
 * Once an update has been launched, THIS process is the one being replaced and must
 * not outlive its replacement. On Windows the updater cannot reliably kill it: the
 * script restarts services with `schtasks /End`, which only ends processes in the
 * task's own tree, and a daemon started through the WMI escape hatch is not in that
 * tree. Field report (Shane, 2026-08-17): the old daemon survived as an orphan
 * holding daemon.log open, so the /Run'd replacement's `>> daemon.log` redirect
 * failed and its cmd wrapper exited 1 before node started (update.log still said
 * "daemon restarted via task"); the orphan then re-fired the same update from its
 * stale in-memory version and two updaters raced the tree into an unbootable state.
 *
 * Exit as soon as the replacement is observably committed. A hard ceiling ends
 * the observation window but MUST NOT exit without that evidence: Windows logon
 * tasks are not KeepAlive supervisors, so an install failure followed by a blind
 * exit leaves the machine with a pill but no polling daemon until the next login.
 * Returns the timer so callers/tests can cancel it; `exitImpl` is injectable.
 */
export const SELF_UPDATE_EXIT_POLL_MS = 2000;
export const SELF_UPDATE_EXIT_CEILING_MS = 5 * 60 * 1000;
export const CANONICAL_UPDATE_EXIT_CEILING_MS = 22 * 60 * 1000;

export function scheduleSelfUpdateExit({
  runningVersion,
  packageRoot,
  log = () => {},
  exitImpl = (code) => process.exit(code),
  readVersion = defaultReadPackageVersion,
  pollMs = SELF_UPDATE_EXIT_POLL_MS,
  ceilingMs = SELF_UPDATE_EXIT_CEILING_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = () => Date.now(),
  replacementReady = null,
  onCeiling = null,
} = {}) {
  const startedAt = now();
  let done = false;
  const finish = (reason) => {
    if (done) return;
    done = true;
    clearIntervalImpl(timer);
    log(`self-update: ${reason}; exiting so the replacement daemon can start`);
    exitImpl(0);
  };
  const expire = () => {
    if (done) return;
    done = true;
    clearIntervalImpl(timer);
    log(
      `self-update: updater grace period of ${Math.round(ceilingMs / 1000)}s elapsed ` +
        "without a verified replacement; keeping the current daemon alive and resuming checks",
    );
    try { onCeiling?.(); } catch (error) {
      log(`self-update: could not resume checks after updater timeout: ${error?.message || error}`);
    }
  };
  const timer = setIntervalImpl(() => {
    if (typeof replacementReady === "function" && replacementReady()) {
      finish("canonical runtime pointer selected a replacement tree");
      return;
    }
    const onDisk = readVersion(packageRoot);
    if (onDisk && runningVersion && onDisk !== runningVersion) {
      finish(`new tree ${onDisk} is on disk (was running ${runningVersion})`);
    } else if (now() - startedAt >= ceilingMs) {
      expire();
    }
  }, pollMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return { timer, cancel: () => { done = true; clearIntervalImpl(timer); } };
}

function defaultReadPackageVersion(packageRoot) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

export function startAutoUpdateLoop({
  autoUpdater,
  intervalMs = 5000,
  log = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onUpdateLaunched = null,
} = {}) {
  if (!autoUpdater || typeof autoUpdater.tick !== "function") throw new Error("autoUpdater.tick is required");
  let exitScheduled = false;
  let replacing = false;
  const resumeChecks = () => {
    replacing = false;
    exitScheduled = false;
  };
  const run = () =>
    replacing
      ? Promise.resolve({ status: "replacement-pending" })
      : Promise.resolve()
      .then(() => autoUpdater.tick())
      .then((update) => {
        if (["updating", "stale-process", "migrating-runtime", "recovering-runtime", "rescuing-runtime", "repairing-runtime"].includes(update.status)) {
          // The external updater owns the attempt from this point. Quiesce THIS
          // process immediately so it cannot re-fire from stale version/channel
          // state while scheduleSelfUpdateExit gives the installer time to finish.
          replacing = true;
          if (update.status === "updating") {
            log(`self-update launched (${update.current} -> ${update.latest}); restarting shortly`);
          } else if (update.status === "migrating-runtime") {
            log(`canonical runtime migration launched for ${update.current}`);
          } else if (update.status === "recovering-runtime") {
            log(`canonical runtime recovery launched for ${update.current}`);
          } else if (update.status === "rescuing-runtime") {
            log(`canonical runtime rescue launched for ${update.current}`);
          } else if (update.status === "repairing-runtime") {
            log(`canonical runtime repair launched for ${update.current}`);
          } else {
            log(`self-update: this daemon runs ${update.current} but disk is ${update.onDisk}; stepping aside`);
          }
          // Arm the self-exit exactly once per launch; a re-tick while the updater is
          // still installing must not re-arm it (or worse, exit early on the ceiling).
          if (!exitScheduled && typeof onUpdateLaunched === "function") {
            exitScheduled = true;
            try {
              onUpdateLaunched(update, { resumeChecks });
            } catch (err) {
              resumeChecks();
              log(`self-update: could not arm self-exit: ${err && err.message ? err.message : err}`);
            }
          }
        } else if (update.status === "launch-failed") {
          log(`self-update launch failed for ${update.current} -> ${update.latest}`);
        }
        return update;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[relay] auto-update check error: ${err && err.message ? err.message : err}`);
        return { status: "loop-error", error: err };
      });
  void run(); // check immediately, including while startup authentication is offline
  const timer = setIntervalImpl(() => void run(), intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return { run, timer, stop: () => clearIntervalImpl(timer) };
}

/**
 * Consecutive failed inbox polls before the receiver rebuilds itself. Each cycle
 * is the poll interval plus up to the client's 15s request timeout, so 60 is
 * roughly 5-20 minutes of continuous failure — long enough that ordinary
 * sleep/suspend and transient network loss never trip it.
 */
export const SELF_HEAL_FAILURE_STREAK = 60;

// The session controller — publish this machine's session directory, then
// claim and execute remote session operations — is the substrate under
// relay_ai_sessions / relay_ai_session. On the product row it shares with
// Tasks (prod v1: send · receive · open — Sven, 2026-08-17) it is off
// for ordinary accounts: nothing is uploaded, nothing is listened for, the
// receiver loop is all that runs. A tick never throws either way: session
// directory failure must never stop ordinary Relay delivery or a developer's
// Task runtime while a new API release rolls through.
export async function sessionControllerTick({ client, log, features, run = runSessionDirectoryOnce } = {}) {
  if (features && features.aiSessions === false) return { ran: false };
  try {
    await run({ client, log });
    return { ran: true };
  } catch (err) {
    log(`session directory unavailable: ${err.message}`);
    return { ran: true, error: err };
  }
}

// The server-issued account role controls whether this loop asks for Task
// work. Ordinary delivery remains active for every account.
export async function daemonDeliveryTick({
  client,
  log = () => {},
  features,
  taskPoll = pollTaskRuntimeOnce,
  ordinaryPoll = pollOrdinaryRelayOnce,
} = {}) {
  if (features && features.requests === false) {
    const result = await ordinaryPoll({ client, log });
    return {
      ordinaryOnly: true,
      sessions: [],
      messages: [],
      notifications: [],
      events: [],
      ...result,
    };
  }
  return { ordinaryOnly: false, ...(await taskPoll({ client, log })) };
}

function daemonProductFeatures(log, user) {
  const features = productFeatures({ env: process.env, config: readConfig(), apiUrl: apiUrl(), user });
  if (!features.aiSessions) log("developer session features off for this account: no session directory upload, no remote session operations");
  if (!features.requests) log("Task runtime off for this account: ordinary Relay delivery only");
  return features;
}

const ACCOUNT_FEATURE_REFRESH_MS = 5 * 60 * 1000;

async function refreshDaemonProductFeatures(client, current, log) {
  try {
    const me = await client.me();
    return daemonProductFeatures(log, me.user);
  } catch (error) {
    log(`developer profile refresh failed: ${error?.message || error}`);
    return current;
  }
}

// Boot resilience: the daemon starts at login, often BEFORE the network is up.
// Crashing on the first me() put launchd into a restart loop; retry instead.
// Each retry also re-reads the account: a daemon that booted unpaired, or was
// signed out underneath, must pick up the credential a later pairing writes
// instead of 401-ing forever on the token it started with.
async function resolveMe(client) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.me();
    } catch (err) {
      const wait = Math.min(60_000, 2_000 * attempt);
      // eslint-disable-next-line no-console
      console.error(`[relay] startup me() failed (${err && err.message}); retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (client.accountDrift().status !== "same") client.rebindToCurrentAccount();
    }
  }
}

/**
 * Follow config.json's account, in place, on every poll. Pairing, the pill's
 * Switch Account, and Sign Out all rewrite the file while this process runs;
 * each of them also asks the OS to restart the daemon, and on Windows that
 * request has failed in the field (`schtasks /End` kills the launcher wrapper,
 * not node), leaving a daemon that polls with the previous token and stages
 * the previous person's Relays into the store the pill just wiped for the new
 * one. Rebinding here is the repair that does not depend on any supervisor —
 * and it is what a restart would have achieved. Exiting instead is not an
 * option: the Windows task has no restart-on-failure and the process is
 * detached from it, so an exited daemon stays exited until next logon.
 *
 * A sign-out parks in resolveMe's retry loop exactly as an unpaired boot does,
 * until a credential appears.
 */
async function followAccountDrift({ client, log, role }) {
  const drift = client.accountDrift();
  if (drift.status === "same") return null;
  const was = drift.bound.email || drift.bound.userId || "(unpaired)";
  const now = drift.current.email || drift.current.userId || "(signed out)";
  log(`account ${drift.status} on this computer (${was} -> ${now}); rebinding the ${role}`);
  client.rebindToCurrentAccount();
  const next = await resolveMe(client);
  log(`${role} for ${next.user.email} (rebound without a restart)`);
  return next;
}

export async function runTaskDaemon({ intervalMs = 4000 } = {}) {
  // Last-resort safety net: the daemon is always-on and launchd-restarted, but a
  // restart re-delivers in-flight work and can duplicate agent turns. Keep it alive
  // through any stray async error rather than crash-looping.
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error(`[relay] uncaught exception (continuing): ${err && err.stack ? err.stack : err}`);
  });
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error(`[relay] unhandled rejection (continuing): ${reason && reason.stack ? reason.stack : reason}`);
  });
  // Start update maintenance BEFORE any network/authentication dependency. It has its
  // own registry retry/backoff and remains independent from the task-poll loop.
  const log = (m) => console.log(`[relay] ${new Date().toISOString()} ${m}`);
  migratePersistedContentFields({ log });
  // Repair Relay.app + launchd surfaces independently of npm postinstall. This is a
  // bounded, per-version migration; it reloads only the pill and never unloads this
  // currently running daemon.
  try { repairAgentMcpRegistrations(); } catch (error) {
    log(`MCP launcher repair failed: ${error?.message || error}`);
  }
  startDesktopStartupMigration({ log });
  const autoUpdater = createAutoUpdater({
    log,
    hasActiveWork: () => hasActiveTurns() || activeSessionOperationCount() > 0,
  });
  // Exit once the replacement tree is on disk.
  const bootPackageRoot = companionPackageRoot();
  const bootVersion = currentCompanionVersion(bootPackageRoot);
  startAutoUpdateLoop({
    autoUpdater,
    log,
    onUpdateLaunched: (_update, { resumeChecks }) => {
      let warnedNoReplacement = false;
      return scheduleSelfUpdateExit({
        runningVersion: bootVersion,
        packageRoot: bootPackageRoot,
        log,
        ceilingMs: CANONICAL_UPDATE_EXIT_CEILING_MS,
        replacementReady: () => {
          const current = readCanonicalRuntime();
          // "The pointer names a tree that is not mine" is the SAME fact that
          // condemned this daemon — auto-update derives `stale-process` from
          // exactly it — so on its own it cannot also be the evidence that a
          // replacement will start; the check would be verifying its own
          // precondition and the exit would be unconditional. The autostart
          // registration is the independent witness: it, not the pointer,
          // decides which tree the supervisor actually restarts.
          if (!current || path.resolve(current.packageRoot) === path.resolve(bootPackageRoot)) return false;
          const verdict = autostartWillReplace(bootPackageRoot);
          if (!verdict.willReplace && !warnedNoReplacement) {
            warnedNoReplacement = true;
            log(
              `self-update: staying alive — the canonical pointer names ${current.version || "another tree"} but ` +
                `${verdict.reason}${verdict.registration ? ` (${verdict.registration.source})` : ""}; ` +
                "exiting now would only restart this same tree",
            );
          }
          return verdict.willReplace;
        },
        onCeiling: resumeChecks,
      });
    },
  });
  // Keep the always-on logs bounded. The daemon is the single long-lived owner on
  // the machine, so it is the natural place to cap files that nothing else prunes.
  startLogRotation({ log });
  // A previous Companion release gave unanchored Relay tasks the correct
  // ~/Relay cwd but never registered/assigned the matching Codex sidebar
  // project. Repair every remembered Codex task in the background, retrying
  // until Codex has a window available. This never launches or focuses Codex;
  // future opens also perform the assignment directly.
  startRelayCodexProjectRepairLoop({ log });
  // Age out downloaded attachment copies; ingest prefetch would otherwise grow
  // ~/.relay-companion/attachments with the inbox forever.
  try {
    const { sweepStaleAttachmentFiles } = await import("./materializer.js");
    sweepStaleAttachmentFiles({ log });
  } catch (err) {
    log(`attachment sweep failed: ${err && err.message ? err.message : err}`);
  }
  // Re-register Windows autostart tasks that have gone missing. Without them the
  // machine has no logon start at all, and (before the updater stopped depending on
  // them) every self-update rolled itself back. Cheap query, no-ops off win32.
  try {
    ensureWindowsAutostartTasks({ log });
  } catch (err) {
    log(`autostart repair check failed: ${err && err.message ? err.message : err}`);
  }
  let client = new RelayClient();
  const me = await resolveMe(client);
  // eslint-disable-next-line no-console
  console.log(`[relay] receiver for ${me.user.email}; polling every ${intervalMs}ms`);
  let features = daemonProductFeatures(log, me.user);
  let claudeRuntime = createE2eeClaudeRuntimeController({ client, logger: log });
  void claudeRuntime.tick();
  let featureRefreshAt = Date.now() + ACCOUNT_FEATURE_REFRESH_MS;
  let consecutiveFailures = 0;
  for (;;) {
    const rebound = await followAccountDrift({ client, log, role: "receiver" });
    if (rebound) {
      await claudeRuntime.stop();
      claudeRuntime = createE2eeClaudeRuntimeController({ client, logger: log });
      features = daemonProductFeatures(log, rebound.user);
      featureRefreshAt = Date.now() + ACCOUNT_FEATURE_REFRESH_MS;
    } else if (Date.now() >= featureRefreshAt) {
      features = await refreshDaemonProductFeatures(client, features, log);
      featureRefreshAt = Date.now() + ACCOUNT_FEATURE_REFRESH_MS;
    }
    void claudeRuntime.tick();
    await sessionControllerTick({ client, log, features });
    try {
      const result = await daemonDeliveryTick({ client, log, features });
      if (result.ordinaryOnly) {
        if (result.ordinaryRelays.length) log(`processed ${result.ordinaryRelays.length} ordinary relay(s)`);
      } else if (
        result.sessions.length ||
        result.messages.length ||
        result.notifications.length ||
        result.ordinaryRelays.length ||
        result.events.length
      ) {
        log(
          `processed ${result.sessions.length} session(s), ${result.messages.length} message(s), ${result.notifications.length} task attention item(s), ${result.ordinaryRelays.length} ordinary relay(s), ${result.events.length} event(s)`,
        );
      }
      if (result.inboxOk) {
        if (consecutiveFailures >= SELF_HEAL_FAILURE_STREAK / 2) {
          log(`inbox polling recovered after ${consecutiveFailures} consecutive failure(s)`);
        }
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
    } catch (err) {
      consecutiveFailures += 1;
      // eslint-disable-next-line no-console
      console.error(`[relay] task daemon error: ${err.message}`);
    }
    if (consecutiveFailures >= SELF_HEAL_FAILURE_STREAK) {
      // A long-lived process can keep rendering stale local state while every
      // API call fails. Rebuild its client after a bounded streak. launchd can
      // restart on macOS; Windows Scheduled Tasks cannot, so Windows repairs in
      // place and waits for connectivity without giving up its logon process.
      if (process.platform === "win32") {
        log(`inbox polling has failed ${consecutiveFailures} times; rebuilding the Windows receiver client`);
        client = new RelayClient();
        const recovered = await resolveMe(client);
        await claudeRuntime.stop();
        claudeRuntime = createE2eeClaudeRuntimeController({ client, logger: log });
        void claudeRuntime.tick();
        features = daemonProductFeatures(log, recovered.user);
        featureRefreshAt = Date.now() + ACCOUNT_FEATURE_REFRESH_MS;
        consecutiveFailures = 0;
      } else {
        log(`inbox polling has failed ${consecutiveFailures} times; restarting the receiver`);
        process.exit(1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTaskDaemon().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
