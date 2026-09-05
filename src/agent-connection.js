import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "./client.js";
import { readConfig as companionConfig } from "./config.js";
import { persistPairedAccount } from "./account.js";
import identity from "./e2ee-identity.cjs";
import { readConfig, configPath, authenticatedRequest, atomicWrite } from "../skill/relay/scripts/relay-protocol.mjs";

// Called only by the explicitly consented agent-protocol setup. Startup and
// sign-out do not silently re-enroll a device using a leftover browser grant.
export async function adoptAgentConnection({
  readAgent = readConfig,
  readCompanion = companionConfig,
  makeClient = (url, token = "") => new RelayClient({ url, token }),
  request = authenticatedRequest,
  persistAccount = persistPairedAccount,
  createIdentity = identity.createPairingIdentity,
  persistIdentity = identity.persistPairedIdentity,
  journalFile = path.join(path.dirname(configPath()), "agent-companion-pairing.json"),
} = {}) {
  const agent = readAgent();
  const current = readCompanion();
  const expected = agent.account?.relayUserId;
  if (!expected || (agent.consentVersion ?? 1) < 2) throw new Error("Approve the updated Relay connection before installing Companion. The existing agent connection remains usable.");
  if (current.deviceToken) {
    if (current.user?.id !== expected || current.apiUrl !== agent.apiUrl) throw new Error("Companion is connected to another account or environment. Switch it explicitly before continuing.");
    try {
      const live = await makeClient(agent.apiUrl, current.deviceToken).me();
      if (live?.user?.id !== expected) throw new Error("Companion's live account does not match the approved connection.");
      return { connected: true, reused: true };
    } catch (error) {
      // An explicitly renewed browser grant can replace a revoked device
      // credential without sending the person through another sign-in.
      if (![401, 403].includes(Number(error.status)) || !agent.accessToken) throw error;
    }
  }
  const client = makeClient(agent.apiUrl);
  const me = await request(agent.apiUrl, agent.accessToken, "GET", "/v1/me");
  if (me?.user?.id !== expected) throw new Error("Relay's approved account does not match. Nothing was paired.");
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (journal && (journal.accountId !== expected || journal.apiUrl !== agent.apiUrl)) throw new Error("Another account has an unfinished Companion connection.");
  async function freshEnrollment() {
    const recoverySecret = randomBytes(32).toString("base64url");
    const pairing = await request(agent.apiUrl, agent.accessToken, "POST", "/v1/agent/companion/pairing-code", { recoverySecret });
    const name = os.hostname();
    const platform = process.platform;
    const keys = createIdentity({ pairingCode: pairing.code, name, platform });
    return { accountId: expected, apiUrl: agent.apiUrl, name, platform, pairingCode: pairing.code, recoverySecret, keys };
  }
  if (!journal) {
    journal = await freshEnrollment();
    atomicWrite(journalFile, journal);
  }
  if (!journal.registration) {
    // Persist the exact keys and code first. An ambiguous registration never
    // silently creates another identity; a retry uses the same enrollment.
    const register = () => client.registerDevice({ pairingCode: journal.pairingCode, recoverySecret: journal.recoverySecret, name: journal.name, platform: journal.platform, e2eeIdentity: journal.keys.request });
    try { journal.registration = await register(); }
    catch (error) {
      // Refresh only when the server proves the old code was never consumed.
      // Ambiguous responses and revoked registrations keep their original proof.
      if (error.status !== 400 || error.body?.message !== "Unused pairing code expired") throw error;
      journal = await freshEnrollment();
      atomicWrite(journalFile, journal);
      journal.registration = await register();
    }
    atomicWrite(journalFile, journal);
  }
  if (journal.registration.user?.id !== expected) throw new Error("Companion pairing returned another account.");
  persistIdentity(journal.keys.state, journal.registration);
  persistAccount({ apiUrl: agent.apiUrl, webUrl: agent.apiUrl.replace("dev-api.", "dev.").replace("api.", ""), deviceName: journal.name, registration: journal.registration, requireNativeCredential: true });
  fs.rmSync(journalFile, { force: true });
  return { connected: true, reused: false };
}
