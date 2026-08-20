import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "relay.js");
const expected = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;

for (const command of ["version", "--version", "-v"]) {
  test(`relay ${command} prints only the package version`, () => {
    const result = spawnSync(process.execPath, [bin, command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${expected}\n`);
  });
}
