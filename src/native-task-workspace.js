// Where should the agent work? The one question Execute still has to ask.
//
// A native app runs every conversation inside one folder: that is where the
// agent reads, changes and runs files. Execute used to ask for it twice, first
// "which app?" then a raw OS folder dialog, without ever saying what the folder
// was for. This module turns that into ONE short list of app-and-workspace
// pairs, best first, so the person recognises the answer instead of deriving
// it. The ladder, most specific first:
//
//   1. The Task's own workspace passport (source.workspace, stamped by the
//      sending agent and resolved against THIS machine's checkouts by
//      cwd-select.js / repo-index.js; sender paths are never used). A Task
//      about `relay` lands in this person's relay checkout.
//   2. Where this Topic's Tasks ran before, then where this sender's last Task
//      ran. Both are this person's own earlier choices, keyed by ids the
//      server issued, never by anything the sender typed.
//   3. Where Execute last ran at all.
//   4. The checkouts this person actually works in, by recency, from the same
//      index the Open actions use.
//   Then "another folder…" per installed app, which is the OS dialog.
//
// Pure: every fact about the machine is injected so the ranking is testable
// without one. Claude Code only ever opens a folder it has already been
// trusted with, so untrusted pairs are left off the list rather than offered
// and failed a moment later.
import fs from "node:fs";
import path from "node:path";
import { chooseOpenCwd } from "./cwd-select.js";
import { buildRepoIndex, findCheckouts } from "./repo-index.js";
import { claudeWorkspaceTrusted } from "./native-task-launch.js";

export const MAX_WORKSPACE_OPTIONS = 6;
export const WORKSPACE_QUESTION = "Where should the agent work?";
export const WORKSPACE_CAPTION = "It will read and change files in this folder.";

export function providerLabel(provider) { return provider === "codex" ? "Codex" : "Claude Code"; }
export function workspaceName(cwd) {
  const clean = String(cwd || "");
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}
export function senderKeyOf(packet) {
  return String(packet?.senderEmail || packet?.from?.email || "").trim().toLowerCase();
}
export function topicKeyOf(packet) {
  const ref = packet?.inReplyToTopicPost;
  return ref && typeof ref === "object" ? String(ref.topicId || "").trim() : "";
}

function defaultIsDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}
function usable(candidate, isDirectory) {
  const clean = String(candidate || "").trim();
  if (!clean) return "";
  const resolved = path.resolve(clean);
  return isDirectory(resolved) ? resolved : "";
}
function rememberedIn(map, key) {
  return key && map && typeof map === "object" && map[key] && typeof map[key] === "object" ? map[key] : null;
}
function safeIndex() {
  try { return buildRepoIndex(); } catch { return []; }
}

// The list the picker shows: { options, suggested, browse, question, caption }.
// `options` are launchable pairs, best first, each with the folder's `name`
// and the `app` the page draws separately; `browse` is one "another folder…"
// chip per installed app.
export function workspaceChoices({
  providers = [],
  preferences = {},
  packet = null,
  senderName = "",
  checkouts = null,
  isDirectory = defaultIsDirectory,
  trusted = (provider, cwd) => provider !== "claude" || claudeWorkspaceTrusted(cwd),
  findCheckoutsFn = null,
  max = MAX_WORKSPACE_OPTIONS,
} = {}) {
  const installed = providers.map((p) => String(p?.provider || "")).filter(Boolean);
  const question = WORKSPACE_QUESTION, caption = WORKSPACE_CAPTION;
  if (!installed.length) return { options: [], suggested: null, browse: [], question, caption };
  // The app Execute used last time is listed first within every rung.
  const providerOrder = [...installed].sort((a, b) => (a === preferences.provider ? -1 : b === preferences.provider ? 1 : 0));
  const options = [], seen = new Set();
  const add = (provider, cwd, reason, why) => {
    if (!installed.includes(provider)) return;
    const clean = usable(cwd, isDirectory);
    if (!clean) return;
    const key = `${provider}\n${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!trusted(provider, clean)) return;
    options.push({ provider, cwd: clean, name: workspaceName(clean), app: providerLabel(provider), label: `${providerLabel(provider)} · ${workspaceName(clean)}`, reason, why });
  };

  const route = chooseOpenCwd({
    row: packet,
    findCheckoutsFn: findCheckoutsFn || ((repo) => findCheckouts(repo, checkouts ? { index: checkouts } : {})),
    isDirectory,
    allowUnanchoredFallback: false,
  });
  if (route.openable && route.cwd) {
    const about = route.repoName || workspaceName(route.cwd);
    for (const provider of providerOrder) add(provider, route.cwd, "passport", `This Task is about ${about}`);
  }
  const byTopic = rememberedIn(preferences.byTopic, topicKeyOf(packet));
  if (byTopic) add(byTopic.provider, byTopic.cwd, "topic", "Where this Topic's Tasks run");
  const bySender = rememberedIn(preferences.bySender, senderKeyOf(packet));
  if (bySender) add(bySender.provider, bySender.cwd, "sender", `Where ${senderName ? `${senderName}'s` : "their"} last Task ran`);
  if (preferences.cwd) for (const provider of providerOrder) add(provider, preferences.cwd, "last", "Last time");

  const index = Array.isArray(checkouts) ? checkouts : safeIndex();
  const recent = [...index].sort((a, b) => (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0) || (Number(b.uses) || 0) - (Number(a.uses) || 0));
  for (const checkout of recent) {
    if (options.length >= max) break;
    const why = checkout.source === "codex" ? "Recent in Codex" : checkout.source === "claude" ? "Recent in Claude Code" : "On this device";
    for (const provider of providerOrder) add(provider, checkout.dir, "recent", why);
  }
  const trimmed = options.slice(0, max);
  return {
    options: trimmed,
    suggested: trimmed[0] || null,
    browse: providerOrder.map((provider) => ({ provider, app: providerLabel(provider), label: `${providerLabel(provider)} · another folder…` })),
    question, caption,
  };
}

// The preference patch that remembers a choice: at all, for this sender, and
// for this Topic. Keys are the sender's address and the server's Topic id.
export function rememberWorkspaceChoice(preferences = {}, { packet = null, provider, cwd, at = new Date().toISOString() } = {}) {
  const chosen = { provider: String(provider || ""), cwd: String(cwd || ""), at };
  const patch = { provider: chosen.provider, cwd: chosen.cwd };
  const senderKey = senderKeyOf(packet), topicKey = topicKeyOf(packet);
  if (senderKey) patch.bySender = { ...(preferences.bySender && typeof preferences.bySender === "object" ? preferences.bySender : {}), [senderKey]: chosen };
  if (topicKey) patch.byTopic = { ...(preferences.byTopic && typeof preferences.byTopic === "object" ? preferences.byTopic : {}), [topicKey]: chosen };
  return patch;
}
