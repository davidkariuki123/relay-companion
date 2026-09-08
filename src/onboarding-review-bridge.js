// Browser-only IPC adapter for the explicitly labelled local rehearsal.
// Unknown operations fail closed instead of reaching native integrations.
(() => {
  const call = async (route, body) => {
    const response = await fetch(window.practiceBase + route, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${window.practiceAccess}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unavailable in practice mode");
    return result;
  };
  let listener;
  const bridge = {
    isTestOverlay: true, platform: "darwin",
    refresh: () => call("/practice/state"),
    accountInfo: async () => ({ ok: true, ...(await call("/practice/state")).account, credentialStatus: "available", version: "Local rehearsal", deviceName: "Practice browser", canHide: false }),
    onInbox: (callback) => { listener = callback; },
    capabilities: async () => ({ "Codex": { available: false, reason: "Practice mode — no native apps are opened" }, "Claude Code": { available: false, reason: "Practice mode — no native apps are opened" }, _codexDesktop: { available: false }, _claudeDesktop: { available: false } }),
    contacts: async () => (await call("/v1/contacts")).contacts,
    contactAdd: async ({ email }) => ({ ok: true, ...await call("/v1/contacts/on-relay", { email }) }),
    groups: async () => [],
    completeSetupTutorial: () => call("/practice/complete", {}),
    onboardingInviteLink: async () => ({ ok: true, invite: await call("/v1/invite-link", {}) }),
    copyOnboardingInviteLink: async () => { const result = await call("/v1/invite-link", {}); await navigator.clipboard.writeText(result.url); return { ok: true, ...result }; },
    copyText: async (text) => { await navigator.clipboard.writeText(String(text)); return { ok: true }; },
  };
  window.relay = new Proxy(bridge, { get(target, key) {
    if (key in target) return target[key];
    if (typeof key === "string" && /^(on|set|resize|prepareCard|cardSize|record)/.test(key)) return () => {};
    return async () => ({ ok: false, error: "This native action is unavailable in local practice." });
  } });
  setInterval(async () => { try { listener?.(await call("/practice/state")); } catch {} }, 1000);
})();
