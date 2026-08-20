// Which directory should a relay open in?
//
// Pure decision module, deliberately shaped like overlay/host-select.cjs: no
// filesystem, process, or network access of its own — every effect is injected.
// That keeps the routing rules unit-testable without mocking a machine.
//
// ARCHITECTURE:
//
//   Agent-authored relays carry a project/workspace passport naming the repo the
//   relay is ABOUT — stated by the sending agent, not inferred from its cwd:
//     source.workspace = { kind: "git",  key: "github.com/owner/repo", ... }
//     source.workspace = { kind: "name", key: "repo", ... }
//
//   The receiver maps that passport through an index built from THIS machine's
//   local repos. If it maps, the relay opens there. If the sender did not stamp a
//   passport, the product caller may deliberately route it to this receiver's
//   default Relay home: RELAY_OPEN_CWD when configured, else a dedicated
//   ~/Relay folder created on first use so every relay lands in a stable,
//   recognizable place instead of the bare home directory. A passport that
//   names an unknown repo still fails closed: it never degrades to a guessed
//   directory.
//
// TRUST MODEL:
//
//   A relay's `source` is written by the SENDER and is untrusted input. A
//   sender-supplied PATH is never opened, never resolved, never stat'd. Only the
//   portable workspace identity is used, and only ever as a key looked up in an
//   index this machine built from its own local state. The worst a hostile sender
//   can do is name a repo the recipient already has and works in.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

function defaultIsDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function defaultEnsureDirectory(candidate) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Codex hard-fails and Claude silently forges a dead session when the working
// directory does not exist, so a candidate is only usable if it is really there.
function usable(candidate, isDirectory) {
  const clean = String(candidate || "").trim();
  if (!clean) return "";
  const resolved = path.resolve(clean);
  return isDirectory(resolved) ? resolved : "";
}

function legacyWorkspaceFromRepo(repo) {
  if (!repo || typeof repo !== "object") return null;
  const originKey = String(repo.originKey || "").trim().toLowerCase();
  const rootCommit = String(repo.rootCommit || "").trim();
  const key = originKey || (rootCommit ? `git-root:${rootCommit}` : "");
  if (!key) return null;
  return {
    kind: "git",
    key,
    ...(repo.name ? { label: String(repo.name) } : {}),
    ...(repo.branch ? { branch: String(repo.branch) } : {}),
    ...(rootCommit ? { rootCommit } : {}),
  };
}

function workspaceFromRow(row) {
  const source = row?.source && typeof row.source === "object" ? row.source : null;
  const workspace = source?.workspace && typeof source.workspace === "object" ? source.workspace : null;
  if (workspace) {
    const kind = String(workspace.kind || "").trim();
    const key = String(workspace.key || "").trim().toLowerCase();
    if ((kind === "git" || kind === "name") && key) {
      return {
        kind,
        key,
        ...(workspace.label ? { label: String(workspace.label) } : {}),
        ...(workspace.branch ? { branch: String(workspace.branch) } : {}),
        ...(workspace.rootCommit ? { rootCommit: String(workspace.rootCommit) } : {}),
      };
    }
  }
  // Backwards compatibility for senders still stamping the old cwd-derived
  // source.repo (0.1.117 onwards). Treat it as a passport-shaped identity, not as
  // one rung in a fallback ladder. Such a passport names wherever that agent
  // happened to be standing, so it is right only by luck — but it is still an
  // identity looked up in this machine's own index, so it can only ever resolve
  // to a repo the recipient already has.
  return legacyWorkspaceFromRepo(source?.repo);
}

function workspaceKey(workspace) {
  if (!workspace) return "";
  return `${workspace.kind}:${workspace.key}`;
}

function repoContextFromWorkspace(workspace) {
  if (!workspace) return null;
  const key = String(workspace.key || "").trim().toLowerCase();
  if (!key) return null;
  const branch = workspace.branch ? { branch: String(workspace.branch) } : {};
  // A name claim carries no origin and no commit — it is resolved against the
  // receiver's index by name only (see repo-index.js matchesNameClaim).
  if (workspace.kind === "name") return { nameClaim: key, ...branch };
  if (workspace.kind !== "git") return null;
  const fromRootCommitKey = key.startsWith("git-root:") ? key.slice("git-root:".length) : "";
  return {
    ...(fromRootCommitKey ? {} : { originKey: key }),
    rootCommit: String(workspace.rootCommit || fromRootCommitKey || "").trim(),
    // An origin that finds no local checkout still falls back to the repo's own
    // name: the sender may be naming the same project under a different fork or
    // forge than the one the recipient cloned from.
    ...(fromRootCommitKey ? {} : { nameClaim: key.split("/").pop() || "" }),
    ...branch,
  };
}

// Unanchored relays (human-typed messages, task opens — anything without a
// workspace passport) all land in one dedicated Relay folder under home,
// created on first use, so their sessions file under a recognizable "Relay"
// project in Claude Code and carry a recognizable cwd in Codex. Home itself is
// only the last resort for a machine where that folder cannot be created.
function unanchoredFallback({ env, homedir, isDirectory, ensureDirectory }) {
  const envCwd = usable(env.RELAY_OPEN_CWD, isDirectory);
  if (envCwd) return { cwd: envCwd, reason: "env" };
  const relayFolder = path.resolve(path.join(homedir, "Relay"));
  if (isDirectory(relayFolder) || ensureDirectory(relayFolder)) {
    return { cwd: relayFolder, reason: "relay-folder" };
  }
  return { cwd: homedir, reason: "home" };
}

// Resolve the working directory for one relay open.
//
// Returns { cwd, reason, repoName, workspaceKey, openable }. `reason` names the
// architectural decision that won — it is logged and persisted so a surprising
// routing decision is diagnosable after the fact.
export function chooseOpenCwd({
  requestedCwd = "",
  row = null,
  rowState = null,
  findCheckoutsFn = null,
  env = process.env,
  homedir = os.homedir(),
  isDirectory = defaultIsDirectory,
  ensureDirectory = defaultEnsureDirectory,
  allowUnanchoredFallback = false,
} = {}) {
  const workspace = workspaceFromRow(row);
  const key = workspaceKey(workspace);
  const repoName = String(workspace?.label || row?.source?.repo?.name || "").trim();

  // A human/operator can deliberately override the routing for this one open.
  // This is explicit, local control — not a sender hint and not a guess.
  const explicit = usable(requestedCwd, isDirectory);
  if (explicit) return { cwd: explicit, reason: "explicit", repoName, workspaceKey: key, openable: true };

  // Re-opening an already forged row can reuse its native-session cwd, but never
  // let the old "home" bug become sticky. When the row carries a passport, a
  // remembered cwd must either be from the same passport or be old state from a
  // successful non-home route.
  const remembered = usable(rowState?.openCwd, isDirectory);
  const rememberedReason = String(rowState?.openCwdReason || "").trim();
  const rememberedWorkspaceKey = String(rowState?.openWorkspaceKey || "").trim();
  if (
    remembered &&
    rememberedReason &&
    rememberedReason !== "home" &&
    (!key || !rememberedWorkspaceKey || rememberedWorkspaceKey === key)
  ) {
    return { cwd: remembered, reason: "remembered", repoName, workspaceKey: rememberedWorkspaceKey || key, openable: true };
  }

  if (!workspace) {
    if (allowUnanchoredFallback) {
      const fallback = unanchoredFallback({ env, homedir, isDirectory, ensureDirectory });
      return { ...fallback, repoName, workspaceKey: "", openable: Boolean(fallback.cwd) };
    }
    return { cwd: "", reason: "missing-workspace-passport", repoName, workspaceKey: "", openable: false };
  }

  const repoContext = repoContextFromWorkspace(workspace);
  if (repoContext && typeof findCheckoutsFn === "function") {
    let checkouts = [];
    try {
      checkouts = findCheckoutsFn(repoContext) || [];
    } catch {
      checkouts = [];
    }
    for (const checkout of checkouts) {
      const dir = usable(checkout?.dir, isDirectory);
      if (dir) {
        return {
          cwd: dir,
          reason: checkouts.length > 1 ? "workspace-passport-ranked" : "workspace-passport",
          repoName: repoName || checkout.originKey || workspace.key,
          workspaceKey: key,
          openable: true,
        };
      }
    }
  }

  return { cwd: "", reason: "workspace-unmapped", repoName, workspaceKey: key, openable: false };
}
