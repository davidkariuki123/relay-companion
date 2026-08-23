import e2eeIdentityModule from "./e2ee-identity.cjs";
import {
  activeDeviceFromTransparency,
  mutateE2eeDeviceTrust,
  readE2eeDeviceTrust,
  syncTransparency,
} from "./e2ee-state.js";

const {
  createDeviceCrossSignature,
  readPairedIdentity,
  verifyDeviceCrossSignature,
} = e2eeIdentityModule;

export class E2eeDeviceApprovalRequiredError extends Error {
  constructor(relayUserId, pendingDevices) {
    super(
      pendingDevices.length === 1
        ? "This person has a new device that has not been approved yet. Nothing was sent to it."
        : `This person has ${pendingDevices.length} new devices that have not been approved yet. Nothing was sent to them.`,
    );
    this.name = "E2eeDeviceApprovalRequiredError";
    this.code = "e2ee_device_approval_required";
    this.relayUserId = relayUserId;
    this.pendingDevices = pendingDevices;
  }
}

function activeTransparencyDirectory(transparency, relayUserId) {
  return Object.fromEntries(
    Object.entries(transparency.users?.[relayUserId]?.devices || {})
      .filter(([, device]) => !device.revokedAt && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now())),
  );
}

function verifiedDirectory(identity, relayUserId, directory, transparency) {
  if (directory?.relayUserId !== relayUserId) {
    throw new Error("Relay returned a device directory for the wrong account.");
  }
  const expected = activeTransparencyDirectory(transparency, relayUserId);
  const devices = new Map((directory.devices || []).map((device) => [device.deviceId, device]));
  const expectedIds = Object.keys(expected).sort();
  const actualIds = [...devices.keys()].sort();
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((deviceId, index) => deviceId !== actualIds[index])
  ) throw new Error("Relay's device directory does not match the append-only transparency history.");
  for (const [deviceId, device] of devices) {
    const known = activeDeviceFromTransparency(transparency, relayUserId, deviceId);
    if (
      !known ||
      known.protocol !== device.protocol ||
      known.cipherSuite !== device.cipherSuite ||
      known.signaturePublicKey !== device.signaturePublicKey ||
      known.fingerprint !== device.fingerprint
    ) throw new Error("Relay's device identity does not match the append-only transparency history.");
  }

  const edges = [];
  for (const proof of directory.crossSignatures || []) {
    const signer = devices.get(proof.signerDeviceId);
    const subject = devices.get(proof.subjectDeviceId);
    // A proof whose signer has since been revoked is historical and cannot add
    // a current edge. A proof between active devices must verify locally.
    if (!signer || !subject) continue;
    if (
      subject.fingerprint !== proof.subjectFingerprint ||
      signer.fingerprint !== proof.signerFingerprint ||
      !verifyDeviceCrossSignature({ relayUserId, signer, proof })
    ) throw new Error("Relay returned an invalid device approval proof.");
    edges.push([signer.deviceId, subject.deviceId]);
  }
  if (relayUserId === identity.userId && !devices.has(identity.deviceId)) {
    throw new Error("This device is missing from its own verified directory.");
  }
  return { devices, edges };
}

function trustRecord(device, trustedAt, via) {
  return { fingerprint: device.fingerprint, trustedAt, via };
}

/**
 * Apply TOFU once for a contact, then extend only through valid old-device ->
 * new-device signatures. For the owner's own account, this device is the trust
 * anchor and signed edges are traversed both ways so the approved new device
 * can recognize the older signer that explicitly vouched for it.
 */
export function evaluateE2eeDeviceTrust({ identity, relayUserId, directory, transparency, stored, now = new Date() }) {
  const { devices, edges } = verifiedDirectory(identity, relayUserId, directory, transparency);
  const existing = stored?.users?.[relayUserId];
  const firstUse = !existing;
  const trusted = new Set();
  if (firstUse) {
    if (relayUserId === identity.userId) trusted.add(identity.deviceId);
    else for (const deviceId of devices.keys()) trusted.add(deviceId);
  } else {
    for (const [deviceId, pin] of Object.entries(existing.devices || {})) {
      const device = devices.get(deviceId);
      if (device && device.fingerprint === pin.fingerprint) trusted.add(deviceId);
    }
    if (relayUserId === identity.userId) trusted.add(identity.deviceId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [signer, subject] of edges) {
      if (trusted.has(signer) && !trusted.has(subject)) {
        trusted.add(subject);
        changed = true;
      }
      if (relayUserId === identity.userId && trusted.has(subject) && !trusted.has(signer)) {
        trusted.add(signer);
        changed = true;
      }
    }
  }

  const timestamp = now.toISOString();
  const nextUser = {
    firstSeenAt: existing?.firstSeenAt || timestamp,
    devices: { ...(existing?.devices || {}) },
  };
  for (const deviceId of trusted) {
    const device = devices.get(deviceId);
    if (!device) continue;
    const previous = nextUser.devices[deviceId];
    if (!previous || previous.fingerprint !== device.fingerprint) {
      nextUser.devices[deviceId] = trustRecord(device, timestamp, firstUse ? "first_use" : "cross_signed");
    }
  }
  const trustedDevices = [...trusted].map((deviceId) => devices.get(deviceId)).filter(Boolean);
  const pendingDevices = [...devices.values()].filter((device) => !trusted.has(device.deviceId));
  return { firstUse, trustedDevices, pendingDevices, nextUser };
}

export async function inspectE2eeDeviceTrust(client, relayUserId, { identity = readPairedIdentity(), options = {} } = {}) {
  if (!identity) throw new Error("This device has no enrolled encryption identity.");
  const transparency = await syncTransparency(client, identity, options);
  const directory = await client.e2eeDirectory(relayUserId);
  const stored = readE2eeDeviceTrust(identity, options);
  const evaluated = evaluateE2eeDeviceTrust({ identity, relayUserId, directory, transparency, stored });
  mutateE2eeDeviceTrust(identity, (state) => { state.users[relayUserId] = evaluated.nextUser; }, options);
  return { ...evaluated, directory, transparency };
}

export async function assertE2eeRecipientDevicesTrusted(client, relayUserId, context = {}) {
  const evaluated = await inspectE2eeDeviceTrust(client, relayUserId, context);
  if (evaluated.pendingDevices.length) {
    throw new E2eeDeviceApprovalRequiredError(relayUserId, evaluated.pendingDevices);
  }
  return evaluated;
}

export async function assertE2eeSenderDeviceTrusted(client, relayUserId, senderDeviceId, context = {}) {
  const evaluated = await inspectE2eeDeviceTrust(client, relayUserId, context);
  // Message authentication already proves that this device was enrolled at the
  // ciphertext's signed transparency checkpoint. A later revocation removes it
  // from the live directory, but must not make historical ciphertext unreadable.
  // The approval gate is therefore relevant only while the sender device is
  // still active in the current directory.
  if (!evaluated.directory.devices.some((device) => device.deviceId === senderDeviceId)) {
    return { ...evaluated, historicalSender: true };
  }
  if (!evaluated.trustedDevices.some((device) => device.deviceId === senderDeviceId)) {
    throw new E2eeDeviceApprovalRequiredError(
      relayUserId,
      evaluated.pendingDevices.filter((device) => device.deviceId === senderDeviceId),
    );
  }
  return evaluated;
}

export async function listOwnE2eeDeviceApprovals(client, context = {}) {
  const identity = context.identity || readPairedIdentity();
  if (!identity) return { available: false, devices: [], pendingDevices: [] };
  const evaluated = await inspectE2eeDeviceTrust(client, identity.userId, { ...context, identity });
  return {
    available: true,
    currentDeviceId: identity.deviceId,
    devices: evaluated.directory.devices.map((device) => ({
      ...device,
      current: device.deviceId === identity.deviceId,
      trusted: evaluated.trustedDevices.some((item) => item.deviceId === device.deviceId),
    })),
    pendingDevices: evaluated.pendingDevices,
  };
}

export async function approveOwnE2eeDevice(client, targetDeviceId, context = {}) {
  const identity = context.identity || readPairedIdentity();
  if (!identity) throw new Error("This device has no enrolled encryption identity.");
  const before = await inspectE2eeDeviceTrust(client, identity.userId, { ...context, identity });
  const target = before.pendingDevices.find((device) => device.deviceId === targetDeviceId);
  if (!target) throw new Error("That device is not awaiting approval.");
  const proof = createDeviceCrossSignature(identity, target);
  await client.e2eeCrossSignDevice(proof);
  const after = await inspectE2eeDeviceTrust(client, identity.userId, { ...context, identity });
  if (!after.trustedDevices.some((device) => device.deviceId === targetDeviceId)) {
    throw new Error("The new device approval could not be verified after publication.");
  }
  let history = null;
  let historyError = "";
  try {
    history = await client.offerDeviceHistory(targetDeviceId, {
      idempotencyKey: `approve-history:${identity.deviceId}:${targetDeviceId}:${target.fingerprint}`,
    });
  } catch (error) {
    historyError = error?.message || String(error);
  }
  return { approved: true, device: target, history, historyError };
}
