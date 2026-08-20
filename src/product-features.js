import policy from "./product-features.cjs";

export const { runtimeEnvironment, productFeatures } = policy;

/**
 * Prefer the server's current profile, with the last server-issued pairing
 * profile as an offline fallback. Product environment remains an independent
 * gate: a cached developer role never enables these surfaces in production,
 * and the backend independently enforces the same boundary.
 */
export async function accountProductFeatures({
  client,
  user,
  env = process.env,
  config = {},
  apiUrl = "",
  timeoutMs = 2_500,
} = {}) {
  let resolvedUser = user || config.user || null;
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
      resolvedUser = live?.user || resolvedUser;
    } catch {
      // Offline startup stays usable for ordinary Relays. The cached profile
      // came from pairing, never from an environment/config feature override.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return productFeatures({ env, config, apiUrl, user: resolvedUser });
}
