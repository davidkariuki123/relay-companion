import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import runtimeHealth from "../bootstrap/runtime-health.cjs";

// The parent owns the subprocess so a worker crash/termination cannot orphan
// PowerShell. Neither process enumeration nor metadata hashing runs synchronously
// on the request thread. The live recovery collectors keep their existing API.
export async function collectFleetTelemetryInBackground(context, signal, {
  query = runtimeHealth.runtimeProcessQuery(process.platform),
  workerUrl = new URL("./fleet-telemetry-worker.js", import.meta.url),
} = {}) {
  signal.throwIfAborted();
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(query.command, query.args, {
      encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (error, output) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      process.removeListener("exit", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(output);
    });
    const cancel = () => child.kill();
    // execFile's built-in timeout keeps short-lived CLI callers alive. Own an
    // unreferenced deadline instead, and kill the child on ordinary parent exit.
    const timeout = setTimeout(cancel, 15_000);
    timeout.unref();
    signal.addEventListener("abort", cancel, { once: true });
    process.once("exit", cancel);
    child.stdin?.end();
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
  });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { ...context, processOutput: stdout },
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let report;
    let failure;
    const cancel = () => { void worker.terminate().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    worker.on("message", message => { report = message; });
    worker.on("error", error => { failure = error; });
    // Hold the in-flight slot until exit, including termination after timeout.
    worker.once("exit", code => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0 || typeof report !== "string" || !report) reject(failure || new Error("telemetry-worker-failed"));
      else resolve(report);
    });
    worker.unref();
  });
}

/** Request-time access never waits for collection. Time is sample age, not receipt age. */
export function createFleetTelemetryCache({
  collect = collectFleetTelemetryInBackground,
  context,
  now = Date.now,
  maxAgeMs = 30_000,
  timeoutMs = 25_000,
  retryMs = 30_000,
} = {}) {
  let cached = null;
  let pending = null;
  let retryAt = 0;
  let generation = 0;
  let currentKey;
  function reset() {
    generation++;
    cached = null;
    retryAt = 0;
    currentKey = undefined;
    pending?.controller.abort();
  }
  return {
    reset,
    header(scope = "") {
      try {
        const snapshot = context(scope);
        const timestamp = now();
        if (snapshot.key !== currentKey) {
          reset();
          currentKey = snapshot.key;
        }
        if (cached && timestamp >= cached.at && timestamp - cached.at < maxAgeMs) return cached.header;
        cached = null;
        if (pending || (timestamp < retryAt && retryAt - timestamp <= retryMs)) return "";
        const controller = new AbortController();
        const run = { controller, generation, at: timestamp };
        pending = run;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        // collect's production implementation starts async execFile immediately.
        // The rejection handler also covers synchronous setup failures.
        void Promise.resolve().then(() => collect(snapshot, controller.signal)).then(header => {
          if (controller.signal.aborted || run.generation !== generation) return;
          const age = now() - run.at;
          if (age >= 0 && age < maxAgeMs && context(scope).key === snapshot.key
              && typeof header === "string" && header.length > 0 && header.length <= 4096) cached = { header, at: run.at };
        }).catch(() => {
          // Diagnostic failures cannot fail the API request or escape as an
          // unhandled rejection. Retry at most once per cooldown.
        }).finally(() => {
          clearTimeout(timer);
          if (pending === run) pending = null;
          if (run.generation === generation && !cached) retryAt = now() + retryMs;
        });
      } catch {
        reset();
      }
      return "";
    },
  };
}
