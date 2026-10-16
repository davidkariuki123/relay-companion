import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// What `relay doctor` says about the native launcher's own updates, read from
// the status file the application update worker writes. The worker used to
// fail every five minutes with a line nobody read when the channel's offer had
// no package for this computer (Dev, 10-16 October 2026); name it instead.
export function describeApplicationUpdate({ homeDir = os.homedir(), now = Date.now } = {}) {
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "application-update.json"), "utf8")); } catch { return null; }
  if (!status || typeof status !== "object" || typeof status.state !== "string") return null;
  const time = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
  const text = value => typeof value === "string" && value ? value : null;
  const report = {
    state: status.state, offerVersion: text(status.version), channel: text(status.channel),
    platform: text(status.platform), packageKind: text(status.packageKind),
    checkedAt: time(status.at), nextCheckAt: time(status.nextCheckAt), problem: null,
  };
  if (status.state === "no-package-for-platform") {
    report.problem = `the ${report.channel || "current"} launcher release ${report.offerVersion || "on offer"} has no`
      + ` ${report.packageKind ? `${report.packageKind} ` : ""}package for ${report.platform || "this computer"}, so this launcher cannot update`;
  } else if (status.state === "failed") {
    report.problem = `the last launcher update check failed${text(status.detail) ? `: ${status.detail}` : ""}`;
  }
  return report;
}

export function applicationUpdateDoctorLines(report) {
  if (!report) return [];
  if (report.state === "no-package-for-platform") {
    return [`  LAUNCHER CANNOT UPDATE: ${report.problem}`,
      "    nothing to repair on this computer: the release needs republishing with this platform's package",
      `    checked ${report.checkedAt || "unknown"}; next check ${report.nextCheckAt || "unknown"}`];
  }
  if (report.state === "failed") {
    return [`  LAUNCHER UPDATE FAILING: ${report.problem}`, `    checked ${report.checkedAt || "unknown"}; retrying ${report.nextCheckAt || "soon"}`];
  }
  return [`  launcher update: ${report.state}${report.offerVersion ? ` (offer ${report.offerVersion})` : ""}`];
}
