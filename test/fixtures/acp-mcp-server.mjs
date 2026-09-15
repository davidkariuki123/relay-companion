import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "relay-acp-smoke", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "acp_smoke_marker", description: "Read the harmless ACP integration-test marker.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
  else if (request.method === "tools/call" && request.params.name === "acp_smoke_marker") result = { content: [{ type: "text", text: process.env.ACP_FIXTURE_MARKER || "MISSING" }] };
  else if (request.method === "ping") result = {};
  else { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`); return; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
