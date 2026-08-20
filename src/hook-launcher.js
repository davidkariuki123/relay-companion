import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function posixLauncherSource({ targetBin, dedicatedBin, nodeCandidates }) {
  return `#!/bin/sh
# Relay's hook bridge lives outside the replaceable npm/runtime tree.
hook="$1"
case "$hook" in claude-hook|codex-hook) ;; *) exit 0 ;; esac
target=${posixQuote(targetBin)}
dedicated=${posixQuote(dedicatedBin)}
node=""
for candidate in ${nodeCandidates.map(posixQuote).join(" ")}; do
  if [ -x "$candidate" ]; then node="$candidate"; break; fi
done
[ -n "$node" ] || exit 0
if [ -f "$dedicated" ]; then
  # Replace the shell so a host timeout cannot leave the hook Node child alive.
  # The dedicated entrypoint is itself fail-open and exits zero.
  exec "$node" --max-old-space-size=96 "$dedicated" "$hook" 2>/dev/null
fi
[ -f "$target" ] || exit 0
# Compatibility for a downgrade to a Relay version without relay-hook.js.
"$node" --max-old-space-size=96 "$target" "$hook" 2>/dev/null || :
exit 0
`;
}

function windowsLauncherSource({ targetBin, dedicatedBin, nodeCandidates }) {
  return `# Relay's hook bridge lives outside the replaceable npm/runtime tree.
param([string]$RelayMarker, [string]$RelayHook)
if ($RelayHook -ne 'claude-hook' -and $RelayHook -ne 'codex-hook') { exit 0 }
$target = ${powershellQuote(targetBin)}
$dedicated = ${powershellQuote(dedicatedBin)}
$node = $null
foreach ($candidate in @(${nodeCandidates.map(powershellQuote).join(", ")})) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $node = $candidate; break }
}
if (-not $node) { exit 0 }
$script = $dedicated
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { $script = $target }
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { exit 0 }
try { & $node '--max-old-space-size=96' $script $RelayHook 2>$null } catch {}
exit 0
`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

/**
 * Atomically point the upgrade-surviving hook bridge at a verified runtime.
 * The returned command/argsPrefix can be written directly into Claude's
 * exec-form hook; Codex receives the equivalent shell command.
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
