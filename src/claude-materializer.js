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
    const { forHuman: forHumanPath, forAgent: forAgentPath } = materializeRelayOpenDocumentFiles(row, { provider: "claude-inbox" });
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

export function materializeRelayOpenDocumentFiles(row, { provider = "provider-inbox" } = {}) {
  const relayDir = path.join(storeDir(), safeFileStem(provider), safeFileStem(row?.id || row?.createdAt));
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
