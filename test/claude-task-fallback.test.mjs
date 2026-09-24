import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claudeLaunchPreflight, prepareClaudeDraft, findClaudeDraftSession } from "../src/claude-task-fallback.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("preflight counts live desktop processes, not working tasks or the RC default", async (t) => {
  const root = fixture(t);
  const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  put("1.json", { pid: 1, entrypoint: "claude-desktop", status: "idle" });
  put("duplicate.json", { pid: 1, entrypoint: "claude-desktop" });
  put("dead.json", { pid: 2, entrypoint: "claude-desktop" });
  put("cli.json", { pid: 3, entrypoint: "cli" });
  put("claude_desktop_config.json", { preferences: { ccRemoteControlDefaultEnabled: true } });
  const args = { registry: root, configDirs: [root], version: "2.7032.0", totalMemory: 16 * 1024 ** 3, isAlive: (pid) => pid !== 2 };
  const free = await claudeLaunchPreflight(args);
  assert.equal(free.liveProcesses, 1);
  assert.equal(free.manual, false);
  assert.equal(free.remoteControlDefault, true);
  for (let i = 4; i < 9; i++) put(`${i}.json`, { pid: i, entrypoint: "claude-desktop" });
  assert.equal((await claudeLaunchPreflight(args)).reason, "capacity");
  assert.equal((await claudeLaunchPreflight({ ...args, totalMemory: 64 * 1024 ** 3 })).manual, false);
  assert.equal((await claudeLaunchPreflight({ ...args, version: "future" })).reason, "unknown_version");
});
test("draft carries workspace and a bounded handshake, creates no transcript, binds only exact user input", (t) => {
  const root = fixture(t), cwd = path.join(root, "space & unicode é");
  fs.mkdirSync(cwd);
  let persisted;
  const draft = prepareClaudeDraft({ cwd, title: "Test\n" + "x".repeat(20000), persist: (s) => { persisted = s; } });
  assert.equal(persisted, draft);
  const url = new URL(draft.url);
  assert.equal(url.searchParams.get("folder"), cwd);
  assert.equal(url.searchParams.get("q"), draft.draftPrompt);
  assert.ok(draft.url.length < 2000);
  assert.equal(fs.readdirSync(cwd).length, 0);
  assert.equal(findClaudeDraftSession(draft, { home: root }), null);
  const dir = path.join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID(), file = path.join(dir, `${id}.jsonl`);
  const row = { type: "user", sessionId: id, cwd, message: { content: draft.draftPrompt } };
  for (const patch of [{ type: "assistant" }, { isSidechain: true }, { cwd: root }, { sessionId: "wrong" }, { message: { content: [{ type: "tool_result", content: draft.draftPrompt }] } }]) {
    fs.writeFileSync(file, JSON.stringify({ ...row, ...patch }) + "\n");
    assert.equal(findClaudeDraftSession(draft, { home: root }), null);
  }
  fs.writeFileSync(file, JSON.stringify(row) + "\n");
  assert.equal(findClaudeDraftSession(draft, { home: root }).nativeId, id);
  const other = randomUUID();
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), JSON.stringify({ ...row, sessionId: other }) + "\n");
  assert.throws(() => findClaudeDraftSession(draft, { home: root }), /more than one/);
});
