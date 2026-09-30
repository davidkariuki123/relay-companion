import policy from "./product-features.cjs";

export const { runtimeEnvironment, productFeatures } = policy;

/** Server-owned entitlements require a fresh profile for this paired account. */
export async function accountProductFeatures({
  client,
  user,
  env = process.env,
  config = {},
  apiUrl = "",
  timeoutMs = 2_500,
} = {}) {
  let resolvedUser = user || null;
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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return productFeatures({ env, config, apiUrl, user: resolvedUser });
}
