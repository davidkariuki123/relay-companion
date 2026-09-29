"use strict";

// Setup intent and transport activity must remain distinct: the application can
// use HTTPS and install a skill too. Unknown is never silently protocol-only.
function accessProfile({ application = false, protocol = false, observedTransport = null } = {}) {
  if (typeof application !== "boolean" || typeof protocol !== "boolean") throw new Error("Access registrations must be boolean");
  if (![null, "mcp", "https"].includes(observedTransport)) throw new Error("Unknown transport");
  return {
    access: application && protocol ? "both" : application ? "application" : protocol ? "protocol" : "unknown",
    observedTransport,
  };
}

function summarizeAccess(registrations = []) {
  const users = new Map();
  for (const record of registrations) {
    if (!record.userId || !["application", "protocol"].includes(record.kind) || record.active !== true) continue;
    const value = users.get(record.userId) || { application: false, protocol: false };
    value[record.kind] = true;
    users.set(record.userId, value);
  }
  const counts = { application: 0, protocol: 0, both: 0 };
  for (const value of users.values()) counts[accessProfile(value).access] += 1;
  return { users: users.size, counts };
}

module.exports = { accessProfile, summarizeAccess };
