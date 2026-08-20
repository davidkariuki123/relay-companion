#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

function exactParts(value, label) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${label} must be an exact stable version`);
  return version.split(".").map(Number);
}

export function compareExactVersions(left, right) {
  const a = exactParts(left, "Candidate version");
  const b = exactParts(right, "Current version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertMonotonicVersion(candidate, current, label = "release channel") {
  if (!String(current || "").trim()) return true;
  if (compareExactVersions(candidate, current) < 0) {
    throw new Error(`${label} cannot move backward from ${current} to ${candidate}; reissue the last-good code at a higher version`);
  }
  return true;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertMonotonicVersion(option("--candidate"), option("--current"), option("--label") || "release channel");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
