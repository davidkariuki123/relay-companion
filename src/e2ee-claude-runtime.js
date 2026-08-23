import e2eeIdentityModule from "./e2ee-identity.cjs";
import { ensureE2eeMcpCertificate } from "./e2ee-mcp-certificate.js";
import { createE2eeMcpOAuth } from "./e2ee-mcp-oauth.js";
import { startE2eeRemoteMcpHttpServer } from "./e2ee-remote-mcp.js";
import { E2eeMcpTunnelClient } from "./e2ee-mcp-tunnel.js";
import {
  readE2eeClaudeIntent,
  writeE2eeClaudeStatus,
} from "./e2ee-claude-control.js";

const { readPairedIdentity } = e2eeIdentityModule;

function validateLease(value, endpointId) {
  if (
    value?.endpointId !== endpointId
    || !String(value?.lease || "")
    || value?.control?.tls !== true
    || !String(value?.control?.host || "")
    || !Number.isInteger(value?.control?.port)
  ) throw new Error("Relay returned an invalid encrypted tunnel lease.");
  return value;
}

export async function startE2eeClaudeRuntime({
  client,
  identity = readPairedIdentity(),
  certificateProvider = ensureE2eeMcpCertificate,
  oauthFactory = createE2eeMcpOAuth,
  originStarter = startE2eeRemoteMcpHttpServer,
  TunnelClient = E2eeMcpTunnelClient,
  logger = () => {},
  renewalIntervalMs = 6 * 60 * 60 * 1000,
} = {}) {
  if (!identity) throw new Error("This Relay runtime is not an enrolled E2EE device.");
  const certificate = await certificateProvider(client, { identity, logger });
  const publicOrigin = new URL(certificate.endpoint.url).origin;
  const oauth = oauthFactory({ publicOrigin, client, identity });
  const origin = await originStarter({
    client,
    oauth,
    tls: { key: certificate.key, cert: certificate.cert },
  });
  let tunnel;
  let renewalTimer;
  try {
    const initialLease = validateLease(await client.e2eeRemoteTunnelLease(), certificate.endpoint.endpointId);
    const localPort = Number(new URL(origin.url).port);
    tunnel = new TunnelClient({
      gatewayHost: initialLease.control.host,
      gatewayPort: initialLease.control.port,
      gatewayServerName: initialLease.control.host,
      localPort,
      leaseProvider: async () => validateLease(
        await client.e2eeRemoteTunnelLease(),
        certificate.endpoint.endpointId,
      ),
    });
    await tunnel.start();
    renewalTimer = setInterval(async () => {
      try {
        const renewed = await certificateProvider(client, { identity, logger });
        if (renewed.renewed) origin.server.setSecureContext({ key: renewed.key, cert: renewed.cert });
      } catch (error) {
        logger(`Claude certificate renewal failed: ${error?.message || error}`);
      }
    }, renewalIntervalMs);
    renewalTimer.unref?.();
  } catch (error) {
    await tunnel?.stop().catch(() => {});
    await origin.close().catch(() => {});
    throw error;
  }
  return {
    endpointUrl: certificate.endpoint.url,
    oauth,
    origin,
    tunnel,
    openEnrollmentWindow(options) { return oauth.openEnrollmentWindow(options); },
    async stop() {
      clearInterval(renewalTimer);
      await tunnel.stop();
      await origin.close();
    },
  };
}

export function createE2eeClaudeRuntimeController({
  client,
  identity = readPairedIdentity(),
  runtimeStarter = startE2eeClaudeRuntime,
  controlOptions = {},
  logger = () => {},
} = {}) {
  let runtime = null;
  let starting = null;
  let handledRequestId = "";

  const stop = async () => {
    const active = runtime;
    runtime = null;
    if (active) await active.stop();
  };

  return {
    async tick() {
      if (!identity) return { ready: false, reason: "not-enrolled" };
      const intent = readE2eeClaudeIntent(identity, controlOptions);
      if (!intent?.enabled) {
        await stop();
        return { ready: false, reason: "disabled" };
      }
      try {
        if (!runtime) {
          starting ||= runtimeStarter({ client, identity, logger });
          runtime = await starting;
          starting = null;
        }
        let enrollmentExpiresAt = "";
        if (intent.requestId && intent.requestId !== handledRequestId) {
          enrollmentExpiresAt = runtime.openEnrollmentWindow().expiresAt;
          handledRequestId = intent.requestId;
        }
        const status = writeE2eeClaudeStatus(identity, {
          ready: true,
          endpointUrl: runtime.endpointUrl,
          handledRequestId,
          enrollmentExpiresAt,
        }, controlOptions);
        return status;
      } catch (error) {
        starting = null;
        await stop().catch(() => {});
        const message = error?.message || String(error);
        logger(`Encrypted Claude runtime unavailable: ${message}`);
        return writeE2eeClaudeStatus(identity, {
          ready: false,
          handledRequestId: intent.requestId,
          error: message,
        }, controlOptions);
      }
    },
    stop,
    current: () => runtime,
  };
}
