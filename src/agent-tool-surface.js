import path from "node:path";
import { accountProductFeatures } from "./product-features.js";
import { apiUrl, readConfig } from "./config.js";
import {
  activeMcpEncryptionState, createMcpSessionContext, handleCall,
  rememberCallingClient, relayCallingSurface, relayCallErrorResult,
  toolsForAccount, toolsForE2eeLocalAccount,
} from "./mcp.js";

// A transport-independent entry to the same catalog and handlers used by MCP.
// No MCP server, session handshake, or agent restart is involved.
export function createAgentToolSurface(client, {
  featuresReader = () => accountProductFeatures({ client, config: readConfig(), apiUrl: apiUrl() }),
  encryptionReader = () => activeMcpEncryptionState(client),
} = {}) {
  const contexts = new Map();
  function context(caller = {}) {
    if (!caller || typeof caller !== "object" || Array.isArray(caller)) throw new Error("Invalid Relay caller context.");
    const cwd = typeof caller.cwd === "string" && path.isAbsolute(caller.cwd) ? caller.cwd : process.cwd();
    const host = ["codex", "claude_code"].includes(caller.host) ? caller.host : "";
    const nativeId = typeof caller.nativeId === "string" ? caller.nativeId.slice(0, 256) : "";
    const key = JSON.stringify([cwd, host, nativeId]);
    let session = contexts.get(key);
    if (!session) {
      session = createMcpSessionContext({ cwd, env: host === "codex" ? { CODEX_THREAD_ID: nativeId } : host === "claude_code" ? { CLAUDE_CODE_SESSION_ID: nativeId } : {}, argv: [], channelEnabled: false });
      session.sourceHost = "relay-agent-protocol";
      rememberCallingClient({ name: host === "codex" ? "codex-mcp-client" : host === "claude_code" ? "claude-code" : "" }, session);
      if (contexts.size >= 128) contexts.delete(contexts.keys().next().value);
      contexts.set(key, session);
    }
    return session;
  }
  async function catalog(caller) {
    const sessionContext = context(caller);
    const features = await featuresReader();
    const encryption = await encryptionReader();
    const surface = relayCallingSurface(sessionContext);
    const tools = encryption.enabled ? toolsForE2eeLocalAccount(features, surface) : toolsForAccount(features, surface);
    return { sessionContext, features, encryption, tools };
  }
  return {
    async list(caller) { return { tools: (await catalog(caller)).tools }; },
    async call(name, args = {}, caller) {
      try {
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
        const { tools, features, encryption, sessionContext } = await catalog(caller);
        if (!tools.some((tool) => tool.name === name)) throw new Error(`Tool ${name} is unavailable for this Relay account or encryption mode. Run tools to list available capabilities.`);
        return await handleCall(client, name, args, { features, shareLinks: !encryption.enabled, sessionContext });
      } catch (error) { return relayCallErrorResult(error); }
    },
  };
}
