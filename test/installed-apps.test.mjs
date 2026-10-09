import assert from "node:assert/strict";
import test from "node:test";
import installedApps from "../src/installed-apps.cjs";
import { detectAgentSurfaces } from "../src/capabilities.js";

// A pretend file system: the files and folders that exist, and what each
// folder lists. Windows paths are written with String.raw.
function disk(paths) {
  const set = new Set(paths);
  // A folder exists when anything is inside it, as on a real disk.
  return {
    exists: (file) => set.has(file) || [...set].some((entry) => entry.startsWith(`${file}\\`) || entry.startsWith(`${file}/`)),
    readdir: (dir) => {
      const prefix = dir.endsWith("\\") || dir.endsWith("/") ? dir : `${dir}${dir.includes("\\") ? "\\" : "/"}`;
      const names = new Set();
      for (const file of set) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split(/[\\/]/)[0]);
      return [...names];
    },
  };
}

// Shane's laptop, 2026-10-09: Claude Code's CLI in ~/.local/bin, the Claude
// and ChatGPT/Codex Store apps, the Claude app's own Claude Code, and the
// Codex app's own codex.exe. The old lookup found none of them.
const WIN_HOME = String.raw`C:\Users\me`;
const WIN_ENV = { USERPROFILE: WIN_HOME, LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`, APPDATA: String.raw`C:\Users\me\AppData\Roaming`, PATH: String.raw`C:\Windows\System32;C:\Users\me\.local\bin`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const WIN_FILES = [
  String.raw`C:\Users\me\.local\bin\claude.exe`,
  String.raw`C:\Users\me\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`,
  String.raw`C:\Users\me\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\Settings`,
  String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.289\e1f0154146bb\claude.exe`,
  String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.293\83cb0bd7fed4\claude.exe`,
  String.raw`C:\Users\me\AppData\Local\OpenAI\Codex\bin\9691020b546a15b2\codex.exe`,
];
const win = (files = WIN_FILES, env = WIN_ENV) => ({ platform: "win32", env, homedir: WIN_HOME, ...disk(files) });

test("Windows: the apps on this computer are found where Windows installs them", () => {
  const apps = installedApps.installedAiApps(win());
  assert.equal(apps.claudeCli, String.raw`C:\Users\me\.local\bin\claude.exe`);
  assert.equal(apps.codexCli, "", "no Codex CLI, only the app's own codex");
  assert.equal(apps.claudeApp, String.raw`C:\Users\me\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`);
  assert.equal(apps.chatgptApp, String.raw`C:\Users\me\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0`);
  assert.equal(apps.codexAppBinary, String.raw`C:\Users\me\AppData\Local\OpenAI\Codex\bin\9691020b546a15b2\codex.exe`);
  assert.equal(apps.claudeAppCode, String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code`);
  assert.equal(apps.claudeAppCodeCli, String.raw`C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.293\83cb0bd7fed4\claude.exe`, "the newest version the app downloaded");
  assert.equal(apps.conductorApp, "");
});

test("Windows: a Claude app not yet opened is still installed, and nothing installed reads as nothing", () => {
  const fresh = installedApps.installedAiApps(win([String.raw`C:\Users\me\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\AC`]));
  assert.equal(fresh.claudeApp, String.raw`C:\Users\me\AppData\Local\Packages\Claude_pzs8sxrjxfjjc`);
  assert.deepEqual(Object.values(installedApps.installedAiApps(win([]))).filter(Boolean), []);
});

test("PATH is scanned in-process, with Windows' own extensions", () => {
  const found = installedApps.findOnPath("codex", { platform: "win32", env: { PATH: String.raw`C:\a;C:\b`, PATHEXT: ".EXE;.CMD" }, ...disk([String.raw`C:\b\codex.cmd`]) });
  assert.equal(found, String.raw`C:\b\codex.cmd`);
  assert.equal(installedApps.findOnPath("claude", { platform: "darwin", env: { PATH: "/usr/bin:/opt/x/bin" }, ...disk(["/opt/x/bin/claude"]) }), "/opt/x/bin/claude");
  assert.equal(installedApps.findOnPath("claude", { platform: "linux", env: { PATH: "" }, ...disk([]) }), "");
});

test("macOS: the app bundles, their own Claude Code and codex, and Conductor", () => {
  const home = "/Users/me";
  const files = [
    "/Applications/Claude.app",
    `${home}/Applications/ChatGPT.app`,
    `${home}/Applications/ChatGPT.app/Contents/Resources/codex`,
    "/Applications/Conductor.app",
    `${home}/Library/Application Support/Claude/claude-code/2.1.293/abc/claude.app/Contents/MacOS/claude`,
    "/opt/homebrew/bin/claude",
  ];
  const apps = installedApps.installedAiApps({ platform: "darwin", env: { HOME: home, PATH: "" }, homedir: home, ...disk(files) });
  assert.equal(apps.claudeApp, "/Applications/Claude.app");
  assert.equal(apps.chatgptApp, `${home}/Applications/ChatGPT.app`);
  assert.equal(apps.codexAppBinary, `${home}/Applications/ChatGPT.app/Contents/Resources/codex`);
  assert.equal(apps.conductorApp, "/Applications/Conductor.app");
  assert.equal(apps.claudeCli, "/opt/homebrew/bin/claude");
  assert.equal(apps.claudeAppCodeCli, `${home}/Library/Application Support/Claude/claude-code/2.1.293/abc/claude.app/Contents/MacOS/claude`);
});

test("Open in on Windows: in the Claude app, the Codex app, or a terminal, like macOS", () => {
  const surfaces = detectAgentSurfaces(win());
  for (const name of ["Claude Code", "Codex"]) assert.equal(surfaces[name].available, true, `${name} opens here`);
  assert.equal(surfaces._claudeDesktop.available, true);
  assert.equal(surfaces._codexDesktop.available, true);
  assert.equal(surfaces._claudeCli.available, true, "Claude Code's CLI opens in a terminal");
  assert.equal(surfaces._codexCli.available, false, "no Codex CLI on this computer");

  // Only the CLI here: it opens in a terminal.
  const cliOnly = detectAgentSurfaces(win([String.raw`C:\Users\me\.local\bin\claude.exe`]));
  assert.equal(cliOnly["Claude Code"].available, true);
  assert.equal(cliOnly._claudeDesktop.available, false);

  const empty = detectAgentSurfaces(win([]));
  assert.equal(empty["Claude Code"].reason, "Claude Code isn’t installed on this computer");
  assert.equal(empty._claudeDesktop.reason, "Claude isn’t installed on this computer");
});
