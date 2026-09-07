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

export function startReceiverWorker({ intervalMs = 4000 } = {}) {
  const log = (message) => console.log(`[relay] ${new Date().toISOString()} ${message}`);
  let receiver;
  let client;
  const current = (candidate) => candidate.accountDrift().status === "same"
    && candidate.url === secureRelayApiUrl(apiUrl());
  const reconcile = () => {
    if (client && current(client)) return;
    receiver?.stop();
    client = new RelayClient();
    if (!client.token) return;
    const bound = client;
    const scope = inboxAccountScope(bound);
    receiver = startInboxReceiver({
      client: bound, intervalMs, log, isCurrent: () => current(bound),
      refresh: ({ isCurrent }) => pollOrdinaryRelayOnce({
        client: bound, log, ...notificationLedger(bound, { isCurrent }), isCurrent,
        queueAttachments: (job) => queueInboxAttachments(job, { scope }),
        // Completion work is durable at ingest, then consumed by the daemon.
        processCompletionWakes: async () => {},
      }),
    });
    log("ordinary inbox receiver connected independently of session and task work");
  };
  reconcile();
  const timer = setInterval(() => {
    try { reconcile(); } catch (error) { receiver?.stop(); client = null; log(`inbox account refresh failed: ${error.message}`); }
  }, 1000);
  return { stop() { clearInterval(timer); receiver?.stop(); } };
}

if (!isMainThread) startReceiverWorker(workerData || {});
