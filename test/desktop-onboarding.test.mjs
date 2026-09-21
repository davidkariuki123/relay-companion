import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import onboarding from "../src/desktop-onboarding.cjs";
const { initialRun, reduce, createRunStore } = onboarding;
function send(state, type, fields = {}) { return reduce(state, { runId: state.id, revision: state.revision, type, ...fields }); }
for (const entry of ["home", "invite", "share"]) test(`${entry}: only verified events advance the complete journey`, () => {
  let state = initialRun({ entry });
  assert.throws(() => send(state, "HOST_VERIFIED", { accountId: "alice" }));
  assert.throws(() => send(state, "AGENT_STARTED", { guideVersion: 0, host: "codex" }));
  state = send(state, "AGENT_STARTED", { guideVersion: 1, host: "codex" });
  state = send(state, "AUTH_OPENED"); state = send(state, "AUTH_APPROVED");
  state = send(state, "ACCOUNT_SAVED", { accountId: "alice" });
  assert.throws(() => send(state, "HOST_VERIFIED", { accountId: "bob" }));
  state = send(state, "HOST_VERIFIED", { accountId: "alice" });
  if (entry === "invite") state = send(state, "SEND_CONFIRMED", { accountId: "alice", relayId: "sent-1" });
  state = send(state, "LINK_CREATED", { accountId: "alice", relayId: "link-1", url: "https://sendrelays.com/s/example" });
  state = send(state, "COMPLETED", { accountId: "alice" });
  assert.equal(state.stage, "complete");
  assert.throws(() => send(state, "AGENT_STARTED", { guideVersion: 1, host: "codex" }));
});
test("stale events, cancellations and process restart do not replay effects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-onboarding-state-"));
  try {
    const store = createRunStore(dir); const initial = store.write(initialRun());
    const cancelled = store.write(send(initial, "CANCELLED"));
    assert.deepEqual(createRunStore(dir).read(), cancelled);
    assert.throws(() => reduce(cancelled, { runId: initial.id, revision: 0, type: "AGENT_STARTED", guideVersion: 1, host: "codex" }));
    assert.throws(() => send(cancelled, "AUTH_OPENED"));
    assert.equal(fs.statSync(path.join(dir, "desktop-onboarding.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
