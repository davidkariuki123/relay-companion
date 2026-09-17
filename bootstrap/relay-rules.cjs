"use strict";

// The Claude Code rules file: Relay's one always-on carrier there.
//
// Claude Code cuts MCP server instructions and every tool description at 2,048
// characters, and defers most tool descriptions behind a search, so the
// milestone doctrine cannot ride the handshake the way it does in Codex. What
// Claude Code does re-send on every request, uncapped, is the user's rules
// directory (~/.claude/rules/*.md, loaded like CLAUDE.md, verified in 2.1.271).
// Measured on 2026-09-17: the doctrine in a rules file moved the milestone
// rate from 1/6 to 6/6 on Sonnet with 0/6 false positives; the same text in
// the 2 KB handshake alone moved nothing.
//
// One file, Relay-owned, installed and updated with the managed skill under the
// same consent, and removed with it. A human edit is kept and reported, never
// overwritten, like a modified skill file: the sidecar record under Relay's own
// state directory remembers the exact bytes Relay wrote, so ownership never
// depends on parsing the file.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const content = require("./relay-rules-content.cjs");

const RULES_FILE_NAME = "relay.md";
const STATE_FILE_NAME = "agent-rules.json";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function claudeRulesPath({ homeDir = os.homedir(), env = process.env } = {}) {
  // The same root the managed skill uses for Claude Code (relay-skill.cjs).
  const root = env.CLAUDE_HOME || path.join(homeDir, ".claude");
  return path.join(root, "rules", RULES_FILE_NAME);
}

function statePath({ homeDir = os.homedir(), env = process.env } = {}) {
  return path.join(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"), STATE_FILE_NAME);
}

function renderRulesFile(version) {
  const stamp = /^\d+\.\d+\.\d+$/.test(String(version || "")) ? ` (skill ${version})` : "";
  return [
    `<!-- Relay rules${stamp}. Installed by Relay Companion with the Relay skill and updated with it; removed when Relay is uninstalled. Your own edits are kept and reported, never overwritten. -->`,
    "",
    content.milestoneGuide,
  ].join("\n");
}

function readState(options) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(options), "utf8"));
    if (state?.schemaVersion !== 1 || typeof state.sha256 !== "string" || typeof state.path !== "string") return null;
    return state;
  } catch {
    return null;
  }
}

function writeState(options, state) {
  const file = statePath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function fileHash(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomically(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(staging, bytes, { mode: 0o600 });
  try {
    fs.renameSync(staging, file);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
  }
}

/**
 * Install or refresh the rules file for Claude Code.
 *
 * Statuses: installed, updated, current, kept_local_edit (a file Relay did not
 * write, or one the person changed since; left alone and reported, ok stays
 * true because a person's own rules are theirs), failed.
 */
function install(options = {}) {
  const file = claudeRulesPath(options);
  const expected = renderRulesFile(options.version);
  const expectedHash = sha256(expected);
  try {
    const state = readState(options);
    const current = fileHash(file);
    const managed = Boolean(state) && state.path === file && current !== null && current === state.sha256;
    if (current !== null && !managed) {
      if (current === expectedHash) {
        // Relay's own bytes, written by an installer whose record was lost.
        writeState(options, { schemaVersion: 1, path: file, sha256: current, version: options.version || null, installedAt: new Date().toISOString() });
        return { ok: true, status: "current", file };
      }
      return { ok: true, status: "kept_local_edit", file };
    }
    if (current === expectedHash) return { ok: true, status: "current", file };
    writeAtomically(file, expected);
    writeState(options, { schemaVersion: 1, path: file, sha256: expectedHash, version: options.version || null, installedAt: new Date().toISOString() });
    return { ok: true, status: current === null ? "installed" : "updated", file };
  } catch (error) {
    return { ok: false, status: "failed", file, error: error?.message || String(error) };
  }
}

/** Remove the rules file only when it still holds exactly what Relay wrote. */
function uninstall(options = {}) {
  const file = claudeRulesPath(options);
  try {
    const state = readState(options);
    const current = fileHash(file);
    if (current === null) {
      if (state) fs.rmSync(statePath(options), { force: true });
      return { ok: true, status: "already_absent", file };
    }
    const managed = (state && state.path === file && current === state.sha256) || current === sha256(renderRulesFile(state?.version));
    if (!managed) return { ok: true, status: "kept_local_edit", file };
    fs.rmSync(file, { force: true });
    if (state) fs.rmSync(statePath(options), { force: true });
    return { ok: true, status: "removed", file };
  } catch (error) {
    return { ok: false, status: "failed", file, error: error?.message || String(error) };
  }
}

function status(options = {}) {
  const file = claudeRulesPath(options);
  const state = readState(options);
  const current = fileHash(file);
  return {
    file,
    exists: current !== null,
    managed: Boolean(state) && state.path === file && current !== null && current === state.sha256,
    version: state?.version || null,
  };
}

module.exports = { RULES_FILE_NAME, STATE_FILE_NAME, claudeRulesPath, statePath, renderRulesFile, install, uninstall, status };
