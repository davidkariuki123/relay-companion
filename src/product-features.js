import policy from "./product-features.cjs";

export const { runtimeEnvironment, productFeatures } = policy;

/**
 * Server-owned entitlements require a fresh profile for this paired account.
 * `verified` says whether the server's answer was actually heard: false when
 * the lookup failed or timed out, true when it answered (even "not a
 * developer", or a different account). Only an unheard answer is worth asking
 * again; a heard one is the authority.
 */
export async function resolveAccountProductFeatures({
  client,
  user,
  env = process.env,
  config = {},
  apiUrl = "",
  timeoutMs = 2_500,
} = {}) {
  let resolvedUser = user || null;
  let verified = true;
  if (client?.me && client?.token) {
    let timer;
    try {
      const live = await Promise.race([
        client.me(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Relay profile lookup timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
      resolvedUser = live?.user?.id && live.user.id === config.user?.id ? live.user : null;
    } catch {
      // Ordinary Relays remain usable offline. A saved role is not authority to
      // expose developer-only tools after the device changes accounts.
      resolvedUser = null;
      verified = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { features: productFeatures({ env, config, apiUrl, user: resolvedUser }), verified };
}

export async function accountProductFeatures(options = {}) {
  return (await resolveAccountProductFeatures(options)).features;
}

/** How long a session waits between profile checks it could not complete. */
export const PROFILE_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);

/**
 * A session whose first profile check went unheard (the app had just
 * restarted, or the network dropped) would otherwise keep the ordinary tool
 * list for its whole life. Ask again in the background, backing off to every
 * five minutes, and hand the first heard answer to `onResolved` once.
 */
export function retryAccountProductFeatures({
  resolve,
  onResolved,
  delaysMs = PROFILE_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let attempt = 0;
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
    attempt += 1;
    timer = setTimer(async () => {
      timer = null;
      if (stopped) return;
      let result = null;
      try { result = await resolve(); } catch { result = null; }
      if (stopped) return;
      if (result?.verified) {
        stopped = true;
        onResolved(result.features);
        return;
      }
      schedule();
    }, delay);
    timer?.unref?.();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
