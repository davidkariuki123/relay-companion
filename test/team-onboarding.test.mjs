import assert from "node:assert/strict";
import test from "node:test";
import { handleCall, toolsForAccount } from "../src/mcp.js";
import { RelayClient } from "../src/client.js";
import { createServer } from "node:http";
import { once } from "node:events";

test("internal staff agents can prepare a team and transfer admin with stable request identities", async () => {
  const catalog = toolsForAccount({ requests: false, orgAdmin: true });
  for (const name of ["relay_team_prepare", "relay_group_transfer_admin"]) assert.ok(catalog.some((tool) => tool.name === name));
  const calls = [];
  const client = {
    prepareTeam: async (input) => { calls.push(input); return { groupId: "grp_team", invite: { url: "https://example.com/i/organiser" } }; },
    transferGroupAdmin: async (id, input) => { calls.push({ id, ...input }); return { groupId: id, admin: { relayUserId: input.adminUserId } }; },
  };
  const prepare = { name: "Team", members: [{ email: "a@example.com" }], idempotencyKey: "prepare-once" };
  const prepared = await handleCall(client, "relay_team_prepare", prepare, { features: { requests: false, orgAdmin: true } });
  assert.equal(JSON.parse(prepared.content[0].text).groupId, "grp_team");
  assert.deepEqual(calls[0], { ...prepare, groupId: undefined });
  await handleCall(client, "relay_group_transfer_admin", { groupId: "grp_team", adminUserId: "usr_a", idempotencyKey: "transfer-once" }, { features: { requests: false, orgAdmin: true } });
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


test("internal staff agents can prepare an org without emails and manage its shared invitation", async () => {
  const catalog = toolsForAccount({ requests: false, orgAdmin: true });
  const prepare = catalog.find(t => t.name === "relay_org_prepare");
  assert.ok(prepare && !prepare.inputSchema.required.includes("members"));
  assert.ok(catalog.some(t => t.name === "relay_org_invite"));
  const calls = [];
  const client = { prepareOrg: async input => { calls.push(input); return { groupId: "grp_org" }; }, orgInvite: async (id,input) => { calls.push({ id,...input }); return { invite: null }; } };
  await handleCall(client, "relay_org_prepare", { name: "Company", idempotencyKey: "org-prepare" }, { features: { requests: false, orgAdmin: true } });
  assert.deepEqual(calls[0], { name: "Company", groupId: undefined, members: undefined, idempotencyKey: "org-prepare" });
  await handleCall(client, "relay_org_invite", { groupId: "grp_org", action: "revoke", idempotencyKey: "org-revoke" }, { features: { requests: false, orgAdmin: true } });
  assert.deepEqual(calls[1], { id: "grp_org", action: "revoke", idempotencyKey: "org-revoke" });
});


test("ordinary and unknown account profiles neither see nor call privileged onboarding tools", async () => {
  for (const features of [{ requests: false }, { requests: true }, { requests: false, orgAdmin: false }]) {
    for (const name of ["relay_org_prepare", "relay_org_invite", "relay_team_prepare", "relay_group_transfer_admin"]) {
      assert.ok(!toolsForAccount(features).some(t => t.name === name));
      await assert.rejects(handleCall({}, name, {}, { features }), /Relay staff/);
    }
  }
});
