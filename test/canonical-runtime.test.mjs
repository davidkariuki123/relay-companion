import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalOwnershipGuard,
  canonicalRuntimeLayout,
  isCanonicalPackageRoot,
  readCanonicalRuntime,
  readCanonicalRuntimeState,
  reconcileCanonicalRuntimeNode,
  recoverCanonicalRuntime,
  pruneCanonicalReleases,
  repairCanonicalRuntime,
} from "../src/canonical-runtime.js";

// These integration cases deliberately exercise POSIX permissions and atomic
// rename behavior on the host filesystem. Keep them active on macOS/Linux and
// use the injected Windows filesystem fixture below for the Windows contract.
const posixFsTest = process.platform === "win32" ? test.skip : test;

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-canonical-"));
}

function seedCandidate(packageRoot, version, { platform = "linux", fsImpl = fs } = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const write = (relative, contents = "", mode = 0o600) => {
    const file = api.join(packageRoot, relative);
    fsImpl.mkdirSync(api.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, contents, { mode });
  };
  write("package.json", `${JSON.stringify({ name: "relay-companion", version })}\n`);
  write(api.join("bin", "relay.js"), "// relay\n", 0o700);
  write(api.join("src", "task-daemon.js"), "// daemon\n");
  write(api.join("overlay", "main.cjs"), "// pill\n");
  write(platform === "win32"
    ? api.join("node_modules", "electron", "dist", "electron.exe")
    : api.join("node_modules", "electron", "dist", "electron"), "", 0o700);
}

function existingPointer(homeDir, version = "0.1.240", platform = "linux", fsImpl = fs) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const layout = canonicalRuntimeLayout({ homeDir, platform, releaseId: `old-${version}` });
  const pointer = {
    schema: 1,
    active: true,
    version,
    releaseId: layout.releaseId,
    releaseRoot: layout.releaseRoot,
    packageRoot: layout.packageRoot,
    bin: layout.bin,
    node: process.execPath,
    committedAt: 1,
  };
  fsImpl.mkdirSync(api.dirname(layout.pointerPath), { recursive: true });
  fsImpl.writeFileSync(layout.pointerPath, `${JSON.stringify(pointer)}\n`);
  return pointer;
}

test("runtime repair atomically replaces a stale pointer Node without changing release identity", () => {
  const homeDir = fixture();
  const platform = process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const previous = existingPointer(homeDir, "0.1.240", platform);
  const durableNode = api.join(homeDir, ".relay", "runtime", "node", platform === "win32" ? "node.exe" : "node");
  const result = reconcileCanonicalRuntimeNode({
    node: durableNode,
    homeDir,
    platform,
    now: () => 42,
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const current = readCanonicalRuntime({ homeDir, platform });
  assert.equal(current.node, durableNode);
  assert.equal(current.packageRoot, previous.packageRoot);
  assert.equal(current.releaseId, previous.releaseId);
  assert.equal(current.repairedAt, 42);
});

test("runtime repair updates the active pointer even when invoked by another install tree", () => {
  const homeDir = fixture();
  const platform = process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const previous = existingPointer(homeDir, "0.1.240", platform);
  const other = reconcileCanonicalRuntimeNode({
    node: api.join(homeDir, "durable", platform === "win32" ? "node.exe" : "node"),
    homeDir,
    platform,
  });
  assert.equal(other.changed, true);
  const current = readCanonicalRuntime({ homeDir, platform });
  assert.equal(current.bin, previous.bin);
  assert.equal(current.packageRoot, previous.packageRoot);
  assert.equal(current.releaseId, previous.releaseId);
});

test("runtime repair never overwrites an activation journal", () => {
  const homeDir = fixture();
  const platform = process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const previous = existingPointer(homeDir, "0.1.240", platform);
  const layout = canonicalRuntimeLayout({ homeDir, platform });
  fs.writeFileSync(layout.pointerPath, `${JSON.stringify({
    schema: 1,
    active: false,
    state: "activating",
    candidate: previous,
    previous,
  })}\n`);
  const journal = fs.readFileSync(layout.pointerPath, "utf8");
  const active = reconcileCanonicalRuntimeNode({
    node: api.join(homeDir, "durable", platform === "win32" ? "node.exe" : "node"),
    homeDir,
    platform,
  });
  assert.equal(active.reason, "canonical-transaction-active");
  assert.equal(fs.readFileSync(layout.pointerPath, "utf8"), journal);
});

async function runPosix({ homeDir, version = "0.1.241", ...overrides } = {}) {
  return repairCanonicalRuntime({
    homeDir,
    platform: "linux",
    version,
    now: () => 100,
    nonce: () => "test",
    installCandidate: ({ stagingRoot }) => {
      seedCandidate(path.join(stagingRoot, "node_modules", "relay-companion"), version);
      return { ok: true };
    },
    ...overrides,
  });
}

posixFsTest("POSIX success verifies staging, atomically commits an immutable release, then activates", async () => {
  const homeDir = fixture();
  const legacy = path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "sentinel"), "do-not-touch");
  const events = [];
  const result = await runPosix({
    homeDir,
    preCommitVerify: async (candidate) => {
      events.push("pre");
      assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }), null);
      assert.match(candidate.packageRoot, /\.staging/);
      return { ok: true };
    },
    postCommitActivate: async (candidate) => {
      events.push("post");
      assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }), null, "activating journal is never authoritative");
      const journal = JSON.parse(fs.readFileSync(canonicalRuntimeLayout({ homeDir, platform: "linux" }).pointerPath, "utf8"));
      assert.equal(journal.state, "activating");
      assert.equal(journal.candidate.packageRoot, candidate.packageRoot);
      assert.doesNotMatch(candidate.packageRoot, /\.staging/);
      return { ok: true, exactRootHealthy: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["pre", "post"]);
  assert.equal(fs.readFileSync(path.join(legacy, "sentinel"), "utf8"), "do-not-touch");
  assert.equal(fs.existsSync(result.candidate.packageRoot), true);
  assert.equal(result.candidate.electronPath.startsWith(result.candidate.packageRoot), true);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).packageRoot, result.candidate.packageRoot);
});

for (const fault of ["install", "verify", "pre-commit"]) {
  posixFsTest(`POSIX ${fault} failure never changes the callable current release`, async () => {
    const homeDir = fixture();
    const previous = existingPointer(homeDir);
    let activated = false;
    const overrides = {
      postCommitActivate: async () => { activated = true; return { ok: true }; },
    };
    if (fault === "install") overrides.installCandidate = async () => ({ ok: false, detail: "network" });
    if (fault === "verify") overrides.installCandidate = async () => ({ ok: true });
    if (fault === "pre-commit") overrides.preCommitVerify = async () => ({ ok: false, reason: "smoke" });
    const result = await runPosix({ homeDir, ...overrides });
    assert.equal(result.ok, false);
    assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).packageRoot, previous.packageRoot);
    assert.equal(activated, false);
  });
}

for (const activation of ["returned failure", "threw"]) {
  posixFsTest(`POSIX activation ${activation} restores pointer and runs rollback activation`, async () => {
    const homeDir = fixture();
    const previous = existingPointer(homeDir);
    let rollback = null;
    const result = await runPosix({
      homeDir,
      postCommitActivate: async () => {
        if (activation === "threw") throw new Error("restart failed");
        return { ok: false, reason: "exact-root-unhealthy" };
      },
      rollbackActivate: async (target, context) => {
        rollback = { target, context };
        return { ok: true };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).packageRoot, previous.packageRoot);
    assert.equal(rollback.target.packageRoot, previous.packageRoot);
    // This used to assert the opposite ("retained for forensics"). At ~650MB per
    // candidate and one candidate per attempt, retention was Bug 4: 37 duplicates
    // / 24GB in 25 minutes on a machine whose activation could not succeed. The
    // rollback has completed and the pointer no longer references the tree — it
    // is debris, and a failing machine must converge to a bounded footprint.
    // Forensics live in update.log and the durable failure records.
    assert.equal(fs.existsSync(result.candidate.packageRoot), false, "failed candidate release is removed after a clean rollback");
  });
}

posixFsTest("a failed activation prunes older stranded releases too", async () => {
  const homeDir = fixture();
  const previous = existingPointer(homeDir);
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  // Debris from three earlier failed attempts at some other version.
  const strandedNames = ["0.1.239-1-1-aa", "0.1.239-2-2-bb", "0.1.239-3-3-cc"];
  for (const name of strandedNames) {
    seedCandidate(path.join(layout.releasesDir, name, "node_modules", "relay-companion"), "0.1.239");
  }
  const result = await runPosix({
    homeDir,
    postCommitActivate: async () => ({ ok: false, reason: "exact-root-unhealthy" }),
    rollbackActivate: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  const left = fs.readdirSync(layout.releasesDir);
  assert.equal(left.includes(result.candidate.releaseId), false, "failed candidate removed");
  // active pointer's release is name-protected; of the three stranded trees only
  // the single most recent forensic survivor may remain.
  const strandedLeft = left.filter((name) => strandedNames.includes(name));
  assert.equal(strandedLeft.length <= 1, true, `stranded releases pruned on failure, saw: ${left.join(", ")}`);
});

posixFsTest("a rollback that fails keeps the candidate tree for recovery", async () => {
  const homeDir = fixture();
  existingPointer(homeDir);
  const result = await runPosix({
    homeDir,
    postCommitActivate: async () => ({ ok: false, reason: "exact-root-unhealthy" }),
    rollbackActivate: async () => ({ ok: false, reason: "still-broken" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  // recovery re-runs through this tree (repairExecutable) and may adopt it outright.
  assert.equal(fs.existsSync(result.candidate.packageRoot), true, "recovery-required keeps the candidate");
});

posixFsTest("an existing verifying release of the target version is adopted instead of reinstalled", async () => {
  const homeDir = fixture();
  existingPointer(homeDir);
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const strandedId = "0.1.241-9999-1-earlier";
  seedCandidate(path.join(layout.releasesDir, strandedId, "node_modules", "relay-companion"), "0.1.241");
  let installed = false;
  const result = await runPosix({
    homeDir,
    installCandidate: async () => { installed = true; return { ok: true }; },
    postCommitActivate: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(installed, false, "no reinstall when a verifying release already exists (~650MB and npm-minutes per skip)");
  assert.equal(result.candidate.releaseId, strandedId);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).releaseRoot, path.join(layout.releasesDir, strandedId));
});

posixFsTest("adoption never claims the active release or a process-referenced one", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  // The CURRENT pointer is at the target version (a same-version repair): its own
  // release and a live process's release must not be adopted as candidates.
  const activeId = "0.1.241-1000-1-active";
  const busyId = "0.1.241-2000-1-busy";
  for (const id of [activeId, busyId]) {
    seedCandidate(path.join(layout.releasesDir, id, "node_modules", "relay-companion"), "0.1.241");
  }
  const activeLayout = canonicalRuntimeLayout({ homeDir, platform: "linux", releaseId: activeId });
  fs.mkdirSync(path.dirname(activeLayout.pointerPath), { recursive: true });
  fs.writeFileSync(activeLayout.pointerPath, `${JSON.stringify({
    schema: 1, active: true, version: "0.1.241", releaseId: activeId,
    releaseRoot: activeLayout.releaseRoot, packageRoot: activeLayout.packageRoot,
    bin: activeLayout.bin, node: process.execPath, committedAt: 1,
  })}\n`);
  let installed = false;
  const result = await runPosix({
    homeDir,
    protectedPackageRoots: [path.join(layout.releasesDir, busyId, "node_modules", "relay-companion")],
    installCandidate: ({ stagingRoot }) => {
      installed = true;
      seedCandidate(path.join(stagingRoot, "node_modules", "relay-companion"), "0.1.241");
      return { ok: true };
    },
    postCommitActivate: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(installed, true, "active and process-referenced releases are excluded from adoption");
  assert.notEqual(result.candidate.releaseId, activeId);
  assert.notEqual(result.candidate.releaseId, busyId);
});

posixFsTest("live transaction lock rejects a concurrent repair without touching current", async () => {
  const homeDir = fixture();
  const previous = existingPointer(homeDir);
  const { lockPath } = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
  let installed = false;
  const result = await runPosix({ homeDir, installCandidate: async () => { installed = true; return { ok: true }; } });
  assert.equal(result.reason, "transaction-in-progress");
  assert.equal(installed, false);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).packageRoot, previous.packageRoot);
});

posixFsTest("transaction admission exposes the durable request and worker identity", async () => {
  const homeDir = fixture();
  let owner = null;
  const result = await runPosix({
    homeDir,
    lockIdentity: { requestId: "request-123", workerId: "worker-456" },
    onLockAcquired: (value) => { owner = value; },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(owner.requestId, "request-123");
  assert.equal(owner.workerId, "worker-456");
  assert.equal(owner.pid, process.pid);
});

posixFsTest("ownership guard allows only the selected canonical release once current exists", () => {
  const homeDir = fixture();
  const current = existingPointer(homeDir);
  const external = path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion");
  const oldCanonical = canonicalRuntimeLayout({ homeDir, platform: "linux", releaseId: "older" }).packageRoot;
  assert.equal(isCanonicalPackageRoot(current.packageRoot, { homeDir, platform: "linux" }), true);
  assert.equal(canonicalOwnershipGuard(current.packageRoot, { homeDir, platform: "linux" }).mayClaim, true);
  assert.equal(canonicalOwnershipGuard(oldCanonical, { homeDir, platform: "linux" }).mayClaim, false);
  assert.equal(canonicalOwnershipGuard(external, { homeDir, platform: "linux" }).mayClaim, false);
});

posixFsTest("first migration retains an explicit legacy rollback target", async () => {
  const homeDir = fixture();
  const legacy = {
    kind: "legacy",
    packageRoot: path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion"),
    bin: path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion", "bin", "relay.js"),
    node: path.join(homeDir, ".hermes", "node", "bin", "node"),
    version: "0.1.240",
  };
  let restored = null;
  const result = await runPosix({
    homeDir,
    rollbackTarget: legacy,
    postCommitActivate: async () => ({ ok: false, reason: "candidate-unhealthy" }),
    rollbackActivate: async (target) => { restored = target; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(restored, legacy);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }), null);
});

posixFsTest("rollback failure preserves a non-authoritative recovery journal", async () => {
  const homeDir = fixture();
  const previous = existingPointer(homeDir);
  const result = await runPosix({
    homeDir,
    postCommitActivate: async () => ({ ok: false, reason: "candidate-unhealthy" }),
    rollbackActivate: async () => { throw new Error("old service could not restart"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }), null, "no runtime is falsely declared active");
  const recovery = readCanonicalRuntimeState({ homeDir, platform: "linux" });
  assert.equal(recovery.state, "recovery-required");
  assert.equal(recovery.candidate.packageRoot, result.candidate.packageRoot);
  assert.equal(recovery.previous.packageRoot, previous.packageRoot);
  assert.equal(recovery.failure.phase, "rollback");
});

for (const crashPoint of ["after-journal", "after-repair-runtime", "after-service-restart"]) {
  posixFsTest(`startup recovery restores previous runtime after crash ${crashPoint}`, async () => {
    const homeDir = fixture();
    const previous = existingPointer(homeDir);
    const candidateLayout = canonicalRuntimeLayout({ homeDir, platform: "linux", releaseId: "candidate" });
    const state = {
      schema: 1,
      state: "activating",
      active: false,
      candidate: {
        schema: 1,
        version: "0.1.241",
        releaseId: "candidate",
        releaseRoot: candidateLayout.releaseRoot,
        packageRoot: candidateLayout.packageRoot,
        bin: candidateLayout.bin,
        node: process.execPath,
        crashPoint,
      },
      previous,
    };
    fs.writeFileSync(canonicalRuntimeLayout({ homeDir, platform: "linux" }).pointerPath, JSON.stringify(state));
    let observedState = null;
    const result = await recoverCanonicalRuntime({
      homeDir,
      platform: "linux",
      rollbackActivate: async (target) => {
        observedState = readCanonicalRuntimeState({ homeDir, platform: "linux" });
        assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }), null);
        assert.equal(target.packageRoot, previous.packageRoot);
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(observedState.state, "activating", "journal stays durable throughout external rollback");
    assert.equal(readCanonicalRuntime({ homeDir, platform: "linux" }).packageRoot, previous.packageRoot);
  });
}

class MemoryWindowsFs {
  files = new Map();
  dirs = new Set();
  constructor() {
    for (const name of ["existsSync", "mkdirSync", "writeFileSync", "readFileSync", "renameSync", "rmSync", "statSync", "accessSync", "processAlive"]) {
      this[name] = this[name].bind(this);
    }
  }
  key(value) { return path.win32.resolve(value).toLowerCase(); }
  existsSync(value) {
    const key = this.key(value);
    return this.files.has(key) || this.dirs.has(key) || [...this.files].some(([name]) => name.startsWith(`${key}\\`));
  }
  mkdirSync(value) { this.dirs.add(this.key(value)); }
  writeFileSync(value, contents) { this.files.set(this.key(value), String(contents)); }
  readFileSync(value) {
    const found = this.files.get(this.key(value));
    if (found === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return found;
  }
  renameSync(from, to) {
    const source = this.key(from);
    const target = this.key(to);
    let moved = false;
    for (const [name, contents] of [...this.files]) {
      if (name === source || name.startsWith(`${source}\\`)) {
        this.files.delete(name);
        this.files.set(`${target}${name.slice(source.length)}`, contents);
        moved = true;
      }
    }
    for (const name of [...this.dirs]) {
      if (name === source || name.startsWith(`${source}\\`)) {
        this.dirs.delete(name);
        this.dirs.add(`${target}${name.slice(source.length)}`);
        moved = true;
      }
    }
    if (!moved) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  rmSync(value) {
    const prefix = this.key(value);
    for (const name of [...this.files.keys()]) if (name === prefix || name.startsWith(`${prefix}\\`)) this.files.delete(name);
    for (const name of [...this.dirs]) if (name === prefix || name.startsWith(`${prefix}\\`)) this.dirs.delete(name);
  }
  statSync(value) {
    if (!this.files.has(this.key(value))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isFile: () => true };
  }
  accessSync(value) {
    if (!this.files.has(this.key(value))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  processAlive() { return false; }
}

test("Windows fixture uses the same verify → pointer → activate invariant and rolls back", async () => {
  const fsImpl = new MemoryWindowsFs();
  const homeDir = "C:\\Users\\Relay User";
  const escapedHostArtifact = path.resolve("C:\\Users\\Relay User\\.relay\\runtime\\transaction.lock\\owner.json");
  assert.equal(fs.existsSync(escapedHostArtifact), false);
  const previous = existingPointer(homeDir, "0.1.240", "win32", fsImpl);
  let sawCandidatePointer = false;
  const result = await repairCanonicalRuntime({
    version: "0.1.241",
    homeDir,
    platform: "win32",
    fsImpl,
    now: () => 100,
    nonce: () => "test",
    installCandidate: ({ stagingRoot }) => {
      seedCandidate(path.win32.join(stagingRoot, "node_modules", "relay-companion"), "0.1.241", { platform: "win32", fsImpl });
      return { ok: true };
    },
    preCommitVerify: async () => {
      assert.equal(readCanonicalRuntime({ homeDir, platform: "win32", readFileSync: fsImpl.readFileSync.bind(fsImpl) }).packageRoot, previous.packageRoot);
      return { ok: true };
    },
    postCommitActivate: async (candidate) => {
      const current = readCanonicalRuntime({ homeDir, platform: "win32", readFileSync: fsImpl.readFileSync.bind(fsImpl) });
      const journal = JSON.parse(fsImpl.readFileSync(canonicalRuntimeLayout({ homeDir, platform: "win32" }).pointerPath));
      sawCandidatePointer = current === null && journal.state === "activating" && journal.candidate.packageRoot === candidate.packageRoot;
      return { ok: false, reason: "service-root-mismatch" };
    },
    rollbackActivate: async () => ({ ok: true }),
  });
  assert.equal(sawCandidatePointer, true);
  assert.equal(result.rolledBack, true);
  assert.equal(readCanonicalRuntime({ homeDir, platform: "win32", readFileSync: fsImpl.readFileSync.bind(fsImpl) }).packageRoot, previous.packageRoot);
  assert.equal(fs.existsSync(escapedHostArtifact), false, "injected Windows filesystem never falls through to host fs");
});

test("repair requires an exact version", async () => {
  assert.equal((await repairCanonicalRuntime({ version: "latest" })).reason, "exact-version-required");
  assert.equal((await repairCanonicalRuntime({ version: "^0.1.241" })).reason, "exact-version-required");
});

posixFsTest("28 immutable updates retain only active, previous, process-referenced, and one forensic release", () => {
  const homeDir = fixture();
  const { releasesDir } = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(releasesDir, { recursive: true });
  const releases = [];
  for (let index = 0; index < 28; index += 1) {
    const layout = canonicalRuntimeLayout({ homeDir, platform: "linux", releaseId: `release-${String(index).padStart(2, "0")}` });
    fs.mkdirSync(layout.packageRoot, { recursive: true });
    fs.writeFileSync(path.join(layout.packageRoot, "sentinel"), String(index));
    const stamp = new Date(1_000_000 + index * 1_000);
    fs.utimesSync(layout.releaseRoot, stamp, stamp);
    releases.push(layout);
  }
  const external = path.join(homeDir, ".hermes", "node", "lib", "node_modules", "relay-companion");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, "sentinel"), "external");
  const result = pruneCanonicalReleases({
    homeDir,
    platform: "linux",
    active: { releaseId: releases[27].releaseId },
    previous: { releaseId: releases[26].releaseId },
    protectedPackageRoots: [releases[12].packageRoot, external],
    retainRecent: 1,
  });
  assert.equal(result.ok, true);
  const remaining = fs.readdirSync(releasesDir).sort();
  assert.deepEqual(remaining, [releases[12].releaseId, releases[25].releaseId, releases[26].releaseId, releases[27].releaseId].sort());
  assert.equal(fs.readFileSync(path.join(external, "sentinel"), "utf8"), "external");
});

posixFsTest("lock filesystem failures return structured results from repair and recovery", async () => {
  const homeDir = fixture();
  const throwingFs = Object.create(fs);
  throwingFs.mkdirSync = () => { throw Object.assign(new Error("disk is read-only"), { code: "EROFS" }); };
  const repair = await repairCanonicalRuntime({ version: "0.1.241", homeDir, platform: "linux", fsImpl: throwingFs });
  assert.deepEqual(
    { ok: repair.ok, phase: repair.phase, reason: repair.reason },
    { ok: false, phase: "lock", reason: "transaction-lock-unavailable" },
  );

  const pointerPath = canonicalRuntimeLayout({ homeDir, platform: "linux" }).pointerPath;
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.writeFileSync(pointerPath, JSON.stringify({
    schema: 1,
    state: "activating",
    active: false,
    candidate: { releaseId: "candidate" },
    previous: null,
  }));
  const recovery = await recoverCanonicalRuntime({ homeDir, platform: "linux", fsImpl: throwingFs });
  assert.deepEqual(
    { ok: recovery.ok, phase: recovery.phase, reason: recovery.reason },
    { ok: false, phase: "lock", reason: "transaction-lock-unavailable" },
  );
});

// ---- the lock steal must not leave debris ---------------------------------
// Stealing a dead owner's lock renames it aside so the steal is atomic, then the
// renamed directory is garbage. The old code never deleted it, so every steal —
// and a failing transaction steals on every retry — leaked one directory into the
// runtime root: 11,015 of them on David's Mac in a single day.
posixFsTest("a stolen lock is deleted, and pre-existing stale locks are swept", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.root, { recursive: true });
  // a lock held by a pid that is definitely not alive
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({ pid: 2147483000, createdAt: 1 }));
  // debris an earlier build left behind
  for (const id of ["a", "b", "c"]) {
    fs.mkdirSync(`${layout.lockPath}.stale-1-${id}`, { recursive: true });
  }
  const result = await runPosix({ homeDir, processAlive: () => false });
  assert.equal(result.ok, true, `${result.phase}: ${result.reason}`);
  const leftover = fs.readdirSync(layout.root).filter((entry) => entry.startsWith("transaction.lock.stale-"));
  assert.deepEqual(leftover, [], `runtime root still holds ${leftover.length} stale lock directories`);
});

posixFsTest("a live owner still holds the lock rather than having it stolen", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  const result = await runPosix({ homeDir, processAlive: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-in-progress");
});

posixFsTest("a live transaction is never stolen because an elapsed-time deadline passed", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    createdAt: 1,
    requestId: "old-request",
    workerId: "old-worker",
  }));
  const result = await runPosix({
    homeDir,
    now: () => 20 * 60 * 1000 + 2,
    processAlive: () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-in-progress");
});

posixFsTest("an ownerless runtime lock without birth time fails closed after the legacy grace", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const now = Date.now();
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.utimesSync(layout.lockPath, new Date(now), new Date(now));
  const ownerlessFs = Object.create(fs);
  ownerlessFs.processIdentity = () => "";
  ownerlessFs.statSync = (file, options) => {
    const value = fs.statSync(file, options);
    return path.resolve(file) === path.resolve(layout.lockPath)
      ? { ...value, birthtimeNs: 0n, birthtimeMs: 0 }
      : value;
  };
  const result = await runPosix({ homeDir, now: () => now, fsImpl: ownerlessFs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-lock-unavailable");
  assert.equal(fs.existsSync(layout.lockPath), true);

  fs.utimesSync(layout.lockPath, new Date(now - (2 * 60 * 60_000 + 1)), new Date(now - (2 * 60 * 60_000 + 1)));
  const stillProtected = await runPosix({ homeDir, now: () => now, fsImpl: ownerlessFs });
  assert.equal(stillProtected.ok, false);
  assert.equal(stillProtected.reason, "transaction-in-progress");
  assert.equal(fs.existsSync(layout.lockPath), true);
});

posixFsTest("canonical runtime preserves a shared lock for a legacy bootstrap publisher", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const ownerPath = path.posix.join(layout.lockPath, "owner.json");
  const now = Date.now();
  const legacyOwner = JSON.stringify({ pid: process.pid, createdAt: now - 31_000 });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.utimesSync(layout.lockPath, new Date(now - 31_000), new Date(now - 31_000));
  const result = await runPosix({ homeDir, now: () => now });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-lock-unavailable");
  // The shipped bootstrap can resume its old non-exclusive publication because
  // canonical runtime retained the shared lock instead of replacing it.
  fs.writeFileSync(ownerPath, legacyOwner);
  assert.equal(fs.readFileSync(ownerPath, "utf8"), legacyOwner);
});

posixFsTest("an old ownerless runtime lock with trustworthy birth time is recovered", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const now = Date.now();
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.utimesSync(layout.lockPath, new Date(now - (2 * 60 * 60_000 + 1)), new Date(now - (2 * 60 * 60_000 + 1)));
  const result = await runPosix({ homeDir, now: () => now });
  assert.equal(result.ok, true, `${result.phase}: ${result.reason}`);
  assert.equal(fs.existsSync(layout.lockPath), false);
});

for (const incompleteOwner of [null, '{"pid":']) {
posixFsTest(`runtime recovery preserves an ambiguous replacement ${incompleteOwner === null ? "ownerless" : "partial-owner"} lock`, async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const reclaimPath = path.posix.join(layout.lockPath, "reclaim.json");
  const now = Date.now();
  fs.mkdirSync(layout.lockPath, { recursive: true });
  if (incompleteOwner !== null) fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), incompleteOwner);
  fs.utimesSync(layout.lockPath, new Date(now - (2 * 60 * 60_000 + 1)), new Date(now - (2 * 60 * 60_000 + 1)));
  const replacementFs = Object.create(fs);
  let replaced = false;
  replacementFs.processIdentity = () => "";
  replacementFs.statSync = (file, options) => {
    const value = fs.statSync(file, options);
    return path.resolve(file) === path.resolve(layout.lockPath)
      ? { ...value, dev: 1n, ino: 2n, birthtimeNs: 0n, birthtimeMs: 0 }
      : value;
  };
  replacementFs.writeFileSync = (file, bytes, options) => {
    fs.writeFileSync(file, bytes, options);
    if (!replaced && path.resolve(file) === path.resolve(reclaimPath)) {
      replaced = true;
      fs.rmSync(layout.lockPath, { recursive: true, force: true });
      fs.mkdirSync(layout.lockPath);
      if (incompleteOwner !== null) fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), incompleteOwner);
    }
  };
  const result = await runPosix({ homeDir, now: () => now, fsImpl: replacementFs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-in-progress");
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(layout.lockPath), true);
  assert.equal(fs.existsSync(reclaimPath), false);
});
}

posixFsTest("runtime recovery recognizes a reused Linux PID by process identity", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    nonce: "previous-process",
    createdAt: 100,
    processIdentity: "boot-a:100",
  }));
  const identityFs = Object.create(fs);
  identityFs.processAlive = () => true;
  identityFs.processIdentity = () => "boot-a:200";
  const result = await runPosix({ homeDir, fsImpl: identityFs });
  assert.equal(result.ok, true, `${result.phase}: ${result.reason}`);
  assert.equal(fs.existsSync(layout.lockPath), false);
});

posixFsTest("runtime recovery handles a valid dead owner without filesystem birth time", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({
    pid: 2147483000,
    nonce: "d".repeat(32),
    createdAt: 100,
  }));
  const zeroBirthFs = Object.create(fs);
  zeroBirthFs.processAlive = () => false;
  zeroBirthFs.processIdentity = () => "";
  zeroBirthFs.statSync = (file, options) => {
    const value = fs.statSync(file, options);
    return path.resolve(file) === path.resolve(layout.lockPath)
      ? { ...value, birthtimeNs: 0n, birthtimeMs: 0 }
      : value;
  };
  const result = await runPosix({ homeDir, fsImpl: zeroBirthFs });
  assert.equal(result.ok, true, `${result.phase}: ${result.reason}`);
});

posixFsTest("concurrent runtime recovery cannot displace the winning transaction", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({
    pid: 2147483000,
    nonce: "dead-transaction",
    createdAt: 100,
  }));
  const winnerFs = Object.create(fs);
  winnerFs.processAlive = () => false;
  winnerFs.processIdentity = () => "";
  const loserFs = Object.create(fs);
  let winnerPromise = null;
  let triggered = false;
  loserFs.processIdentity = () => "";
  loserFs.processAlive = (pid) => {
    if (!triggered) {
      triggered = true;
      winnerPromise = runPosix({ homeDir, fsImpl: winnerFs });
    }
    return pid === process.pid;
  };
  const loser = await runPosix({ homeDir, fsImpl: loserFs, version: "0.1.242" });
  const winner = await winnerPromise;
  assert.equal(winner.ok, true, `${winner.phase}: ${winner.reason}`);
  assert.equal(loser.ok, false);
  assert.equal(loser.reason, "transaction-in-progress");
  assert.equal(fs.existsSync(layout.lockPath), false);
});

posixFsTest("runtime recovery detects a replacement even when its inode is immediately reused", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify({
    pid: 2147483000,
    nonce: "dead-transaction",
    createdAt: 100,
  }));
  const replacementFs = Object.create(fs);
  let replaced = false;
  replacementFs.processIdentity = () => "";
  replacementFs.processAlive = () => {
    if (!replaced) {
      replaced = true;
      fs.rmSync(layout.lockPath, { recursive: true, force: true });
      fs.mkdirSync(layout.lockPath);
    }
    return false;
  };
  replacementFs.statSync = (file, options) => path.resolve(file) === path.resolve(layout.lockPath)
    ? { dev: 1n, ino: 2n, birthtimeNs: 3n, mtimeMs: 100n }
    : fs.statSync(file, options);
  const result = await runPosix({ homeDir, fsImpl: replacementFs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-in-progress");
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(layout.lockPath), true);
  assert.equal(fs.existsSync(path.posix.join(layout.lockPath, "reclaim.json")), false);
});

posixFsTest("a paused runtime owner cannot overwrite the successor of its empty lock", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const startedAt = Date.now();
  let unblockWinner;
  const winnerGate = new Promise((resolve) => { unblockWinner = resolve; });
  let winnerPromise = null;
  let intercepted = false;
  const winnerFs = Object.create(fs);
  winnerFs.processIdentity = () => "";
  const pausedFs = Object.create(fs);
  pausedFs.processIdentity = () => "";
  pausedFs.writeFileSync = (file, bytes, options) => {
    if (!intercepted && path.resolve(file) === path.resolve(path.posix.join(layout.lockPath, "owner.json"))) {
      intercepted = true;
      winnerPromise = runPosix({
        homeDir,
        fsImpl: winnerFs,
        now: () => startedAt + 2 * 60 * 60_000 + 1,
        onLockAcquired: async () => winnerGate,
      });
    }
    return fs.writeFileSync(file, bytes, options);
  };
  const paused = await runPosix({
    homeDir,
    fsImpl: pausedFs,
    now: () => startedAt,
    version: "0.1.242",
  });
  assert.equal(intercepted, true);
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, "transaction-lock-unavailable");
  const successor = JSON.parse(fs.readFileSync(path.posix.join(layout.lockPath, "owner.json"), "utf8"));
  assert.equal(successor.pid, process.pid);
  unblockWinner();
  const winner = await winnerPromise;
  assert.equal(winner.ok, true, `${winner.phase}: ${winner.reason}`);
});

posixFsTest("runtime publication yields to a reclaimer that already passed its owner snapshot", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const ownerPath = path.posix.join(layout.lockPath, "owner.json");
  const reclaimPath = path.posix.join(layout.lockPath, "reclaim.json");
  const claimBytes = JSON.stringify({ pid: process.pid, nonce: "a".repeat(32), createdAt: Date.now() });
  const claimedFs = Object.create(fs);
  claimedFs.processIdentity = () => "";
  claimedFs.writeFileSync = (file, bytes, options) => {
    if (path.resolve(file) === path.resolve(ownerPath)) {
      fs.writeFileSync(reclaimPath, claimBytes, { flag: "wx" });
    }
    fs.writeFileSync(file, bytes, options);
  };
  const result = await runPosix({ homeDir, fsImpl: claimedFs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-lock-unavailable");
  assert.equal(fs.existsSync(ownerPath), true);
  assert.equal(fs.readFileSync(reclaimPath, "utf8"), claimBytes);
});

posixFsTest("a runtime owner paused during publication cannot proceed after reclamation", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const ownerPath = path.posix.join(layout.lockPath, "owner.json");
  const startedAt = Date.now();
  let unblockWinner;
  const winnerGate = new Promise((resolve) => { unblockWinner = resolve; });
  let winnerPromise = null;
  let intercepted = false;
  let oldFd = null;
  const winnerFs = Object.create(fs);
  winnerFs.processIdentity = () => "";
  const pausedFs = Object.create(fs);
  pausedFs.processIdentity = () => "";
  pausedFs.writeFileSync = (file, bytes, options) => {
    if (!intercepted && path.resolve(file) === path.resolve(ownerPath)) {
      intercepted = true;
      oldFd = fs.openSync(file, options.flag, options.mode);
      fs.writeSync(oldFd, bytes.slice(0, 7));
      winnerPromise = runPosix({
        homeDir,
        fsImpl: winnerFs,
        now: () => startedAt + 2 * 60 * 60_000 + 1,
        onLockAcquired: async () => winnerGate,
      });
      fs.writeSync(oldFd, bytes.slice(7));
      fs.closeSync(oldFd);
      oldFd = null;
      return;
    }
    fs.writeFileSync(file, bytes, options);
  };
  try {
    const paused = await runPosix({
      homeDir,
      fsImpl: pausedFs,
      now: () => startedAt,
      version: "0.1.242",
    });
    assert.equal(intercepted, true);
    assert.equal(paused.ok, false);
    assert.equal(paused.reason, "transaction-lock-unavailable");
    const successor = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    assert.equal(successor.pid, process.pid);
    unblockWinner();
    const winner = await winnerPromise;
    assert.equal(winner.ok, true, `${winner.phase}: ${winner.reason}`);
  } finally {
    if (oldFd !== null) try { fs.closeSync(oldFd); } catch {}
    if (winnerPromise) {
      unblockWinner();
      try { await winnerPromise; } catch {}
    }
  }
});

posixFsTest("runtime recovery survives a dead reclaimer without stealing from a live one", async () => {
  const deadHome = fixture();
  const deadLayout = canonicalRuntimeLayout({ homeDir: deadHome, platform: "linux" });
  fs.mkdirSync(deadLayout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(deadLayout.lockPath, "owner.json"), JSON.stringify({
    pid: 2147483000,
    nonce: "dead-owner",
    createdAt: 100,
  }));
  fs.writeFileSync(path.posix.join(deadLayout.lockPath, "reclaim.json"), JSON.stringify({
    pid: 2147483001,
    nonce: "dead-reclaimer",
    createdAt: 100,
  }));
  const deadFs = Object.create(fs);
  deadFs.processAlive = () => false;
  deadFs.processIdentity = () => "";
  const recovered = await runPosix({ homeDir: deadHome, fsImpl: deadFs });
  assert.equal(recovered.ok, true, `${recovered.phase}: ${recovered.reason}`);

  const liveHome = fixture();
  const liveLayout = canonicalRuntimeLayout({ homeDir: liveHome, platform: "linux" });
  fs.mkdirSync(liveLayout.lockPath, { recursive: true });
  fs.writeFileSync(path.posix.join(liveLayout.lockPath, "owner.json"), JSON.stringify({
    pid: 2147483000,
    nonce: "dead-owner",
    createdAt: 100,
  }));
  const liveClaim = { pid: process.pid, nonce: "live-reclaimer", createdAt: 100 };
  fs.writeFileSync(path.posix.join(liveLayout.lockPath, "reclaim.json"), JSON.stringify(liveClaim));
  const liveFs = Object.create(fs);
  liveFs.processAlive = (pid) => pid === process.pid;
  liveFs.processIdentity = () => "";
  const blocked = await runPosix({ homeDir: liveHome, fsImpl: liveFs });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "transaction-in-progress");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.posix.join(liveLayout.lockPath, "reclaim.json"), "utf8")), liveClaim);
});

for (const readFailureAt of ["initial-owner", "confirmed-owner", "existing-claim"]) {
posixFsTest(`runtime locking fails closed on ${readFailureAt} filesystem read errors`, async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const ownerPath = path.posix.join(layout.lockPath, "owner.json");
  const reclaimPath = path.posix.join(layout.lockPath, "reclaim.json");
  const ownerBytes = JSON.stringify({ pid: 2147483000, nonce: "d".repeat(32), createdAt: 1 });
  fs.mkdirSync(layout.lockPath, { recursive: true });
  fs.writeFileSync(ownerPath, ownerBytes);
  if (readFailureAt === "existing-claim") {
    fs.writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, nonce: "a".repeat(32), createdAt: 1 }));
  }
  const failureFs = Object.create(fs);
  let ownerReads = 0;
  failureFs.processAlive = () => false;
  failureFs.processIdentity = () => "";
  failureFs.readFileSync = (file, options) => {
    const resolved = path.resolve(file);
    if (resolved === path.resolve(ownerPath)) {
      ownerReads += 1;
      if (readFailureAt === "initial-owner" || (readFailureAt === "confirmed-owner" && ownerReads === 2)) {
        const error = new Error("simulated owner read failure");
        error.code = "EIO";
        throw error;
      }
    }
    if (readFailureAt === "existing-claim" && resolved === path.resolve(reclaimPath)) {
      const error = new Error("simulated claim read failure");
      error.code = "EACCES";
      throw error;
    }
    return fs.readFileSync(file, options);
  };
  const result = await runPosix({ homeDir, fsImpl: failureFs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, readFailureAt === "existing-claim"
    ? "transaction-in-progress"
    : "transaction-lock-unavailable");
  assert.equal(fs.readFileSync(ownerPath, "utf8"), ownerBytes);
  assert.equal(fs.existsSync(layout.lockPath), true);
});
}

posixFsTest("a prior runtime transaction cannot release its successor's lock", async () => {
  const homeDir = fixture();
  const layout = canonicalRuntimeLayout({ homeDir, platform: "linux" });
  const successor = { pid: process.pid, nonce: "successor", createdAt: 200 };
  const result = await runPosix({
    homeDir,
    onLockAcquired: async () => {
      fs.writeFileSync(path.posix.join(layout.lockPath, "owner.json"), JSON.stringify(successor));
      throw new Error("simulated displaced owner");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "worker-admission-failed");
  assert.equal(fs.existsSync(layout.lockPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.posix.join(layout.lockPath, "owner.json"), "utf8")), successor);
});

test("Linux runtime owners include boot and process-start identity", {
  skip: process.platform !== "linux" ? "requires Linux procfs" : false,
}, async () => {
  const homeDir = fixture();
  let owner = null;
  const result = await runPosix({ homeDir, onLockAcquired: async (value) => { owner = value; } });
  assert.equal(result.ok, true, `${result.phase}: ${result.reason}`);
  assert.match(owner?.processIdentity || "", /^[^:]+:\d+$/);
});
