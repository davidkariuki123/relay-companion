import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  cleanupMacUpdateAgents,
  MAC_UPDATE_AGENT_LABEL,
  updateAgentJobsFromLaunchctl,
  updateAgentLabelsFromLaunchctl,
} from "../src/update-agent-cleanup.js";

test("launchctl parsing selects only Relay update agents", () => {
  assert.deepEqual(updateAgentLabelsFromLaunchctl([
    `123\t0\t${MAC_UPDATE_AGENT_LABEL}`,
    `-\t0\t${MAC_UPDATE_AGENT_LABEL}.1700000000`,
    `22\t0\t${MAC_UPDATE_AGENT_LABEL}.request-abc`,
    "1\t0\twork.relay.companion",
    "2\t0\twork.relay.companion.updated",
  ].join("\n")), [
    MAC_UPDATE_AGENT_LABEL,
    `${MAC_UPDATE_AGENT_LABEL}.1700000000`,
    `${MAC_UPDATE_AGENT_LABEL}.request-abc`,
  ]);
  assert.deepEqual(updateAgentJobsFromLaunchctl([
    `123\t0\t${MAC_UPDATE_AGENT_LABEL}`,
    `-\t0\t${MAC_UPDATE_AGENT_LABEL}.idle`,
  ].join("\n")), [
    { label: MAC_UPDATE_AGENT_LABEL, pid: 123 },
    { label: `${MAC_UPDATE_AGENT_LABEL}.idle`, pid: null },
  ]);
});

test("cleanup unloads fixed and suffixed jobs and deletes every historical plist", () => {
  const calls = [];
  const deleted = [];
  const homeDir = "/Users/test";
  const result = cleanupMacUpdateAgents({
    platform: "darwin",
    homeDir,
    userId: 501,
    parentPid: 999,
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "list") {
        return { status: 0, stdout: `77\t0\t${MAC_UPDATE_AGENT_LABEL}\n-\t0\t${MAC_UPDATE_AGENT_LABEL}.old\n` };
      }
      if (args[0] === "print") return { status: 113, stdout: "" };
      return { status: 0, stdout: "" };
    },
    fsImpl: {
      readdirSync(directory) {
        if (directory.endsWith("LaunchAgents")) return [`${MAC_UPDATE_AGENT_LABEL}.old.plist`, "other.plist"];
        return ["update-worker-old.plist", "current.json"];
      },
      unlinkSync(file) { deleted.push(file); },
    },
  });

  assert.equal(result.ok, true);
  for (const label of [MAC_UPDATE_AGENT_LABEL, `${MAC_UPDATE_AGENT_LABEL}.old`]) {
    assert.ok(calls.some((call) => call.join(" ") === `/bin/launchctl bootout gui/501/${label}`));
    assert.ok(calls.some((call) => call.join(" ") === `/bin/launchctl remove ${label}`));
  }
  assert.deepEqual(deleted.sort(), [
    path.posix.join(homeDir, ".relay/runtime/update-worker-old.plist"),
    path.posix.join(homeDir, ".relay/runtime/update-worker.plist"),
    path.posix.join(homeDir, `Library/LaunchAgents/${MAC_UPDATE_AGENT_LABEL}.old.plist`),
    path.posix.join(homeDir, `Library/LaunchAgents/${MAC_UPDATE_AGENT_LABEL}.plist`),
  ].sort());
});

test("repair inside the admitted worker preserves only that live worker", () => {
  const calls = [];
  const deleted = [];
  const result = cleanupMacUpdateAgents({
    platform: "darwin",
    homeDir: "/Users/test",
    userId: 501,
    preserveCurrentWorker: true,
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "list") {
        return { status: 0, stdout: `81\t0\t${MAC_UPDATE_AGENT_LABEL}\n82\t0\t${MAC_UPDATE_AGENT_LABEL}.old\n` };
      }
      if (args[0] === "print") return { status: 113, stdout: "" };
      return { status: 0, stdout: "" };
    },
    fsImpl: {
      readdirSync() { return []; },
      unlinkSync(file) { deleted.push(file); },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.includes(`gui/501/${MAC_UPDATE_AGENT_LABEL}`)), false);
  assert.ok(calls.some((call) => call.includes(`${MAC_UPDATE_AGENT_LABEL}.old`)));
  assert.equal(deleted.includes("/Users/test/.relay/runtime/update-worker.plist"), false);
  assert.ok(deleted.includes(`/Users/test/Library/LaunchAgents/${MAC_UPDATE_AGENT_LABEL}.plist`));
});

test("repair launched by a pre-contract updater preserves its parent worker", () => {
  const calls = [];
  const deleted = [];
  const result = cleanupMacUpdateAgents({
    platform: "darwin",
    homeDir: "/Users/test",
    userId: 501,
    preserveCurrentWorker: false,
    parentPid: 81,
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "list") {
        return { status: 0, stdout: `81\t0\t${MAC_UPDATE_AGENT_LABEL}\n82\t0\t${MAC_UPDATE_AGENT_LABEL}.old\n` };
      }
      if (args[0] === "print") return { status: 113, stdout: "" };
      return { status: 0, stdout: "" };
    },
    fsImpl: {
      readdirSync() { return []; },
      unlinkSync(file) { deleted.push(file); },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.preserveCurrentWorker, true);
  assert.equal(calls.some((call) => call.includes(`gui/501/${MAC_UPDATE_AGENT_LABEL}`)), false);
  assert.ok(calls.some((call) => call.includes(`${MAC_UPDATE_AGENT_LABEL}.old`)));
  assert.equal(deleted.includes("/Users/test/.relay/runtime/update-worker.plist"), false);
});

test("cleanup fails visibly when launchd cannot be enumerated", () => {
  const result = cleanupMacUpdateAgents({
    platform: "darwin",
    homeDir: "/Users/test",
    runCommand(command, args) {
      if (args[0] === "list") return { status: 1, stderr: "domain unavailable" };
      if (args[0] === "print") return { status: 113 };
      return { status: 0 };
    },
    fsImpl: {
      readdirSync() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      unlinkSync() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].detail, /domain unavailable/);
});
