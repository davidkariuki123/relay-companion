// Repo identity — the portable key that lets a relay open in the right repo on
// the recipient's machine.
//
// WHAT THIS IS NOT (ANY MORE): the sender's working directory.
//
//   Until 0.1.142 the companion stamped every agent-authored relay with the git
//   origin of the MCP server's process.cwd(), on the theory that a stdio MCP
//   server inherits the host agent's directory, so "where the agent is standing"
//   is "what the relay is about".
//
//   Those are different things, and conflating them is wrong in the most common
//   case we actually have. Shane routinely relays us ABOUT relay from a checkout
//   of a completely different project — his cwd names his repo, the message is
//   about ours. The cwd passport then either matched nothing on the recipient's
//   machine (routing fails closed, so the relay would not open at all) or, worse,
//   named a repo both people happen to have and opened in the wrong one. It also
//   silently disclosed which project the sender happened to be sitting in.
//
//   So the sender's cwd is no longer consulted. The subject of a relay is
//   something only the AGENT knows, so the agent states it: relay_send takes an
//   explicit `repo` argument (see mcp.js), and this module turns whatever the
//   agent wrote into a portable key.
//
// WHY NOT A PATH: an absolute path is meaningless to the recipient. The same
// logical repo lives at /Users/shane/dev/relay on one Mac, /Users/david/src/relay
// on another, and \\wsl.localhost\ubuntu\home\david\src\granular on a third (all
// three shapes are attested in the wild). Paths also leak the sender's username
// and directory layout to every recipient. Only identity travels.
//
// The receiving side maps the key through an index built from its OWN local
// checkouts and never treats any part of it as a path (see repo-index.js and
// cwd-select.js).

// Normalize any git remote URL into a stable `host/owner/name` key.
//
// Collapses the scheme variants that would otherwise split one repo into
// several identities — on a single real machine granular appears as BOTH
// `git@github.com:owner/granular.git` and `https://github.com/owner/granular.git`.
//
// SECURITY: HTTPS remotes can embed credentials
// (`https://x-access-token:ghp_abc@github.com/owner/repo.git`). Everything
// before the last `@` in the authority is dropped, so a token can never ride
// out to a recipient inside the origin key.
//
// Returns "" when the input is not a recognizable remote.
export function normalizeOriginKey(originUrl) {
  const raw = String(originUrl || "").trim();
  if (!raw) return "";

  let rest = raw;
  // scp-like syntax has no scheme: git@host:owner/name.git
  const scpMatch = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/.exec(rest);
  if (scpMatch && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    rest = `${scpMatch[2]}/${scpMatch[3]}`;
  } else {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }

  // Drop userinfo (credentials) — everything up to the LAST @ in the authority.
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const pathPart = slash === -1 ? "" : rest.slice(slash + 1);
  const at = authority.lastIndexOf("@");
  let host = at === -1 ? authority : authority.slice(at + 1);
  host = host.replace(/:\d+$/, "").toLowerCase(); // strip port
  if (!host) return "";

  const cleanPath = pathPart
    .replace(/\.git\/?$/i, "")
    .replace(/^\/+|\/+$/g, "")
    // Forge URLs are case-insensitive for owner/name; lowercase so two clones
    // that differ only in case still match.
    .toLowerCase();
  if (!cleanPath) return "";

  return `${host}/${cleanPath}`;
}

// Does this look like a forge HOST rather than an owner? Hosts carry a dot
// (github.com, gitlab.example.co.uk, git.internal) or are localhost. Without
// this, `owner/name` would normalize to a `host/name` key with the owner
// masquerading as the host, and never match a real origin.
function looksLikeHost(segment) {
  const s = String(segment || "").toLowerCase();
  return s === "localhost" || (s.includes(".") && !s.startsWith(".") && !s.endsWith("."));
}

/**
 * Turn what an agent WROTE into a workspace passport.
 *
 * The agent is asked for "the repo this relay is about" and may reasonably give
 * any of the forms a human would recognize, so all of them are accepted:
 *
 *   git@github.com:owner/relay.git        → kind "git",  key "github.com/owner/relay"
 *   https://github.com/owner/relay        → kind "git",  key "github.com/owner/relay"
 *   github.com/owner/relay                → kind "git",  key "github.com/owner/relay"
 *   owner/relay                           → kind "name", key "owner/relay"
 *   relay                                 → kind "name", key "relay"
 *
 * `kind: "git"` is a fully-qualified identity and matches a checkout's origin
 * exactly. `kind: "name"` is a weaker claim the receiver resolves against its own
 * index (see repo-index.js) — deliberately supported, because the agent naming
 * "relay" is a far better signal than the silent cwd guess it replaces, and
 * because the sender frequently does not know the recipient's forge or owner.
 *
 * Returns null for anything unusable, and the relay then carries no passport at
 * all — which routes exactly as an un-anchored message, not as a wrong guess.
 */
export function workspacePassportFromDeclaration(declared) {
  if (declared && typeof declared === "object") {
    // Tolerate a structured form too, so a caller that already holds an origin
    // does not have to re-serialize it into a string.
    const fromObject =
      declared.originKey || declared.origin || declared.url || declared.repo || declared.name || declared.key;
    const passport = workspacePassportFromDeclaration(fromObject);
    if (!passport) return null;
    const branch = String(declared.branch || "").trim();
    return branch ? { ...passport, branch } : passport;
  }

  const raw = String(declared || "").trim();
  if (!raw) return null;
  // A path is never a passport: it is meaningless on the recipient's machine and
  // discloses the sender's layout. Refuse rather than silently mangling it.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("\\\\")) {
    return null;
  }

  const originKey = normalizeOriginKey(raw);
  if (originKey) {
    const [first, ...restSegments] = originKey.split("/");
    if (looksLikeHost(first) && restSegments.length >= 1) {
      return { kind: "git", key: originKey, label: restSegments[restSegments.length - 1] };
    }
  }

  // Not host-qualified: an `owner/name` or bare `name` claim.
  const fragment = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\.git\/?$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!fragment || /\s/.test(fragment)) return null;
  const segments = fragment.split("/").filter(Boolean);
  if (!segments.length || segments.length > 2) return null;
  return { kind: "name", key: segments.join("/"), label: segments[segments.length - 1] };
}
