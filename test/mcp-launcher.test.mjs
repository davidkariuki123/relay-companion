import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ensureStableMcpLauncher,
  stableMcpLauncherPath,
  STABLE_MCP_LAUNCHER_ENV,
} from "../src/mcp-launcher.js";

test("the MCP launcher lives outside the replaceable package tree and records the current target", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-launcher-"));
  const targetBin = path.join(homeDir, ".relay", "lib", "node_modules", "relay-companion", "bin", "relay.js");
  const launcher = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir });
  assert.equal(launcher, stableMcpLauncherPath(homeDir));
  assert.equal(launcher.startsWith(path.dirname(targetBin)), false);
  const source = fs.readFileSync(launcher, "utf8");
  assert.match(source, /Date\.now\(\) \+ 60000/);
  assert.match(source, /setTimeout\(launch, 250\)/);
  assert.ok(source.includes(`${STABLE_MCP_LAUNCHER_ENV}: "1"`));
  // Compare against the path AS THE FILE STORES IT: launcherSource embeds it with
  // JSON.stringify, which escapes backslashes, so a raw Windows path turned into a
  // regex looks for `C:\Users\…` while the file legitimately holds `C:\\Users\\…`
  // and can never match — green on POSIX, permanently red on Windows.
  assert.ok(
    source.includes(`const target = ${JSON.stringify(path.resolve(targetBin))};`),
    "the launcher records the current target verbatim",
  );
});

test("the MCP launcher waits through a missing-tree window and then execs the restored target", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-launcher-wait-"));
  const targetBin = path.join(homeDir, "live", "bin", "relay.js");
  const launcher = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir });
  const child = spawn(process.execPath, [launcher, "probe"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.mkdirSync(path.dirname(targetBin), { recursive: true });
  fs.writeFileSync(targetBin, 'console.log("restored:" + process.argv[2]);\n');
  const output = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  assert.match(output, /restored:probe/);
});
