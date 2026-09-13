// Claude materializer. Ported faithfully from
// granular/tools/relay-companion/src/claude-materializer.js. Writes the Claude
// Code / Cowork fallback markdown artifact and (for Claude Code targets) forges
// the native Claude Desktop session via writeClaudeNativeSession.
//
// Adaptations (input side only): the input is a cloud companion row, not a
// granular packet. Title/body come from ./relay-briefing.js. For the open path
// the overlay always passes --host claude, so forceClaudeCode is set by openRelay.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderRelayOpenDocuments, renderRelayOpenSeed } from "./relay-briefing.js";
import { writeClaudeNativeSession } from "./claude-session-writer.js";
import { claudeDesktopConfigPath, storeDir } from "./host-paths.js";

export function materializeRowForClaude(row, { cwd = process.cwd(), forceClaudeCode = false, forceCowork = false, model = "", effort = "" } = {}) {
  const body = renderClaudeHandoffMarkdown(row);
  const fileName = `${safeFileStem(row.createdAt)}-${safeFileStem(row.id)}.md`;
  const wantsClaudeCode = forceClaudeCode || (!forceCowork && rowTargetsSurface(row, "claude_code"));
  // THE READER'S CHOICE COUNTS. Cowork was reachable only through the SENDER's
  // targetSurfaces, so picking "Claude Cowork" in the route rail did the Claude
  // Code thing and then claimed it had opened Cowork — a verb that announced
  // success and wrote nothing (David's Cowork inbox: newest artifact hours old
  // after the click).
  const wantsCowork = forceCowork || (!forceClaudeCode && rowTargetsSurface(row, "claude_cowork"));
  const targets = [];
  if (wantsCowork) targets.push(coworkRelayInboxDir());
  const paths = [];
  let openRow = row;
  if (wantsClaudeCode) {
    // Write the open documents UNDER the session cwd. Claude Desktop's file
    // panel only reads paths inside the session's granted roots (its cwd first
    // of all); the previous ~/.relay-companion location is outside every root,
    // so every For-Agent / For-Human link died with "Couldn't find this file"
    // (Sven, 2026-09-10). Declaring the dir on the forged session record does
    // NOT survive Desktop's import (it wipes sessionPermissionUpdates), so the
    // documents themselves have to live where the panel already looks.
    const { forHuman: forHumanPath, forAgent: forAgentPath } = materializeRelayOpenDocumentFiles(row, { provider: "claude-inbox", cwd });
    paths.push(forHumanPath, forAgentPath);
    openRow = {
      ...row,
      relayOpenDocumentPaths: { forHuman: forHumanPath, forAgent: forAgentPath },
    };
  }
  for (const target of targets) {
    fs.mkdirSync(target, { recursive: true });
    const filePath = path.join(target, fileName);
    fs.writeFileSync(filePath, body);
    paths.push(filePath);
  }
  const nativeSession =
    wantsClaudeCode && shouldMaterializeClaudeNative()
      ? writeClaudeNativeSession({ row: openRow, cwd, seed: renderRelayOpenSeed(openRow), model, effort })
      : null;
  return {
    paths,
    nativeSession,
    surfaces: {
      claudeCode: wantsClaudeCode,
      claudeCowork: wantsCowork,
    },
  };
}

export function materializeRelayOpenDocumentFiles(row, { provider = "provider-inbox", cwd = "" } = {}) {
  const relayDir = relayOpenDocumentsDir({ provider, id: row?.id || row?.createdAt, cwd });
  fs.mkdirSync(relayDir, { recursive: true });
  // Hyphenated, not spaced: a space forces the link renderer to escape the path,
  // and only Claude is known to percent-decode it. A space-free name needs no
  // escaping in any renderer, so the Open link works on every provider surface.
  const forHumanPath = path.join(relayDir, "For-Human.md");
  const forAgentPath = path.join(relayDir, "For-Agent.md");
  fs.writeFileSync(forHumanPath, `# For Human\n\n${String(row?.forHuman || "").trim()}\n`);
  fs.writeFileSync(forAgentPath, `# For Agent\n\n${String(row?.forAgent || "").trim()}\n`);
  return { forHuman: forHumanPath, forAgent: forAgentPath };
}

// Where a relay's open documents live. Under the session cwd when we have one
// (so Claude Desktop's file panel, which only reads inside the session's
// granted roots, resolves the links), otherwise the shared companion store.
// The cwd copy sits in a self-ignoring `.relay-inbox/` so it never shows up in
// the git status of a passport-anchored checkout.
export function relayOpenDocumentsDir({ provider = "provider-inbox", id, cwd = "" } = {}) {
  const stem = safeFileStem(id);
  const base = String(cwd || "").trim();
  if (base && path.isAbsolute(base)) {
    const inboxRoot = path.join(base, ".relay-inbox");
    try {
      // Recursive mkdir also creates the cwd itself when it does not exist yet
      // (an unanchored relay's ~/Relay is created on first use), so the panel's
      // granted-root copy is always written, not just when the cwd pre-exists.
      fs.mkdirSync(inboxRoot, { recursive: true });
      // `*` ignores every file in here, including this .gitignore itself, so the
      // whole directory is invisible to git even under `git add -A`.
      const ignorePath = path.join(inboxRoot, ".gitignore");
      if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, "*\n");
      return path.join(inboxRoot, stem);
    } catch {
      // Fall through to the companion store if the cwd is not writable.
    }
  }
  return path.join(storeDir(), safeFileStem(provider), stem);
}

export function renderClaudeHandoffMarkdown(row) {
  return `${renderRelayOpenDocuments(row)}\n`;
}

export function coworkRelayInboxDir() {
  const configPath = claudeDesktopConfigPath();
  let userFilesPath = path.join(os.homedir(), "Claude");
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      userFilesPath = config.coworkUserFilesPath || userFilesPath;
    }
  } catch {
    // Fall back to ~/Claude; a malformed Claude config should not block Relay materialization.
  }
  return path.join(userFilesPath, "Relay Inbox");
}

// The cloud row carries delivery.targetSurfaces when its snapshot packet is read;
// the staged row defaults both Codex + Claude Code. Treat a missing list as "all".
function rowTargetsSurface(row, surface) {
  const list = row?.delivery?.targetSurfaces || row?.targetSurfaces || null;
  if (!Array.isArray(list) || !list.length) return true;
  return list
    .map((value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .includes(surface);
}

function safeFileStem(value) {
  return String(value || new Date().toISOString()).replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-|-$/g, "");
}

function shouldMaterializeClaudeNative() {
  return process.env.RELAY_MATERIALIZE_CLAUDE !== "0";
}
