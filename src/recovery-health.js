import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { write } = createRequire(import.meta.url)("../bootstrap/recovery-runner.cjs");
const version = createRequire(import.meta.url)("../package.json").version;
const { installationId } = createRequire(import.meta.url)("../bootstrap/installation-health.cjs");
export function startRecoveryHeartbeat({ homeDir = os.homedir(), hasActiveWork = () => false,
  now = Date.now, setIntervalImpl = setInterval } = {}) {
  const file = path.join(homeDir, ".relay", "recovery", "daemon.json");
  try { write(path.join(homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: !/^(0|false|off|no)$/i.test(String(process.env.RELAY_AUTO_UPDATE || "")) }); } catch {}
  try { installationId({ homeDir, create: true }); } catch {}
  const tick = () => {
    let busy = true;
    try { busy = Boolean(hasActiveWork()); } catch {}
    try { write(file, { schema: 1, pid: process.pid, version, busy, at: now() }); } catch {}
  };
  tick();
  const timer = setIntervalImpl(tick, 5000);
  timer.unref?.();
  return timer;
}
