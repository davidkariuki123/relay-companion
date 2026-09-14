import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import retiredHook from "./retired-hook.cjs";

const RETIRED_PROGRAM = `(${retiredHook.drainRetiredHookInput.toString()})(process.stdin);`;

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function writeAtomic(filePath, source, mode = 0o700) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = fs.readFileSync(filePath, "utf8"); } catch {}
  if (current !== source) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, source, { mode });
    fs.renameSync(tmp, filePath);
  }
  try { fs.chmodSync(filePath, mode); } catch {}
}

export function stableHookLauncherPath(homeDir = os.homedir()) {
  // Keep the compatibility filename in every host registration. Relay versions
  // going back to the first hook release identify ownership by the final
  // `relay.js <host>-hook` pair, so both upgrades and downgrades can safely
  // replace/remove this handler without duplicating it.
  return path.join(homeDir, ".relay", "bin", "relay.js");
}

export function stableWindowsHookScriptPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "bin", "hook-launcher.ps1");
}

function posixLauncherSource({ nodeCandidates }) {
  return `#!/bin/sh
# Relay hooks are retired. Never dispatch into a current or rollback runtime.
node=""
for candidate in ${nodeCandidates.map(posixQuote).join(" ")}; do
  if [ -x "$candidate" ]; then node="$candidate"; break; fi
done
[ -n "$node" ] || exit 0
exec "$node" --max-old-space-size=32 -e ${posixQuote(RETIRED_PROGRAM)} 2>/dev/null
`;
}

function windowsLauncherSource({ nodeCandidates }) {
  return `# Relay hooks are retired. Retained for cached host registrations.
param([string]$RelayMarker, [string]$RelayHook)
$node = $null
foreach ($candidate in @(${nodeCandidates.map(powershellQuote).join(", ")})) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $node = $candidate; break }
}
if (-not $node) { exit 0 }
try { & $node '--max-old-space-size=32' '-e' ${powershellQuote(RETIRED_PROGRAM)} 2>$null } catch {}
exit 0
`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

/**
 * Atomically neutralize the old stable bridge, including cached registrations.
 * The invocation shape stays compatible with legacy commands. Callers must not
 * register new hooks; this bridge intentionally never invokes targetBin.
 */
export function ensureStableHookLauncher({
  targetBin,
  node = process.execPath,
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!targetBin) throw new Error("targetBin is required");
  const pathApi = platform === "win32" ? path.win32 : path;
  const resolvedTarget = pathApi.resolve(targetBin);
  const dedicatedBin = pathApi.join(pathApi.dirname(resolvedTarget), "relay-hook.js");
  const markerPath = stableHookLauncherPath(homeDir);

  if (platform === "win32") {
    const scriptPath = stableWindowsHookScriptPath(homeDir);
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const nodeCandidates = unique([
      node,
      path.win32.join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      env["ProgramFiles(x86)"] ? path.win32.join(env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
    ]);
    // Windows PowerShell 5 treats BOM-less scripts as the active ANSI codepage;
    // the BOM keeps Unicode user/runtime paths intact on every supported host.
    writeAtomic(scriptPath, `\uFEFF${windowsLauncherSource({ targetBin: resolvedTarget, dedicatedBin, nodeCandidates })}`);
    // This is deliberately a harmless marker, not executable JavaScript. It is
    // the stable ownership token old Relay versions recognize in hook args.
    writeAtomic(markerPath, "// Relay hook ownership marker. Do not execute.\n", 0o600);
    return {
      platform,
      markerPath,
      scriptPath,
      command: powershell,
      argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, markerPath],
      targetBin: resolvedTarget,
      dedicatedBin,
    };
  }

  const nodeCandidates = unique([node, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]);
  writeAtomic(markerPath, posixLauncherSource({ targetBin: resolvedTarget, dedicatedBin, nodeCandidates }));
  return {
    platform,
    markerPath,
    scriptPath: markerPath,
    command: "/bin/sh",
    argsPrefix: [markerPath],
    targetBin: resolvedTarget,
    dedicatedBin,
  };
}

export function removeStableHookLauncher({ homeDir = os.homedir() } = {}) {
  for (const filePath of [stableHookLauncherPath(homeDir), stableWindowsHookScriptPath(homeDir)]) {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
