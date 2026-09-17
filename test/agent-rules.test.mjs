import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rules = require("../bootstrap/relay-rules.cjs");
const skill = require("../bootstrap/relay-skill.cjs");
const content = require("../bootstrap/relay-rules-content.cjs");

function tempHome(t, label) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-rules-${label}-`));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test("the Claude Code rules file carries the milestone doctrine and is Relay-owned", async (t) => {
  const homeDir = tempHome(t, "install");
  const options = { homeDir, env: {} };
  const file = rules.claudeRulesPath(options);
  assert.equal(path.relative(homeDir, file).split(path.sep).join("/"), ".claude/rules/relay.md");

  const installed = rules.install({ ...options, version: "1.2.3" });
  assert.equal(installed.status, "installed");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^<!-- Relay rules \(skill 1\.2\.3\)\./, "the first line says whose file this is and what happens to edits");
  assert.ok(text.endsWith(content.milestoneGuide), "the doctrine is the file");
  assert.match(text, /## Creating a Relay at milestones/);
  assert.match(text, /A milestone Relay is always a link from relay_share_link, even when the\n\s*person it is for is a saved contact/);
  assert.match(text, /When nothing qualifies, do not mention Relay at all/);
  assert.doesNotMatch(text, /\[\[dev\]\]|\[\[prod\]\]/, "channel markers never reach a person's rules folder");
  assert.equal(rules.install({ ...options, version: "1.2.3" }).status, "current");
  assert.deepEqual(rules.status(options), { file, exists: true, managed: true, version: "1.2.3" });

  // A newer skill rewrites Relay's own bytes.
  const updated = rules.install({ ...options, version: "1.2.4" });
  assert.equal(updated.status, "updated");
  assert.match(fs.readFileSync(file, "utf8"), /skill 1\.2\.4/);

  // The person's own edit is kept, reported, and never overwritten.
  fs.appendFileSync(file, "\n- Never for anything in the finance folder.\n");
  const kept = rules.install({ ...options, version: "1.2.5" });
  assert.equal(kept.ok, true);
  assert.equal(kept.status, "kept_local_edit");
  assert.match(fs.readFileSync(file, "utf8"), /finance folder/);
  assert.equal(rules.status(options).managed, false);
  const keptOnUninstall = rules.uninstall(options);
  assert.equal(keptOnUninstall.status, "kept_local_edit");
  assert.ok(fs.existsSync(file), "an edited file survives uninstall");

  // Relay's own bytes with a lost record are recognised and removable.
  fs.writeFileSync(file, rules.renderRulesFile("1.2.5"));
  fs.rmSync(rules.statePath(options), { force: true });
  assert.equal(rules.install({ ...options, version: "1.2.5" }).status, "current");
  assert.equal(rules.uninstall(options).status, "removed");
  assert.equal(fs.existsSync(file), false);
  assert.equal(rules.uninstall(options).status, "already_absent");
});

test("the rules file travels with the managed Claude skill: installed with it, refreshed with it, removed with it", async (t) => {
  const homeDir = tempHome(t, "skill");
  const env = { RELAY_CONFIG_DIR: path.join(homeDir, ".relay") };
  const installed = await skill.installBundled({ homeDir, env, consent: true, host: "claude" });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const rulesResult = installed.results.find((item) => item.target === "rules");
  assert.equal(rulesResult?.host, "claude");
  assert.equal(rulesResult?.status, "installed");
  const file = path.join(homeDir, ".claude", "rules", "relay.md");
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`skill ${installed.version.replace(/\\./g, "\\\\.")}`));

  // The Codex-only install never touches Claude's rules folder.
  const codexHome = tempHome(t, "codex");
  const codexOnly = await skill.installBundled({ homeDir: codexHome, env: { RELAY_CONFIG_DIR: path.join(codexHome, ".relay") }, consent: true, host: "codex" });
  assert.equal(codexOnly.ok, true);
  assert.equal(codexOnly.results.some((item) => item.target === "rules"), false);
  assert.equal(fs.existsSync(path.join(codexHome, ".claude")), false);

  // A second run is a no-op that still reports the file.
  const again = await skill.installBundled({ homeDir, env, host: "claude" });
  assert.equal(again.results.find((item) => item.target === "rules")?.status, "current");

  const removed = skill.uninstallManaged({ homeDir, env, host: "claude" });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.results.find((item) => item.target === "rules")?.status, "removed");
  assert.equal(fs.existsSync(file), false);
});
