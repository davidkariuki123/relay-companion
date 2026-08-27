import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STABLE_MCP_LAUNCHER_ENV = "RELAY_STABLE_MCP_LAUNCHER";

export function stableMcpLauncherPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "bin", "mcp-launcher.cjs");
}

function launcherSource(targetBin, node) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const target = ${JSON.stringify(targetBin)};
const node = ${JSON.stringify(node)};
const deadline = Date.now() + 60000;
function launch() {
  if (!fs.existsSync(target)) {
    if (Date.now() < deadline) return setTimeout(launch, 250);
    console.error("Relay is updating and its MCP entrypoint did not return within 60 seconds: " + target);
    process.exit(1);
  }
  const child = spawn(node, ["--max-old-space-size=96", target, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ${STABLE_MCP_LAUNCHER_ENV}: "1" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", (error) => { console.error("Relay MCP launcher failed: " + error.message); process.exit(1); });
  child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code == null ? 1 : code); });
}
launch();
`;
}

/** Write the upgrade-surviving MCP launcher outside the replaceable npm tree. */
export function ensureStableMcpLauncher({ targetBin, node = process.execPath, homeDir = os.homedir() }) {
  const launcherPath = stableMcpLauncherPath(homeDir);
  const source = launcherSource(path.resolve(targetBin), node);
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = fs.readFileSync(launcherPath, "utf8"); } catch {}
  if (current !== source) {
    const tmp = `${launcherPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, source, { mode: 0o700 });
    fs.renameSync(tmp, launcherPath);
  }
  try { fs.chmodSync(launcherPath, 0o700); } catch {}
  return launcherPath;
}
