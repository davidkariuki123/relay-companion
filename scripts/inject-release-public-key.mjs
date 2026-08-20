#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const algorithm = "ED25519_SHA_512";
const current = {
  keyId: String(process.env.RELAY_RELEASE_CURRENT_KEY_ID || "").trim(),
  publicKeyPem: String(process.env.RELAY_RELEASE_CURRENT_PUBLIC_KEY_PEM || "").trim(),
};
const previous = {
  keyId: String(process.env.RELAY_RELEASE_PREVIOUS_KEY_ID || "").trim(),
  publicKeyPem: String(process.env.RELAY_RELEASE_PREVIOUS_PUBLIC_KEY_PEM || "").trim(),
};

function valid(entry) {
  return /^relay-runtime-release-v\d+$/.test(entry.keyId) && entry.publicKeyPem.includes("BEGIN PUBLIC KEY");
}

if (!valid(current) || ((previous.keyId || previous.publicKeyPem) && !valid(previous)) || previous.keyId === current.keyId) {
  console.error("A unique current logical key id/public key and an optional unique previous key are required");
  process.exitCode = 1;
} else {
  const keys = [current, ...(previous.keyId ? [previous] : [])].map((entry) => ({ ...entry, algorithm }));
  const trust = { schema: 2, activeKeyId: current.keyId, keys };
  for (const relative of ["bootstrap/trust.json", "src/release-trust.json"]) {
    fs.writeFileSync(path.join(root, relative), `${JSON.stringify(trust, null, 2)}\n`);
  }
  console.log(`Injected Relay release keyring (${keys.map((entry) => entry.keyId).join(", ")}).`);
}
