// The invitation chapter is an account fact. Old local first-send completion,
// sign-in and sent history must never stand in for completing this chapter.
const NETWORK_ONBOARDING_VERSION = 2;

function createNetworkOnboarding({ identity, read, complete, changed = () => {}, persist = () => {}, completed = {}, presented = {}, now = Date.now }) {
  const states = new Map();
  function state(key) {
    if (!states.has(key)) states.set(key, { required: false, checked: false, retryAt: 0, pending: null });
    return states.get(key);
  }
  function observe(who, response) {
    if (response?.user?.id !== who.userId || !Number.isInteger(response.onboardingVersion)
        || response.onboardingVersion < 0 || response.requiredOnboardingVersion !== NETWORK_ONBOARDING_VERSION) return false;
    const current = state(who.key);
    // A GET begun before completion can arrive after it. Completion is monotonic.
    completed[who.key] = Math.max(Number(completed[who.key]) || 0, response.onboardingVersion);
    current.required = completed[who.key] < NETWORK_ONBOARDING_VERSION;
    current.checked = true;
    persist();
    return true;
  }
  const api = {
    status() {
      const who = identity();
      if (!who) return { required: false, checking: false, version: NETWORK_ONBOARDING_VERSION };
      const current = state(who.key);
      return { required: current.checked && current.required, checking: !current.checked,
        version: NETWORK_ONBOARDING_VERSION };
    },
    async refresh() {
      const who = identity();
      if (!who) return;
      const current = state(who.key);
      if (current.pending) return current.pending;
      if (now() < current.retryAt) return;
      current.retryAt = now() + 30_000;
      current.pending = (async () => {
        try {
          const response = await read(who);
          if (identity()?.key !== who.key) return;
          const before = JSON.stringify(api.status());
          if (observe(who, response) && before !== JSON.stringify(api.status())) changed();
        } catch { /* Unknown/offline is not evidence that someone owes onboarding. */ }
        finally { current.pending = null; }
      })();
      return current.pending;
    },
    async finish(expectedUserId) {
      const who = identity();
      if (!who || who.userId !== expectedUserId) throw new Error("Relay account changed. Try again.");
      const response = await complete(who, NETWORK_ONBOARDING_VERSION);
      if (identity()?.key !== who.key) throw new Error("Relay account changed. Try again.");
      if (!observe(who, response) || api.status().required) throw new Error("Relay could not save this step. Try again.");
      return { ok: true, userId: who.userId, version: NETWORK_ONBOARDING_VERSION };
    },
    shouldPresent(build) {
      const who = identity();
      return Boolean(who && api.status().required && presented[who.key] !== `${build}:${NETWORK_ONBOARDING_VERSION}`);
    },
    markPresented(build) {
      const who = identity();
      if (!who) return;
      presented[who.key] = `${build}:${NETWORK_ONBOARDING_VERSION}`;
      persist();
    },
  };
  return api;
}

module.exports = { createNetworkOnboarding, NETWORK_ONBOARDING_VERSION };
