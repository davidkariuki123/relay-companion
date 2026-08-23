// Local repo index — resolves a portable originKey (see repo-identity.js) to a
// real directory on THIS machine.
//
// The index is assembled from signals the machine already has, so repo-aware
// opening works with zero user configuration on first run:
//
//   1. Codex's own thread DB (~/.codex/state_5.sqlite). Its `threads` table
//      already stores git_origin_url alongside cwd, and is indexed on
//      (archived, cwd, recency_at_ms). That is a pre-built, frequency-ranked
//      origin -> directory map. Strongest signal by far.
//   2. ~/.claude.json `projects` keys — a clean, small registry of directories
//      Claude has actually been run in. (~/.claude/projects/ is deliberately
//      NOT used: the vast majority of its entries are ephemeral agent-run temp
//      dirs, and its directory-name encoding is lossy and non-invertible.)
//   3. A bounded scan of conventional source roots, used only when 1 and 2
//      miss. Unbounded scans of $HOME are far too slow to sit on a click path.
//
// Results are cached on disk with a short TTL because this runs on the open
// path, between a click and a window appearing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStateDbPath, storeDir } from "./host-paths.js";
import { normalizeOriginKey } from "./repo-identity.js";

const CACHE_TTL_MS = Number(process.env.RELAY_REPO_INDEX_TTL_MS || 10 * 60 * 1000);
const SCAN_ROOT_NAMES = ["src", "code", "projects", "dev", "work", "repos", "Documents"];
const SCAN_MAX_DEPTH = 3;

function cachePath() {
  return path.join(storeDir(), "repo-index.json");
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (!Number.isFinite(raw.builtAt) || Date.now() - raw.builtAt > CACHE_TTL_MS) return null;
    return Array.isArray(raw.checkouts) ? raw.checkouts : null;
  } catch {
    return null;
  }
}

function writeCache(checkouts) {
  try {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ builtAt: Date.now(), checkouts }, null, 2));
  } catch {
    /* cache is an optimization; a failure must never break an open */
  }
}

function git(args, cwd) {
  try {
    return String(
      execFileSync("git", args, { cwd, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    ).trim();
  } catch {
    return "";
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Codex threads: cwd + git_origin_url + recency, already joined for us.
// Read-only and immutable so a concurrent Codex write can never be disturbed.
function fromCodexThreads() {
  const dbPath = codexStateDbPath();
  if (!fs.existsSync(dbPath)) return [];
  const sql =
    "SELECT cwd, COALESCE(git_origin_url,'') AS origin, COUNT(*) AS uses, " +
    "MAX(COALESCE(recency_at_ms,0)) AS last FROM threads " +
    "WHERE cwd IS NOT NULL AND cwd <> '' GROUP BY cwd, git_origin_url;";
  const uri = `file:${dbPath}?mode=ro&immutable=1`;
  const result = spawnSync("sqlite3", ["-json", uri, sql], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0 || !String(result.stdout || "").trim()) return [];
  try {
    return JSON.parse(result.stdout)
      .filter((r) => r && r.cwd)
      .map((r) => ({
        dir: String(r.cwd),
        originKey: normalizeOriginKey(r.origin),
        uses: Number(r.uses) || 0,
        lastUsedAt: Number(r.last) || 0,
        source: "codex",
      }));
  } catch {
    return [];
  }
}

// ~/.claude.json `projects` keys are directories Claude has run in. They carry
// no origin, so origin is resolved from disk during enrichment.
function fromClaudeRegistry() {
  const file = path.join(os.homedir(), ".claude.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const projects = parsed && typeof parsed.projects === "object" ? parsed.projects : {};
    return Object.keys(projects)
      // Windows/WSL keys from another machine cannot resolve locally.
      .filter((dir) => dir.startsWith("/"))
      .map((dir) => ({ dir, originKey: "", uses: 1, lastUsedAt: 0, source: "claude" }));
  } catch {
    return [];
  }
}

// Extra roots for people who keep repos somewhere unconventional. Use the host
// path delimiter (":" on POSIX, ";" on Windows) or commas; splitting Windows
// roots on every colon turns C:\\work into two invalid paths.
function configuredRoots() {
  const separator = path.delimiter === ";" ? /[;,]/ : /[:,]/;
  return String(process.env.RELAY_REPO_ROOTS || "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scanRoot(root) {
  const repos = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      repos.push(current.dir);
      continue;
    }
    if (current.depth + 1 >= SCAN_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return repos;
}

// Bounded breadth scan of conventional source roots. Keeping traversal in Node
// gives Windows the same discovery contract without depending on Unix `find`.
function fromDiskScan() {
  const home = os.homedir();
  const roots = [...configuredRoots(), ...SCAN_ROOT_NAMES.map((name) => path.join(home, name))].filter(isDir);
  if (!roots.length) return [];
  return roots.flatMap(scanRoot).map((dir) => ({
      dir,
      originKey: "",
      uses: 0,
      lastUsedAt: 0,
      source: "disk",
    }));
}

// Fill in origin/branch/common-dir for candidates that lack them, drop anything
// that is no longer a real directory, and merge duplicates.
//
// --git-common-dir is the grouping primitive that makes worktrees behave: a repo
// with many linked worktrees reports the SAME common dir from every checkout, so
// they collapse into one repo with several candidate directories instead of
// looking like unrelated projects.
function enrich(candidates) {
  const byDir = new Map();
  for (const candidate of candidates) {
    if (!candidate.dir || !isDir(candidate.dir)) continue;
    const existing = byDir.get(candidate.dir);
    if (existing) {
      existing.uses += candidate.uses;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, candidate.lastUsedAt);
      existing.originKey ||= candidate.originKey;
      continue;
    }
    byDir.set(candidate.dir, { ...candidate });
  }

  const out = [];
  for (const entry of byDir.values()) {
    if (!entry.originKey) entry.originKey = normalizeOriginKey(git(["remote", "get-url", "origin"], entry.dir));
    const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], entry.dir);
    if (!commonDir) continue; // not a git checkout — cannot be matched by repo identity
    entry.commonDir = commonDir;
    entry.branch = git(["rev-parse", "--abbrev-ref", "HEAD"], entry.dir);
    entry.rootCommit = git(["rev-list", "--max-parents=0", "HEAD"], entry.dir).split("\n").pop() || "";
    entry.isPrimary = path.resolve(commonDir) === path.resolve(entry.dir, ".git");
    out.push(entry);
  }
  return out;
}

// Build (or reuse) the index. `deep` adds the disk scan, which callers use only
// after a history-only lookup has already missed.
export function buildRepoIndex({ deep = false, useCache = true } = {}) {
  if (useCache) {
    const cached = readCache();
    if (cached && (!deep || cached.some((c) => c.source === "disk"))) return cached;
  }
  const raw = [...fromCodexThreads(), ...fromClaudeRegistry(), ...(deep ? fromDiskScan() : [])];
  const checkouts = enrich(raw);
  if (useCache) writeCache(checkouts);
  return checkouts;
}

// Does a checkout answer to the loose `owner/name` or bare `name` the sender
// declared? Checked against the checkout's own origin and its directory name —
// both are local facts this machine derived itself, never sender input.
//
// This exists because the sender states the SUBJECT of the relay, and usually
// knows the project by name ("relay") rather than by the recipient's forge and
// owner. A name is a weaker key than an origin, so it is only ever consulted
// after exact-identity matching has already failed.
export function matchesNameClaim(checkout, claim) {
  const want = String(claim || "").trim().toLowerCase();
  if (!want) return false;
  const originKey = String(checkout?.originKey || "").toLowerCase();
  // "owner/name" must match the tail of host/owner/name exactly.
  if (want.includes("/")) return originKey.endsWith(`/${want}`);
  // Bare "name" matches the repo's name segment, or the directory it lives in
  // (which covers a local-only clone with no origin configured at all).
  if (originKey && originKey.split("/").pop() === want) return true;
  const dir = String(checkout?.dir || "");
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || "";
  return base.toLowerCase() === want;
}

// Resolve a repo context to local checkouts, best first. Returns [] when this
// machine has no copy of that repo.
//
// Matching is by IDENTITY first — originKey, else root-commit SHA for repos with
// no origin — and only then by the sender's declared NAME. A sender-supplied path
// is never used to locate anything.
export function findCheckouts(repoContext, { index } = {}) {
  const originKey = String(repoContext?.originKey || "").trim().toLowerCase();
  const rootCommit = String(repoContext?.rootCommit || "").trim();
  const nameClaim = String(repoContext?.nameClaim || "").trim().toLowerCase();
  if (!originKey && !rootCommit && !nameClaim) return [];

  const search = (checkouts) => {
    const exact = checkouts.filter(
      (c) => (originKey && c.originKey === originKey) || (rootCommit && c.rootCommit === rootCommit),
    );
    if (exact.length || !nameClaim) return exact;
    return checkouts.filter((c) => matchesNameClaim(c, nameClaim));
  };

  let matches = search(index || buildRepoIndex());
  // Miss on history alone: pay for the disk scan once, then re-check.
  if (!matches.length && !index) matches = search(buildRepoIndex({ deep: true, useCache: false }));
  if (!matches.length) return [];

  const wantBranch = String(repoContext?.branch || "").trim();
  return matches.sort((a, b) => {
    // Same branch as the sender wins — the most likely intended checkout.
    const branchA = wantBranch && a.branch === wantBranch ? 1 : 0;
    const branchB = wantBranch && b.branch === wantBranch ? 1 : 0;
    if (branchA !== branchB) return branchB - branchA;
    // Then the checkout the user actually works in most recently.
    if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    if (a.uses !== b.uses) return b.uses - a.uses;
    // Then the primary clone over a linked worktree.
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.dir.localeCompare(b.dir);
  });
}
