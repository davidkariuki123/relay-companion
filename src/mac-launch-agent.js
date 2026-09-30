// launchd removal is asynchronous. A one-shot unload/load can strand the job
// until the independent recovery service notices. Retry only transient bootstrap
// failures, without booting out a replacement between attempts.
export function reloadMacLaunchAgent({ label, plistPath, runCommand,
  uid = process.getuid?.() ?? 0, attempts = 20, delayMs = 250, now = Date.now, timeoutMs = 10_000,
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}) {
  const domain = `gui/${uid}`;
  const deadline = now() + timeoutMs;
  const run = (args) => runCommand("launchctl", args, { timeoutMs: 2_000 });
  run(["bootout", `${domain}/${label}`]);
  let result;
  for (let attempt = 0; attempt < attempts && now() <= deadline; attempt += 1) {
    result = run(["bootstrap", domain, plistPath]);
    if (result.ok) {
      const registered = run(["print", `${domain}/${label}`]);
      return registered.ok ? { ok: true } : { ok: false, reason: "launch-agent-not-registered", detail: registered.out };
    }
    const detail = String(result.out || result.stderr || "");
    if (!/(?:Bootstrap failed:\s*5|Input\/output error|I\/O error|already (?:loaded|exists)|in progress)/i.test(detail)) break;
    if (attempt + 1 < attempts) sleep(delayMs);
  }
  return { ok: false, reason: "launch-agent-bootstrap-failed", detail: String(result?.out || result?.stderr || "launchctl bootstrap failed") };
}
