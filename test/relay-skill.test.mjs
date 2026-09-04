import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skill = require("../bootstrap/relay-skill.cjs");

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
  const target = [{ host: "codex", directory }];
  const first = fixture("1.0.0");

  const refused = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target });
  assert.equal(refused.ok, false);
  assert.equal(refused.results[0].status, "consent_required");

  const installed = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target, consent: true });
  assert.equal(installed.ok, true);
  assert.equal(installed.results[0].status, "installed");
  assert.equal(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"), first.files.get("SKILL.md").toString());
  assert.equal(skill.readState(directory).version, "1.0.0");

  const second = fixture("1.1.0");
  second.files.set("SKILL.md", Buffer.from("---\nname: relay\ndescription: updated\n---\n"));
  second.manifest.files.find((entry) => entry.path === "SKILL.md").sha256 = digest(second.files.get("SKILL.md"));
  fs.writeFileSync(path.join(directory, "MY-NOTES.md"), "keep me\n");
  const protectedAddition = await skill.installManifest(second.manifest, (entry) => second.files.get(entry.path), { targets: target });
  assert.equal(protectedAddition.results[0].status, "modified");
  assert.deepEqual(protectedAddition.results[0].changedFiles, ["MY-NOTES.md"]);
  fs.rmSync(path.join(directory, "MY-NOTES.md"));
  const updated = await skill.installManifest(second.manifest, (entry) => second.files.get(entry.path), { targets: target });
  assert.equal(updated.ok, true);
  assert.equal(updated.results[0].status, "updated");
  assert.equal(skill.readState(directory).version, "1.1.0");

  const refusedDowngrade = await skill.installManifest(first.manifest, (entry) => first.files.get(entry.path), { targets: target });
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
  const protectedRollback = skill.rollbackOne(directory);
  assert.equal(protectedRollback.status, "modified");
  fs.writeFileSync(path.join(directory, "SKILL.md"), second.files.get("SKILL.md"));
  const rolledBack = skill.rollbackOne(directory);
  assert.equal(rolledBack.ok, true);
  assert.equal(skill.readState(directory).version, "1.0.0");
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

test("bundled Relay skill manifest matches every shipped file", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
  const manifest = skill.parseManifest(fs.readFileSync(path.join(root, "skill", "manifest.json")));
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, "skill", "relay", ...entry.path.split("/")));
    assert.equal(digest(bytes), entry.sha256, entry.path);
  }
});
