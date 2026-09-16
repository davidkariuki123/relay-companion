import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ownership from "../bootstrap/application-owner.cjs";

// A separate optional header preserves strict schema-1 health telemetry on old
// APIs. Never send paths, credentials or free-form installer error output.
export function applicationTelemetryHeader({ homeDir = os.homedir(), platform = process.platform, now = Date.now } = {}) {
  try {
    const read = name => { try { return JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", name), "utf8")); } catch { return null; } };
    const owner = ownership.applicationOwner({ homeDir, platform });
    const status = read("application-update.json");
    const migration = read("application-migration.json");
    const word = value => typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value) ? value : null;
    const version = value => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
    const source = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
    return Buffer.from(JSON.stringify({ schema: 1, method: owner ? "native" : "classic", arch: process.arch,
      applicationVersion: version(owner?.installedPackageVersion), sourceSha: source(owner?.installedPackagingSourceSha),
      offerVersion: version(status?.version), state: word(status?.state), reason: word(status?.reason),
      migrationState: word(migration?.state), reportedAt: new Date(now()).toISOString(),
    })).toString("base64url");
  } catch { return ""; }
}
