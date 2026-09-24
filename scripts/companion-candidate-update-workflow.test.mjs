import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/verify-companion-candidate-update.yml", import.meta.url), "utf8");
const trigger = fs.readFileSync(new URL("./trigger-stock-candidate-update.mjs", import.meta.url), "utf8");

test("candidate update canary never moves a fleet channel", () => {
  assert.doesNotMatch(workflow, /npm\s+dist-tag\s+(?:add|rm)/);
  assert.doesNotMatch(workflow, /relay\s+env\s+(?:dev|staging|stable)/);
  assert.match(workflow, /dist-tags\.build/);
  for (const tag of ["latest", "installer", "dev", "staging"]) {
    assert.match(workflow, new RegExp(`dist-tags\\.${tag}`));
  }
});

test("candidate update canary drives the unmodified stock updater seam", () => {
  assert.match(trigger, /path\.join\(packageRoot, "src", "auto-update\.js"\)/);
  assert.match(trigger, /getLatestVersion: async \(\) => targetVersion/);
  assert.match(trigger, /packageJson\.version !== currentVersion/);
  assert.doesNotMatch(trigger, /explicitRepair:\s*true/);
  assert.doesNotMatch(trigger, /writeFile|appendFile|rmSync|unlinkSync/);
  assert.match(trigger, /request\?\.state !== "completed" \|\| request\?\.result\?\.ok !== true/);
  assert.match(trigger, /process\.kill\(workerPid, 0\)/);
  assert.match(workflow, /"\$host_node" "\$legacy_bin" install --claim/);
  assert.match(workflow, /launchctl bootout "\$domain\/work\.relay\.companion"/);
  assert.match(workflow, /\[ "\$entry_shape" = legacy \] && \[ "\$current" = "\$FROM_VERSION" \]/);
});
