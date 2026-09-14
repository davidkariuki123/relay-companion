import assert from "node:assert/strict";
import test from "node:test";
import { handleCall, toolsForAccount } from "../src/mcp.js";
import { RelayClient } from "../src/client.js";
import { createServer } from "node:http";
import { once } from "node:events";

test("ordinary agents can prepare a team and transfer admin with stable request identities", async () => {
  const catalog = toolsForAccount({ requests: false });
  for (const name of ["relay_team_prepare", "relay_group_transfer_admin"]) assert.ok(catalog.some((tool) => tool.name === name));
  const calls = [];
  const client = {
    prepareTeam: async (input) => { calls.push(input); return { groupId: "grp_team", invite: { url: "https://example.com/i/organiser" } }; },
    transferGroupAdmin: async (id, input) => { calls.push({ id, ...input }); return { groupId: id, admin: { relayUserId: input.adminUserId } }; },
  };
  const prepare = { name: "Team", members: [{ email: "a@example.com" }], idempotencyKey: "prepare-once" };
  const prepared = await handleCall(client, "relay_team_prepare", prepare, { features: { requests: false } });
  assert.equal(JSON.parse(prepared.content[0].text).groupId, "grp_team");
  assert.deepEqual(calls[0], { ...prepare, groupId: undefined });
  await handleCall(client, "relay_group_transfer_admin", { groupId: "grp_team", adminUserId: "usr_a", idempotencyKey: "transfer-once" }, { features: { requests: false } });
  assert.deepEqual(calls[1], { id: "grp_team", adminUserId: "usr_a", idempotencyKey: "transfer-once" });
});

test("the client posts preparation and admin handover to their exact endpoints", async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, token: "test" });
    await client.prepareTeam({ name: "Team", members: [{ email: "a@example.com" }], idempotencyKey: "prepare-once" });
    await client.transferGroupAdmin("grp_team", { adminUserId: "usr_a", idempotencyKey: "transfer-once" });
    assert.ok(calls[0].url.endsWith("/v1/contact-groups/prepare-team"));
    assert.ok(calls[1].url.endsWith("/v1/contact-groups/grp_team/admin"));
    assert.equal(calls[1].body.idempotencyKey, "transfer-once");
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
