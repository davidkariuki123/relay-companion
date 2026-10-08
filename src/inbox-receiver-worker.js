import path from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { RelayClient, secureRelayApiUrl } from "./client.js";
import { apiUrl, configDir } from "./config.js";
import { companionStatePath } from "./notifications.js";
import { readTaskLedger } from "./runtime.js";
import { pollOrdinaryRelayOnce } from "./task-daemon.js";
import { startInboxReceiver } from "./inbox-receiver.js";
import { inboxAccountScope, queueInboxAttachments, readInboxJson } from "./inbox-work.js";
import atomicJson from "./atomic-json.cjs";
import { createInboxHealth } from "./inbox-health.js";

export function notificationLedger(client, { file = path.join(configDir(), "inbox-ledger.json"), isCurrent = () => true } = {}) {
  const state = readInboxJson(companionStatePath());
  const scope = inboxAccountScope(client);
  const resetAt = state?.account?.resetAt || "";
  const prior = readInboxJson(file);
  // Seed a first install only when the legacy store belongs to this account.
  // A later reset must refill the cleared store, even for the same account.
  const inherited = !prior && state?.account?.userId && state.account.userId === client.identity?.userId
    ? readTaskLedger().plainRelays || {} : {};
  const ledger = prior?.scope === scope && prior.resetAt === resetAt
    ? prior : { scope, resetAt, plainRelays: inherited };
  return { ledger, saveLedger: (value) => {
    if (!isCurrent()) throw new Error("Inbox account changed before saving progress");
    atomicJson.atomicWriteJsonSync(file, value, { mode: 0o600 });
  } };
}

// A receiver that has not received for this long while bound is rebuilt in
// place: the hung refresh is abandoned (its ledger writes are refused, see
// notificationLedger) and a fresh one starts.
export const RECEIVER_STALL_MS = 3 * 60_000;

export function startReceiverWorker({ intervalMs = 4000, now = Date.now, health: providedHealth, makeClient = () => new RelayClient(),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, poll = pollOrdinaryRelayOnce, startReceiver = startInboxReceiver,
  stallMs = RECEIVER_STALL_MS } = {}) {
  const log = (message) => console.log(`[relay] ${new Date().toISOString()} ${message}`);
  const health = providedHealth || createInboxHealth({ log, now });
  let receiver;
  let client;
  let boundAt = 0;
  const drift = (candidate) => candidate.accountDrift().status;
  const current = (candidate) => drift(candidate) === "same"
    && candidate.url === secureRelayApiUrl(apiUrl());
  const reconcile = () => {
    if (client && current(client)) {
      // Bound, but nothing received for too long: rebuild instead of staying
      // silently wedged while the service's heartbeat says all is well.
      const lastOk = Math.max(health.snapshot().okAt || 0, boundAt);
      if (!(now() - lastOk > stallMs)) return;
      log(`inbox receiver received nothing for ${Math.round((now() - lastOk) / 1000)}s; restarting it`);
    }
    receiver?.stop();
    receiver = null;
    client = makeClient();
    if (!client.token) { health.unbound("signed-out"); client = null; return; }
    if (!current(client)) { health.unbound(`account-${drift(client)}`); client = null; return; }
    const bound = client;
    boundAt = now();
    const scope = inboxAccountScope(bound);
    receiver = startReceiver({
      client: bound, intervalMs, log, isCurrent: () => current(bound),
      refresh: async ({ isCurrent }) => {
        try {
          const result = await poll({
            client: bound, log, ...notificationLedger(bound, { isCurrent }), isCurrent,
            queueAttachments: (job) => queueInboxAttachments(job, { scope }),
            // Completion work is durable at ingest, then consumed by the daemon.
            processCompletionWakes: async () => {},
          });
          if (isCurrent()) { if (result?.inboxOk !== false) health.received(); else health.failed("inbox-unavailable"); }
          return result;
        } catch (error) {
          if (isCurrent()) health.failed(error?.message || "refresh-failed");
          throw error;
        }
      },
    });
    log("ordinary inbox receiver connected independently of session and task work");
  };
  reconcile();
  const timer = setIntervalImpl(() => {
    try { reconcile(); } catch (error) { receiver?.stop(); client = null; health.failed(error?.message); log(`inbox account refresh failed: ${error.message}`); }
  }, 1000);
  return { stop() { clearIntervalImpl(timer); receiver?.stop(); } };
}

if (!isMainThread) startReceiverWorker(workerData || {});
