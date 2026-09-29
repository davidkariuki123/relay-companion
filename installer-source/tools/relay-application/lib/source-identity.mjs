import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
export function verifySourceSnapshot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.repository, "davidkariuki123/relay");
  assert.match(manifest.sourceSha || "", /^[a-f0-9]{40}$/);
  assert.ok(Object.keys(manifest.files || {}).length > 0);
  for (const [file, blob] of Object.entries(manifest.files)) {
    assert.ok(/^(tools\/relay-application|packages\/companion)\//.test(file) && !file.split("/").includes("..") && !file.includes("\\"));
    const target = path.join(directory, file);
    let parent = path.dirname(target);
    while (parent !== path.resolve(directory)) {
      assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
      parent = path.dirname(parent);
    }
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(gitBlob(fs.readFileSync(target)), blob, `Exported source differs: ${file}`);
  }
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // npm installs are outside the source receipt and package-lock is checked.
      if (entry.name === "node_modules" && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name), relative = path.relative(directory, full).split(path.sep).join("/");
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) walk(full);
      else assert.ok(relative === "source.json" || manifest.files[relative], `Unexpected exported source: ${relative}`);
    }
  };
  walk(path.resolve(directory));
  return manifest;
}
export function packagingIdentity(toolRoot) {
  const sourceRoot = path.resolve(toolRoot, "../..");
  const git = args => execFileSync("git", args, { cwd: toolRoot, encoding: "utf8" }).trim();
  const head = git(["rev-parse", "HEAD"]);
  if (fs.existsSync(path.join(sourceRoot, "source.json"))) {
    const snapshot = verifySourceSnapshot(sourceRoot);
    assert.equal(git(["status", "--porcelain", "--", "../.."]), "", "Public installer source must be clean");
    return { packagingSourceSha: snapshot.sourceSha, packagingPublicSourceSha: head, packagingSourceDirty: false };
  }
  return { packagingSourceSha: head,
    packagingSourceDirty: Boolean(git(["status", "--porcelain", "--", ".", "../../packages/companion/bootstrap", "../../packages/companion/scripts/verify-runtime-manifest.mjs"])) };
}
