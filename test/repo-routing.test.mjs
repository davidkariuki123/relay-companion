// Workspace-passport open routing: identity normalization and the cwd decision.
//
// chooseOpenCwd is pure (every effect injected), so these run without touching
// a real machine — the same property that makes host-select.cjs testable.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeOriginKey, workspacePassportFromDeclaration } from "../src/repo-identity.js";
import { chooseOpenCwd } from "../src/cwd-select.js";

// chooseOpenCwd resolves every candidate to a host-absolute path, because that is
// what a real checkout is on the machine doing the opening. These fixtures are
// written POSIX-style for readability, so `at` puts them in the host's own terms —
// "/repos/relay" on macOS and Linux, "C:\repos\relay" on the Windows gate. The
// routing decision under test is the same either way.
const at = (p) => path.resolve(p);
const HOME = at("/Users/tester");
const RELAY_FOLDER = at("/Users/tester/Relay");
const REAL = new Set(["/repos/relay", "/repos/granular", "/repos/relay-wt", "/Users/tester", "/explicit"].map(at));
const isDirectory = (p) => REAL.has(p);
// The default ensureDirectory touches the real filesystem; unit fixtures always
// inject one. Base refuses creation so each test states its own outcome.
const base = { env: {}, homedir: HOME, isDirectory, ensureDirectory: () => false };

test("normalizeOriginKey collapses every URL form to one key", () => {
  const expected = "github.com/acme/relay";
  for (const url of [
    "git@github.com:acme/relay.git",
    "https://github.com/acme/relay.git",
    "https://github.com/acme/relay",
    "ssh://git@github.com/acme/relay.git",
    "git://github.com/acme/relay.git",
    "https://github.com:443/acme/relay/",
    "git@github.com:ACME/Relay.git",
  ]) {
    assert.equal(normalizeOriginKey(url), expected, url);
  }
});

test("normalizeOriginKey strips embedded credentials", () => {
  const key = normalizeOriginKey("https://x-access-token:ghp_SECRET@github.com/acme/relay.git");
  assert.equal(key, "github.com/acme/relay");
  assert.ok(!key.includes("ghp_SECRET"));
  assert.ok(!key.includes("@"));
});

test("normalizeOriginKey rejects junk", () => {
  for (const bad of ["", "   ", null, undefined, "not a url"]) {
    assert.equal(normalizeOriginKey(bad), "");
  }
});

// The passport now comes from what the AGENT declared the relay is about, not from
// the sender's working directory. Agents write repo identifiers in every form a
// human would recognize, so all of them have to land on the same key.
test("an agent's fully-qualified repo declaration becomes a git passport", () => {
  for (const declared of [
    "git@github.com:acme/relay.git",
    "https://github.com/acme/relay",
    "https://github.com/acme/relay.git",
    "github.com/acme/relay",
    "GitHub.com/ACME/Relay",
  ]) {
    assert.deepEqual(
      workspacePassportFromDeclaration(declared),
      { kind: "git", key: "github.com/acme/relay", label: "relay" },
      declared,
    );
  }
});

test("an owner/name or bare name declaration becomes a name passport", () => {
  assert.deepEqual(workspacePassportFromDeclaration("acme/relay"), {
    kind: "name",
    key: "acme/relay",
    label: "relay",
  });
  assert.deepEqual(workspacePassportFromDeclaration("relay"), { kind: "name", key: "relay", label: "relay" });
  assert.deepEqual(workspacePassportFromDeclaration("  Relay  "), { kind: "name", key: "relay", label: "relay" });
});

test("a declared branch rides along", () => {
  assert.deepEqual(workspacePassportFromDeclaration({ origin: "github.com/acme/relay", branch: "main" }), {
    kind: "git",
    key: "github.com/acme/relay",
    label: "relay",
    branch: "main",
  });
});

test("a filesystem path is never a passport", () => {
  // A path is meaningless on the recipient's machine and leaks the sender's layout.
  for (const bad of [
    "/Users/shane/dev/relay",
    "~/src/relay",
    "C:\\Users\\shane\\relay",
    "\\\\wsl.localhost\\ubuntu\\home\\d\\relay",
  ]) {
    assert.equal(workspacePassportFromDeclaration(bad), null, bad);
  }
});

test("junk declarations produce no passport rather than a wrong one", () => {
  for (const bad of ["", "   ", null, undefined, "the relay repo", "a/b/c/d"]) {
    assert.equal(workspacePassportFromDeclaration(bad), null, JSON.stringify(bad));
  }
});

test("strict routing can still refuse a relay without a workspace passport", () => {
  const { cwd, reason, openable } = chooseOpenCwd({ ...base, row: {} });
  assert.equal(cwd, "");
  assert.equal(reason, "missing-workspace-passport");
  assert.equal(openable, false);
});

test("routes to the local checkout matching the sender's workspace passport", () => {
  const { cwd, reason, workspaceKey } = chooseOpenCwd({
    ...base,
    row: {
      source: {
        workspace: { kind: "git", key: "github.com/acme/granular", label: "granular", branch: "main" },
      },
    },
    findCheckoutsFn: (repo) => {
      // A git passport resolves by exact origin, and carries the repo's own name as
      // a secondary claim so a recipient who cloned the project from a different
      // fork or forge still matches (repo-index.js only consults it after exact
      // identity matching has failed).
      assert.deepEqual(repo, {
        originKey: "github.com/acme/granular",
        rootCommit: "",
        nameClaim: "granular",
        branch: "main",
      });
      return [{ dir: "/repos/granular", originKey: "github.com/acme/granular" }];
    },
  });
  assert.equal(cwd, at("/repos/granular"));
  assert.equal(reason, "workspace-passport");
  assert.equal(workspaceKey, "git:github.com/acme/granular");
});

test("legacy source.repo is treated as a passport, not as a fallback hint", () => {
  const { cwd, reason, workspaceKey } = chooseOpenCwd({
    ...base,
    row: { source: { repo: { originKey: "github.com/acme/relay", name: "relay" } } },
    findCheckoutsFn: () => [{ dir: "/repos/relay", originKey: "github.com/acme/relay" }],
  });
  assert.equal(cwd, at("/repos/relay"));
  assert.equal(reason, "workspace-passport");
  assert.equal(workspaceKey, "git:github.com/acme/relay");
});

test("a sender-supplied path is never opened", () => {
  const { cwd, reason, openable } = chooseOpenCwd({
    ...base,
    row: {
      source: {
        cwd: "/Users/tester/.ssh",
        workspace: { kind: "git", key: "github.com/attacker/evil" },
      },
    },
    findCheckoutsFn: () => [],
  });
  assert.equal(cwd, "");
  assert.equal(reason, "workspace-unmapped");
  assert.equal(openable, false);
});

test("skips checkouts that no longer exist", () => {
  const { cwd } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/relay" } } },
    findCheckoutsFn: () => [{ dir: "/repos/deleted" }, { dir: "/repos/relay" }],
  });
  assert.equal(cwd, at("/repos/relay"));
});

test("remembered non-home cwd can reuse an already forged row", () => {
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/granular" } } },
    rowState: {
      openCwd: "/repos/granular",
      openCwdReason: "workspace-passport",
      openWorkspaceKey: "git:github.com/acme/granular",
    },
    findCheckoutsFn: () => [{ dir: "/repos/relay" }],
  });
  assert.equal(cwd, at("/repos/granular"));
  assert.equal(reason, "remembered");
});

test("remembered home from the old bug is not sticky", () => {
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/relay" } } },
    rowState: { openCwd: HOME, openCwdReason: "home" },
    findCheckoutsFn: () => [{ dir: "/repos/relay" }],
  });
  assert.equal(cwd, at("/repos/relay"));
  assert.equal(reason, "workspace-passport");
});

test("a stale remembered cwd falls through instead of stranding the open", () => {
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/granular" } } },
    rowState: {
      openCwd: "/repos/deleted-since",
      openCwdReason: "workspace-passport",
      openWorkspaceKey: "git:github.com/acme/granular",
    },
    findCheckoutsFn: () => [{ dir: "/repos/granular" }],
  });
  assert.equal(cwd, at("/repos/granular"));
  assert.equal(reason, "workspace-passport");
});

test("explicit request outranks the passport", () => {
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    requestedCwd: "/explicit",
    row: { source: { workspace: { kind: "git", key: "github.com/acme/granular" } } },
    rowState: { openCwd: "/repos/relay", openCwdReason: "workspace-passport" },
    findCheckoutsFn: () => [{ dir: "/repos/granular" }],
  });
  assert.equal(cwd, at("/explicit"));
  assert.equal(reason, "explicit");
});

test("branch match breaks a tie between worktrees of one repo", () => {
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/relay", branch: "feature-x" } } },
    findCheckoutsFn: () => [
      { dir: "/repos/relay", branch: "main", isPrimary: true },
      { dir: "/repos/relay-wt", branch: "feature-x", isPrimary: false },
    ],
  });
  // findCheckouts does the ranking; the selector honors the order it is given.
  assert.equal(cwd, at("/repos/relay"));
  assert.equal(reason, "workspace-passport-ranked");
});

test("an unanchored relay uses the receiver's configured default project when enabled", () => {
  const strict = chooseOpenCwd({ ...base, env: { RELAY_OPEN_CWD: "/repos/relay" }, row: {} });
  assert.equal(strict.cwd, "");
  assert.equal(strict.reason, "missing-workspace-passport");

  const unanchored = chooseOpenCwd({
    ...base,
    env: { RELAY_OPEN_CWD: "/repos/relay" },
    row: {},
    allowUnanchoredFallback: true,
  });
  assert.equal(unanchored.cwd, at("/repos/relay"));
  assert.equal(unanchored.reason, "env");
});

test("an unanchored relay lands in the dedicated Relay folder, creating it on first use", () => {
  const created = [];
  const opened = chooseOpenCwd({
    ...base,
    ensureDirectory: (dir) => {
      created.push(dir);
      return true;
    },
    row: {},
    allowUnanchoredFallback: true,
  });
  assert.deepEqual(created, [RELAY_FOLDER]);
  assert.equal(opened.cwd, RELAY_FOLDER);
  assert.equal(opened.reason, "relay-folder");
  assert.equal(opened.openable, true);
});

test("an existing Relay folder is reused without a create call", () => {
  const opened = chooseOpenCwd({
    ...base,
    isDirectory: (p) => p === RELAY_FOLDER || isDirectory(p),
    ensureDirectory: () => {
      throw new Error("must not create when the folder already exists");
    },
    row: {},
    allowUnanchoredFallback: true,
  });
  assert.equal(opened.cwd, RELAY_FOLDER);
  assert.equal(opened.reason, "relay-folder");
});

test("home remains the last resort when the Relay folder cannot be created", () => {
  const opened = chooseOpenCwd({
    ...base,
    row: {},
    allowUnanchoredFallback: true,
  });
  assert.equal(opened.cwd, HOME);
  assert.equal(opened.reason, "home");
  assert.equal(opened.openable, true);
});

test("a row remembered in the Relay folder reuses its forged session", () => {
  const opened = chooseOpenCwd({
    ...base,
    isDirectory: (p) => p === RELAY_FOLDER || isDirectory(p),
    row: {},
    rowState: { openCwd: RELAY_FOLDER, openCwdReason: "relay-folder" },
    allowUnanchoredFallback: true,
  });
  assert.equal(opened.cwd, RELAY_FOLDER);
  assert.equal(opened.reason, "remembered");
});

test("a row stranded in home by the old fallback re-forges into the Relay folder", () => {
  const opened = chooseOpenCwd({
    ...base,
    ensureDirectory: () => true,
    row: {},
    rowState: { openCwd: HOME, openCwdReason: "home" },
    allowUnanchoredFallback: true,
  });
  assert.equal(opened.cwd, RELAY_FOLDER);
  assert.equal(opened.reason, "relay-folder");
});

test("a findCheckouts failure refuses instead of opening home", () => {
  const { cwd, reason, openable } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "git", key: "github.com/acme/relay" } } },
    findCheckoutsFn: () => {
      throw new Error("index unavailable");
    },
  });
  assert.equal(cwd, "");
  assert.equal(reason, "workspace-unmapped");
  assert.equal(openable, false);
});

// ---------------------------------------------------------------------------
// Name-claim routing. The sender states the SUBJECT of the relay and usually
// knows the project by name ("relay") rather than by the recipient's forge and
// owner — so a name has to resolve, while still only ever selecting a repo the
// recipient already has.
// ---------------------------------------------------------------------------

test("a bare name passport routes to the recipient's checkout of that project", () => {
  const { cwd, reason, workspaceKey } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "name", key: "relay", label: "relay" } } },
    findCheckoutsFn: (repo) => {
      // A name claim carries no origin and no commit — nothing to match but the name.
      assert.deepEqual(repo, { nameClaim: "relay" });
      return [{ dir: "/repos/relay", originKey: "github.com/davidkariuki123/relay" }];
    },
  });
  assert.equal(cwd, at("/repos/relay"));
  assert.equal(reason, "workspace-passport");
  assert.equal(workspaceKey, "name:relay");
});

test("a name the recipient does not have still fails closed", () => {
  // The whole point of routing by identity: an unknown repo never degrades into a
  // guessed directory, and never silently opens in the home folder.
  const { cwd, reason, openable } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "name", key: "someone-elses-repo" } } },
    findCheckoutsFn: () => [],
  });
  assert.equal(cwd, "");
  assert.equal(reason, "workspace-unmapped");
  assert.equal(openable, false);
});

test("Shane's actual case: a relay about relay, sent from elsewhere, opens in relay", () => {
  // Before this change the passport was captured from the sender's cwd, so a
  // message about relay written from another project either matched nothing
  // (refused to open) or matched the wrong repo. Now the agent names the subject.
  const { cwd, reason } = chooseOpenCwd({
    ...base,
    row: { source: { workspace: { kind: "name", key: "relay", label: "relay" } } },
    findCheckoutsFn: (repo) =>
      repo.nameClaim === "relay" ? [{ dir: "/repos/relay", originKey: "github.com/davidkariuki123/relay" }] : [],
  });
  assert.equal(cwd, at("/repos/relay"));
  assert.equal(reason, "workspace-passport");
});
