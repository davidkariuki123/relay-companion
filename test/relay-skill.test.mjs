import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skill = require("../bootstrap/relay-skill.cjs");

test("updates add the skill to both Codex directories and Claude without overwriting user files", async (t) => {
  const { installAgentSkills } = await import("../src/install.js");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-update-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, env: {} };
  const targets = skill.defaultTargets(options);
  assert.deepEqual(targets.map((item) => path.relative(homeDir, item.directory).split(path.sep).join("/")), [".codex/skills/relay", ".agents/skills/relay", ".claude/skills/relay"]);
  const custom = targets[0].directory;
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, "SKILL.md"), "My own Relay instructions");
  const installed = await installAgentSkills(options);
  assert.equal(installed.results[0].status, "unmanaged");
  assert.ok(installed.results.slice(1).every((result) => result.ok));
  assert.equal(fs.readFileSync(path.join(custom, "SKILL.md"), "utf8"), "My own Relay instructions");
  const repeated = await installAgentSkills(options);
  assert.ok(repeated.results.slice(1).every((result) => result.status === "current"));
});

test("skill updates follow the configured environment and reject cross-origin bundles", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-origin-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configDir = path.join(homeDir, "custom-relay");
  fs.mkdirSync(configDir);
  const options = { homeDir, env: { RELAY_CONFIG_DIR: configDir } };
  fs.writeFileSync(path.join(configDir, "agent-protocol.json"), JSON.stringify({ apiUrl: "https://dev-api.sendrelays.com" }));
  assert.equal(skill.configuredManifestUrl(options), "https://dev.sendrelays.com/skills/relay/manifest.json");
  fs.writeFileSync(path.join(configDir, "agent-protocol.json"), JSON.stringify({ apiUrl: "https://cti37jd7vx.us-east-1.awsapprunner.com" }));
  assert.equal(skill.configuredManifestUrl(options), "https://8epdrqim29.us-east-1.awsapprunner.com/skills/relay/manifest.json");
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiUrl: "https://custom.example" }));
  assert.throws(() => skill.configuredManifestUrl(options), /configured web origin/);
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ webUrl: "https://sendrelays.com" }));
  assert.equal(skill.configuredManifestUrl(options), skill.MANIFEST_URL);
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ webUrl: "https://dev.sendrelays.com" }));
  const offered = fixture();
  await assert.rejects(skill.updateFromRemote({ ...options, targets: [], fetchImpl: async (url) => {
    assert.equal(url, "https://dev.sendrelays.com/skills/relay/manifest.json");
    return new Response(JSON.stringify(offered.manifest));
  } }), /configured web origin/);
});

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture(version = "1.0.0", consentVersion = 1) {
  const files = new Map([
    ["SKILL.md", Buffer.from("---\nname: relay\ndescription: fixture\n---\n")],
    ["scripts/relay-protocol.mjs", Buffer.from("console.log('relay');\n")],
  ]);
  return {
    files,
    manifest: skill.validateManifest({
      schemaVersion: 1,
      name: "relay",
      version,
      consentVersion,
      baseUrl: `https://sendrelays.com/skills/relay/v${version}`,
      files: [...files].map(([filePath, bytes]) => ({ path: filePath, sha256: digest(bytes) })),
    }),
  };
}

test("managed Relay skill install is consented, verified, atomic, and rollback-capable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ".codex", "skills", "relay");
  const env = { RELAY_CONFIG_DIR: path.join(root, ".relay") };
  const target = [{ host: "codex", directory }];
  const first = fixture("1.0.0");

  const refused = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target, env });
  assert.equal(refused.ok, false);
  assert.equal(refused.results[0].status, "consent_required");

  const installed = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target, consent: true, env });
  assert.equal(installed.ok, true);
  assert.equal(installed.results[0].status, "installed");
  assert.equal(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"), first.files.get("SKILL.md").toString());
  const firstState = skill.readState(directory);
  assert.equal(firstState.version, "1.0.0");
  assert.equal(firstState.host, "codex");
  assert.equal(firstState.target, "primary");
  assert.match(firstState.installationId, /^ski_[A-Za-z0-9_-]{20,80}$/);

  const second = fixture("1.1.0");
  second.files.set("SKILL.md", Buffer.from("---\nname: relay\ndescription: updated\n---\n"));
  second.manifest.files.find((entry) => entry.path === "SKILL.md").sha256 = digest(second.files.get("SKILL.md"));
  fs.writeFileSync(path.join(directory, "MY-NOTES.md"), "keep me\n");
  const protectedAddition = await skill.installManifest(second.manifest, (entry) => second.files.get(entry.path), { targets: target, env });
  assert.equal(protectedAddition.results[0].status, "modified");
  assert.deepEqual(protectedAddition.results[0].changedFiles, ["MY-NOTES.md"]);
  fs.rmSync(path.join(directory, "MY-NOTES.md"));
  // A rollback copy an earlier installer left beside the skill: hosts load any
  // sibling with a SKILL.md as a second skill, so an update removes it.
  const legacyRollback = path.join(path.dirname(directory), ".relay-rollback");
  fs.mkdirSync(legacyRollback, { recursive: true });
  fs.writeFileSync(path.join(legacyRollback, "SKILL.md"), "---\nname: relay\ndescription: stale copy\n---\n");
  const updated = await skill.installManifest(second.manifest, (entry) => second.files.get(entry.path), { targets: target, env });
  assert.equal(updated.ok, true);
  assert.equal(updated.results[0].status, "updated");
  assert.equal(skill.readState(directory).version, "1.1.0");
  assert.equal(skill.readState(directory).installationId, firstState.installationId);
  // The previous tree is kept outside the host's skills folder, keyed by target.
  const rollback = skill.rollbackPathFor(directory, { env });
  assert.equal(updated.results[0].rollback, rollback);
  assert.ok(rollback.startsWith(path.join(root, ".relay", "skill-rollback")));
  assert.equal(skill.readState(rollback).version, "1.0.0");
  assert.equal(fs.existsSync(legacyRollback), false, "the sibling copy is gone");
  assert.deepEqual(fs.readdirSync(path.dirname(directory)), ["relay"], "the skills folder holds only the skill");

  const refusedDowngrade = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target, env });
  assert.equal(refusedDowngrade.ok, true);
  assert.equal(refusedDowngrade.results[0].status, "downgrade_refused");
  assert.equal(skill.readState(directory).version, "1.1.0");
  let remoteFetches = 0;
  const refusedRemoteDowngrade = await skill.updateFromRemote({
    manifestUrl: "https://sendrelays.com/skills/relay/manifest.json",
    targets: target,
    fetchImpl: async (url) => {
      remoteFetches += 1;
      assert.equal(url, "https://sendrelays.com/skills/relay/manifest.json");
      return new Response(JSON.stringify(first.manifest), { status: 200 });
    },
  });
  assert.equal(refusedRemoteDowngrade.results[0].status, "downgrade_refused");
  assert.equal(remoteFetches, 1, "a refused downgrade must not fetch its files");

  fs.appendFileSync(path.join(directory, "SKILL.md"), "local rollback edit\n");
  const protectedRollback = skill.rollbackOne(directory, { env });
  assert.equal(protectedRollback.status, "modified");
  fs.writeFileSync(path.join(directory, "SKILL.md"), second.files.get("SKILL.md"));
  const rolledBack = skill.rollbackOne(directory, { env });
  assert.equal(rolledBack.ok, true);
  assert.equal(skill.readState(directory).version, "1.0.0");
  assert.equal(fs.existsSync(rollback), false, "the copy moved back into place");
  assert.equal(skill.rollbackOne(directory, { env }).status, "no_rollback");

  // A copy left beside the skill by an earlier installer still rolls back once.
  fs.mkdirSync(legacyRollback, { recursive: true });
  for (const [file, bytes] of second.files) {
    fs.mkdirSync(path.dirname(path.join(legacyRollback, file)), { recursive: true });
    fs.writeFileSync(path.join(legacyRollback, file), bytes);
  }
  fs.copyFileSync(path.join(directory, ".relay-managed.json"), path.join(legacyRollback, ".relay-managed.json"));
  const legacyState = JSON.parse(fs.readFileSync(path.join(legacyRollback, ".relay-managed.json"), "utf8"));
  legacyState.version = "1.1.0";
  legacyState.files = second.manifest.files;
  fs.writeFileSync(path.join(legacyRollback, ".relay-managed.json"), JSON.stringify(legacyState));
  const legacyRolledBack = skill.rollbackOne(directory, { env });
  assert.equal(legacyRolledBack.ok, true);
  assert.equal(skill.readState(directory).version, "1.1.0");
  assert.equal(fs.existsSync(legacyRollback), false);
});

test("managed Relay skill refuses checksum failures, user edits, and new consent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "relay");
  const targets = [{ host: "codex", directory }];
  const first = fixture();
  await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets, consent: true });

  const renewed = fixture("1.1.0", 2);
  const consent = await skill.installManifest(renewed.manifest, (entry) => renewed.files.get(entry.path), { targets });
  assert.equal(consent.results[0].status, "renewed_consent_required");

  fs.appendFileSync(path.join(directory, "SKILL.md"), "human edit\n");
  const modified = await skill.installManifest(renewed.manifest, (entry) => renewed.files.get(entry.path), { targets, renewConsent: true });
  assert.equal(modified.results[0].status, "modified");
  assert.deepEqual(modified.results[0].changedFiles, ["SKILL.md"]);

  const otherDirectory = path.join(root, "other-relay");
  const checksum = await skill.installManifest(first.manifest, () => Buffer.from("tampered"), {
    targets: [{ host: "claude", directory: otherDirectory }],
    consent: true,
  });
  assert.equal(checksum.ok, false);
  assert.match(checksum.results[0].error, /modified skill file/);
  assert.equal(fs.existsSync(otherDirectory), false);
});

test("managed Relay skill uninstall removes owned trees, rollback copies, and empty debris", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-uninstall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "skills", "relay");
  const env = { RELAY_CONFIG_DIR: path.join(root, ".relay") };
  const targets = [{ host: "codex", directory }];
  const first = fixture("1.0.0");
  const second = fixture("1.1.0");
  second.files.set("SKILL.md", Buffer.from("---\nname: relay\ndescription: updated\n---\n"));
  second.manifest.files.find((entry) => entry.path === "SKILL.md").sha256 = digest(second.files.get("SKILL.md"));

  await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets, consent: true, env });
  await skill.installManifest(second.manifest, (entry) => second.files.get(entry.path), { targets, env });
  const rollback = skill.rollbackPathFor(directory, { env });
  assert.ok(fs.existsSync(rollback), "the update kept a rollback copy");
  const legacyRollback = path.join(path.dirname(directory), ".relay-rollback");
  const emptyDebris = path.join(path.dirname(directory), ".relay-staging-interrupted");
  const unrelated = path.join(path.dirname(directory), "keep");
  fs.mkdirSync(path.join(legacyRollback, "nested"), { recursive: true });
  fs.mkdirSync(path.join(emptyDebris, "nested"), { recursive: true });
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "notes.txt"), "keep\n");
  fs.rmSync(path.join(directory, "scripts", "relay-protocol.mjs"));

  const removed = skill.uninstallManaged({ targets, env });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(directory), false, "partially removed managed tree is finished");
  assert.equal(fs.existsSync(rollback), false, "verified rollback copy is removed");
  assert.equal(fs.existsSync(legacyRollback), false, "an old sibling rollback copy is removed");
  assert.equal(fs.existsSync(emptyDebris), false, "empty generated debris is removed");
  assert.equal(fs.readFileSync(path.join(unrelated, "notes.txt"), "utf8"), "keep\n");

  const repeated = skill.uninstallManaged({ targets, env });
  assert.equal(repeated.ok, true, "uninstall is idempotent");
  assert.ok(repeated.results.every((result) => result.status === "already_absent"));
});

test("managed Relay skill uninstall refuses modified and unmanaged skill data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-uninstall-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedDirectory = path.join(root, "managed", "relay");
  const unmanagedDirectory = path.join(root, "unmanaged", "relay");
  const first = fixture();
  await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), {
    targets: [{ host: "codex", directory: managedDirectory }],
    consent: true,
  });
  fs.appendFileSync(path.join(managedDirectory, "SKILL.md"), "human edit\n");
  fs.mkdirSync(unmanagedDirectory, { recursive: true });
  fs.writeFileSync(path.join(unmanagedDirectory, "SKILL.md"), "human-owned\n");

  const result = skill.uninstallManaged({ targets: [
    { host: "codex", directory: managedDirectory },
    { host: "claude", directory: unmanagedDirectory },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures.find((item) => item.directory === managedDirectory).status, "modified");
  assert.deepEqual(result.failures.find((item) => item.directory === managedDirectory).changedFiles, ["SKILL.md"]);
  assert.equal(result.failures.find((item) => item.directory === unmanagedDirectory).status, "unmanaged");
  assert.equal(fs.existsSync(path.join(managedDirectory, ".relay-managed.json")), true, "ownership state is preserved");
  assert.equal(fs.readFileSync(path.join(unmanagedDirectory, "SKILL.md"), "utf8"), "human-owned\n");
});

test("bundled Relay skill manifest matches every shipped file", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
  const manifest = skill.parseManifest(fs.readFileSync(path.join(root, "skill", "manifest.json")));
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, "skill", "relay", ...entry.path.split("/")));
    assert.equal(digest(bytes), entry.sha256, entry.path);
  }
});
