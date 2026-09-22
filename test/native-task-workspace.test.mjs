// Where should the agent work? One short list of app-and-workspace pairs,
// best first: the Task's own repo, then this Topic's and this sender's
// earlier choices, then last time, then the checkouts this person works in.
// Every machine fact is injected, so this runs on any box.
import test from "node:test";
import assert from "node:assert/strict";
import { rememberWorkspaceChoice, senderKeyOf, topicKeyOf, workspaceChoices } from "../src/native-task-workspace.js";

const dirs = new Set(["/w/relay", "/w/agentos", "/w/notes", "/w/old"]);
const base = {
  providers: [{ provider: "codex", label: "Codex" }, { provider: "claude", label: "Claude Code" }],
  isDirectory: (p) => dirs.has(p.replace(/\\/g, "/").replace(/^[A-Z]:/, "")),
  trusted: () => true,
  checkouts: [
    { dir: "/w/relay", originKey: "github.com/owner/relay", lastUsedAt: 300, uses: 9, source: "codex" },
    { dir: "/w/agentos", originKey: "github.com/owner/agentos", lastUsedAt: 200, uses: 2, source: "claude" },
    { dir: "/w/notes", originKey: "", lastUsedAt: 100, uses: 1, source: "disk" },
  ],
};
const pairs = (choices) => choices.options.map((o) => `${o.provider}:${o.cwd.replace(/\\/g, "/").replace(/^[A-Z]:/, "")}`);
const norm = (p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, "");

test("a Task about a repo lands in this machine's checkout of it, both apps, last-used app first", () => {
  const packet = { senderEmail: "sven@example.com", source: { workspace: { kind: "git", key: "github.com/owner/relay", label: "relay" } } };
  const choices = workspaceChoices({ ...base, packet, preferences: { provider: "claude" } });
  assert.deepEqual(pairs(choices).slice(0, 2), ["claude:/w/relay", "codex:/w/relay"]);
  assert.equal(choices.options[0].label, "Claude Code · relay");
  assert.equal(choices.options[0].why, "This Task is about relay");
  assert.equal(choices.suggested, choices.options[0]);
  assert.equal(choices.question, "Where should the agent work?");
  assert.equal(choices.caption, "It will read and change files in this folder.");
});

test("a bare name resolves too; a repo this machine lacks fails closed to the short list, never a guess", () => {
  const named = workspaceChoices({ ...base, packet: { source: { workspace: { kind: "name", key: "agentos" } } } });
  assert.equal(norm(named.options[0].cwd), "/w/agentos");
  assert.equal(named.options[0].reason, "passport");
  const missing = workspaceChoices({ ...base, packet: { source: { workspace: { kind: "git", key: "github.com/other/elsewhere" } } } });
  assert.ok(missing.options.every((o) => o.reason === "recent"), "only recents remain");
  assert.equal(norm(missing.options[0].cwd), "/w/relay", "most recently used checkout first");
});

test("the Topic's and the sender's earlier choices come before last time and recents", () => {
  const packet = { senderEmail: "Sven@Example.com", inReplyToTopicPost: { topicId: "tpc_dev", postId: "p1" } };
  const preferences = {
    provider: "codex", cwd: "/w/old",
    byTopic: { tpc_dev: { provider: "claude", cwd: "/w/agentos" } },
    bySender: { "sven@example.com": { provider: "codex", cwd: "/w/notes" } },
  };
  const choices = workspaceChoices({ ...base, packet, preferences, senderName: "Sven" });
  assert.deepEqual(pairs(choices).slice(0, 4), ["claude:/w/agentos", "codex:/w/notes", "codex:/w/old", "claude:/w/old"]);
  assert.equal(choices.options[0].why, "Where this Topic's Tasks run");
  assert.equal(choices.options[1].why, "Where Sven's last Task ran");
  assert.equal(choices.options[2].why, "Last time");
});

test("only installed apps, only folders that exist, no duplicates, Claude only where it is trusted, capped", () => {
  const choices = workspaceChoices({
    ...base,
    providers: [{ provider: "claude", label: "Claude Code" }],
    trusted: (provider, cwd) => norm(cwd) !== "/w/notes",
    preferences: { cwd: "/w/relay" },
    packet: { source: { workspace: { kind: "name", key: "relay" } } },
    max: 2,
  });
  assert.deepEqual(pairs(choices), ["claude:/w/relay", "claude:/w/agentos"]);
  assert.deepEqual(choices.browse, [{ provider: "claude", label: "Claude Code · another folder…" }]);
  const gone = workspaceChoices({ ...base, preferences: { cwd: "/w/deleted" } });
  assert.ok(gone.options.every((o) => norm(o.cwd) !== "/w/deleted"));
  assert.deepEqual(workspaceChoices({ ...base, providers: [] }).options, []);
});

test("remembering a choice keys it by the sender's address and the Topic id, and keeps other memories", () => {
  const packet = { senderEmail: "Sven@Example.com", inReplyToTopicPost: { topicId: "tpc_dev" } };
  assert.equal(senderKeyOf(packet), "sven@example.com");
  assert.equal(topicKeyOf(packet), "tpc_dev");
  const patch = rememberWorkspaceChoice({ bySender: { "ana@example.com": { provider: "codex", cwd: "/w/notes", at: "t0" } } }, { packet, provider: "claude", cwd: "/w/relay", at: "t1" });
  assert.deepEqual(patch, {
    provider: "claude", cwd: "/w/relay",
    bySender: { "ana@example.com": { provider: "codex", cwd: "/w/notes", at: "t0" }, "sven@example.com": { provider: "claude", cwd: "/w/relay", at: "t1" } },
    byTopic: { tpc_dev: { provider: "claude", cwd: "/w/relay", at: "t1" } },
  });
  const bare = rememberWorkspaceChoice({}, { packet: {}, provider: "codex", cwd: "/w/relay", at: "t2" });
  assert.deepEqual(bare, { provider: "codex", cwd: "/w/relay" });
});
