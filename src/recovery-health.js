import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { write } = createRequire(import.meta.url)("../bootstrap/recovery-launcher.cjs");
const version = createRequire(import.meta.url)("../package.json").version;
const { installationId } = createRequire(import.meta.url)("../bootstrap/installation-health.cjs");
// apiOkAt: when this daemon last got any HTTP answer from Relay. The pill reads
// it to decide whether a long run of its own failures is Relay being down or
// its own transport being wedged (src/pill-liveness.cjs).
export function startRecoveryHeartbeat({ homeDir = os.homedir(), hasActiveWork = () => false, apiOkAt = () => 0,
  now = Date.now, setIntervalImpl = setInterval } = {}) {
  const file = path.join(homeDir, ".relay", "recovery", "daemon.json");
  try { write(path.join(homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: !/^(0|false|off|no)$/i.test(String(process.env.RELAY_AUTO_UPDATE || "")) }); } catch {}
  try { installationId({ homeDir, create: true }); } catch {}
  let lastTick = now(), awakeSince = lastTick;
  const tick = () => {
    const at = now();
    // Sleep, a clock jump or a long process pause needs a new observation window.
    if (at < lastTick || at - lastTick > 2 * 60_000) awakeSince = at;
    lastTick = at;
    let busy = true;
    try { busy = Boolean(hasActiveWork()); } catch {}
    let lastApiOkAt = 0;
    try { lastApiOkAt = Number(apiOkAt()) || 0; } catch {}
    try { write(file, { schema: 1, pid: process.pid, version, busy, activityVersion: 1, awakeSince, at, apiOkAt: lastApiOkAt }); } catch {}
  };
  tick();
  const timer = setIntervalImpl(tick, 5000);
  timer.unref?.();
  return timer;
}
