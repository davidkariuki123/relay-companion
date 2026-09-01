import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectAgentSurfaces } from "../src/capabilities.js";

test("Relay exposes only providers with native start, stream, and follow-up transports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-surfaces-"));
  try {
    const surfaces = detectAgentSurfaces({
      platform: "darwin",
      homedir: root,
      env: { HOME: root, PATH: "" },
    });
    assert.deepEqual(
      Object.keys(surfaces).filter((name) => !name.startsWith("_")),
      ["Claude Code", "Claude Cowork", "Codex"],
    );
    assert.equal("ChatGPT Work" in surfaces, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the product contains no ChatGPT Work provider route", () => {
  for (const relative of ["../overlay/inbox.html", "../overlay/main.cjs", "../src/capabilities.js"]) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /ChatGPT Work|chatgpt_work/);
  }
});

test("provider availability includes CLI-only installs while desktop and terminal remain separate surfaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-desktop-surfaces-"));
  try {
    // /Applications is the machine's own; only ~/Applications is sandboxed here,
    // so the bare expectation is derived from what this Mac really has.
    const systemHas = (names) => names.some((name) => fs.existsSync(path.join("/Applications", `${name}.app`)));
    const bare = detectAgentSurfaces({ platform: "darwin", homedir: root, env: { HOME: root, PATH: "" } });
    assert.equal(bare._claudeDesktop.available, systemHas(["Claude"]));
    assert.equal(bare._codexDesktop.available, systemHas(["ChatGPT", "Codex"]));
    if (!bare._claudeDesktop.available) assert.equal(bare._claudeDesktop.reason, "Claude isn’t installed on this Mac");
    if (!bare._codexDesktop.available) assert.equal(bare._codexDesktop.reason, "Codex isn’t installed on this Mac");
    fs.mkdirSync(path.join(root, "Applications", "Claude.app"), { recursive: true });
    fs.mkdirSync(path.join(root, "Applications", "ChatGPT.app"), { recursive: true });
    const withApps = detectAgentSurfaces({ platform: "darwin", homedir: root, env: { HOME: root, PATH: "" } });
    assert.deepEqual([withApps._claudeDesktop.available, withApps._claudeDesktop.reason], [true, ""]);
    assert.deepEqual([withApps._codexDesktop.available, withApps._codexDesktop.reason], [true, ""], "the ChatGPT app is Codex's desktop home");
    // `via` is built with path.join from the sandbox root, so its separator is the
    // HOST's, not the simulated platform's. Hard-coding "/" passes on macOS and can
    // never pass on Windows, where the same correct value reads
    // `…\Applications\Claude.app`.
    assert.ok(
      withApps._claudeDesktop.via.endsWith(path.join("Applications", "Claude.app")),
      `via should point at the sandboxed Claude.app, got ${withApps._claudeDesktop.via}`,
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["claude", "codex"]) {
      const filePath = path.join(bin, command);
      fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
    }
    const cliOnlyHome = path.join(root, "cli-only");
    fs.mkdirSync(cliOnlyHome, { recursive: true });
    const cliOnly = detectAgentSurfaces({
      platform: "darwin",
      homedir: cliOnlyHome,
      env: { HOME: cliOnlyHome, PATH: bin },
    });
    assert.equal(cliOnly["Claude Code"].available, true);
    assert.equal(cliOnly.Codex.available, true);
    assert.equal(cliOnly._claudeCli.available, true);
    assert.equal(cliOnly._codexCli.available, true);
    assert.equal(cliOnly._claudeDesktop.available, systemHas(["Claude"]));
    assert.equal(cliOnly._codexDesktop.available, systemHas(["ChatGPT", "Codex"]));
    const elsewhere = detectAgentSurfaces({ platform: "linux", homedir: root, env: { HOME: root, PATH: "" } });
    assert.equal(elsewhere._claudeDesktop.available, false);
    assert.equal(elsewhere._codexDesktop.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
