"use strict";
const { PLATFORMS } = require("./migration.cjs");

// Read-only release readiness. No feed writes and no acceptance of boolean
// "tested" flags without an exact target identity. Native validation still has
// to supply evidence from stock builds on each OS/architecture.
const QUALIFICATIONS = ["fresh-install", "bridge", "interrupted-bridge", "next-runtime-update", "next-package-update",
  "independent-recovery", "sign-in", "deep-links", "agent-integrations", "uninstall"];
function evaluateRelease({ distribution, version, sourceSha, runtimeSourceSha, proofs = [], macSigning = [], windowsSigning,
  protocolReady = false, repairPathReady = false } = {}) {
  const blockers = [];
  if (distribution !== "application") blockers.push("preview-is-not-releasable");
  if (!/^\d+\.\d+\.\d+$/.test(version || "") || ![sourceSha, runtimeSourceSha].every(sha => /^[a-f0-9]{40}$/.test(sha || ""))) blockers.push("exact-release-identity-required");
  for (const platform of PLATFORMS) {
    for (const kind of QUALIFICATIONS) {
      if (!proofs.some((proof) => proof.platform === platform && proof.kind === kind && proof.version === version
        && proof.sourceSha === sourceSha && proof.runtimeSourceSha === runtimeSourceSha
        && proof.ok === true && typeof proof.receipt === "string" && proof.receipt.trim())) {
        blockers.push(`${platform}:${kind}`);
      }
    }
  }
  for (const platform of ["darwin-arm64", "darwin-x64"]) {
    if (!macSigning.some((proof) => proof.platform === platform && proof.version === version && proof.sourceSha === sourceSha
      && proof.developerId === true && proof.notarized === true && proof.stapled === true && proof.receipt)) blockers.push(`${platform}:signing`);
  }
  if (!["signed", "unsigned-accepted"].includes(windowsSigning)) blockers.push("windows-signing-policy-required");
  if (!protocolReady) blockers.push("protocol-onboarding-not-ready");
  if (!repairPathReady) blockers.push("installer-repair-path-not-ready");
  return { ready: blockers.length === 0, blockers, fleetMutationAllowed: false,
    stuckUserRecoveryRequired: false, broadcastAllowed: false };
}

module.exports = { evaluateRelease, QUALIFICATIONS };
