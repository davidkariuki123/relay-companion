import { Worker } from "node:worker_threads";

// A thread owns its own event loop and HTTP pool, and dies with its daemon.
// An unexpected thread exit is retried without starting a second receiver.
export function startInboxWorker({ intervalMs = 4000, log = () => {}, WorkerImpl = Worker, restartMs = 2000 } = {}) {
  let stopped = false;
  let worker;
  let restart;
  const launch = () => {
    if (stopped) return;
    try {
      worker = new WorkerImpl(new URL("./inbox-receiver-worker.js", import.meta.url), {
        workerData: { intervalMs }, resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      worker.on("error", (error) => log(`inbox worker failed: ${error.message}`));
      worker.on("exit", (code) => {
        if (stopped) return;
        log(`inbox worker exited (${code}); restarting`);
        restart = setTimeout(launch, restartMs);
      });
    } catch (error) {
      log(`inbox worker could not start: ${error.message}`);
      restart = setTimeout(launch, restartMs);
    }
  };
  launch();
  return { stop() { stopped = true; clearTimeout(restart); return worker?.terminate(); } };
}
