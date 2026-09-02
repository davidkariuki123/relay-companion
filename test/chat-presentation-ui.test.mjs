import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const bundle = fs.readFileSync(new URL("../overlay/chat-presentation.js", import.meta.url), "utf8");

test("the Companion loads the shared chat behaviour before its renderer", () => {
  const sharedAt = html.indexOf('<script src="./chat-presentation.js"></script>');
  const rendererAt = html.indexOf("<script>", sharedAt);
  assert.ok(sharedAt >= 0 && rendererAt > sharedAt);

  const context = {};
  vm.runInNewContext(bundle, context);
  const optimistic = context.RelayChatPresentation.chatMessageAuthorPresentation({
    direction:"out",
    sender:{ name:"Codex" },
    source:{ host:"relay-agent-run", surface:"codex" },
    ownedAgent:true,
  });
  const canonical = context.RelayChatPresentation.chatMessageAuthorPresentation({
    direction:"out",
    sender:{ name:"Shane's Codex" },
    source:{ host:"relay-agent-run", surface:"codex" },
    ownedAgent:true,
  });
  assert.equal(optimistic.key, canonical.key);
  assert.equal(optimistic.label, canonical.label);
});
