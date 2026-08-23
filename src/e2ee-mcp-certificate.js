import { createHash } from "node:crypto";
import acme from "acme-client";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import { createE2eeMcpCertificateStore } from "./e2ee-mcp-certificate-store.js";

const { readPairedIdentity } = e2eeIdentityModule;
const DEFAULT_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function endpointDetails(endpoint) {
  const endpointId = String(endpoint?.endpointId || "");
  const url = new URL(String(endpoint?.url || ""));
  if (
    !/^[a-z0-9][a-z0-9-]{15,62}$/.test(endpointId)
    || url.protocol !== "https:"
    || url.pathname !== "/mcp"
    || url.search
    || url.hash
    || !url.hostname.startsWith(`${endpointId}.`)
  ) throw new Error("Relay returned an invalid encrypted Claude endpoint.");
  return { endpointId, hostname: url.hostname, url: url.toString() };
}

function validStoredCertificate(state, hostname, directoryUrl, now, renewalWindowMs) {
  if (!state || state.hostname !== hostname || state.directoryUrl !== directoryUrl) return false;
  const expiresAt = Date.parse(state.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > renewalWindowMs;
}

function dnsValue(keyAuthorization) {
  return createHash("sha256").update(keyAuthorization).digest("base64url");
}

/**
 * Obtain or renew the public certificate for a device-owned MCP origin. Both
 * the ACME account key and certificate key are created and encrypted locally;
 * Relay receives only the public DNS-01 digest needed for domain validation.
 */
export async function ensureE2eeMcpCertificate(client, {
  identity = readPairedIdentity(),
  store,
  acmeModule = acme,
  directoryUrl = process.env.RELAY_ACME_DIRECTORY_URL || acme.directory.letsencrypt.production,
  now = () => Date.now(),
  renewalWindowMs = DEFAULT_RENEWAL_WINDOW_MS,
  logger = () => {},
} = {}) {
  if (!identity) throw new Error("This Relay runtime is not an enrolled E2EE device.");
  const endpointResponse = await client.provisionE2eeRemoteEndpoint();
  const endpoint = endpointDetails(endpointResponse?.endpoint);
  const certificateStore = store || createE2eeMcpCertificateStore(identity);
  const current = certificateStore.read();
  if (validStoredCertificate(current, endpoint.hostname, directoryUrl, now(), renewalWindowMs)) {
    return {
      endpoint,
      key: current.certificateKey,
      cert: current.certificate,
      expiresAt: current.expiresAt,
      renewed: false,
    };
  }

  const accountKey = current?.accountKey || await acmeModule.crypto.createPrivateEcdsaKey("P-256");
  const [certificateKey, csr] = await acmeModule.crypto.createCsr({
    commonName: endpoint.hostname,
    altNames: [endpoint.hostname],
  });
  const acmeClient = new acmeModule.Client({ directoryUrl, accountKey });
  let publishedValue = "";
  const certificate = await acmeClient.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    challengeCreateFn: async (_authorization, challenge, keyAuthorization) => {
      if (challenge?.type !== "dns-01") throw new Error("Relay accepts only ACME DNS-01 validation.");
      publishedValue = dnsValue(keyAuthorization);
      await client.publishE2eeRemoteDnsChallenge(publishedValue);
    },
    challengeRemoveFn: async () => {
      if (!publishedValue) return;
      try { await client.removeE2eeRemoteDnsChallenge(publishedValue); }
      catch (error) { logger(`Claude certificate DNS cleanup will retry on renewal: ${error?.message || error}`); }
      publishedValue = "";
    },
  });
  const info = acmeModule.crypto.readCertificateInfo(certificate);
  const names = new Set([info?.domains?.commonName, ...(info?.domains?.altNames || [])].filter(Boolean));
  if (!names.has(endpoint.hostname) || !(info?.notAfter instanceof Date) || info.notAfter.getTime() <= now()) {
    throw new Error("The certificate authority returned an invalid Relay endpoint certificate.");
  }
  const state = certificateStore.write({
    accountKey: Buffer.isBuffer(accountKey) ? accountKey.toString("utf8") : String(accountKey),
    certificateKey: Buffer.isBuffer(certificateKey) ? certificateKey.toString("utf8") : String(certificateKey),
    certificate: Buffer.isBuffer(certificate) ? certificate.toString("utf8") : String(certificate),
    hostname: endpoint.hostname,
    expiresAt: info.notAfter.toISOString(),
    issuedAt: new Date(now()).toISOString(),
    directoryUrl,
  });
  return {
    endpoint,
    key: state.certificateKey,
    cert: state.certificate,
    expiresAt: state.expiresAt,
    renewed: true,
  };
}

export { dnsValue as e2eeMcpAcmeDnsValue, endpointDetails as validateE2eeMcpEndpoint };
