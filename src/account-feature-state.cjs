"use strict";

const { productFeatures } = require("./product-features.cjs");

function accountFeatureKey({ config = {}, env = {}, apiUrl = "" } = {}) {
  const userId = String(config.user?.id || "").trim();
  const token = String(env.RELAY_DEVICE_TOKEN || config.deviceToken || "").trim();
  const endpoint = String(apiUrl || env.RELAY_API_URL || config.apiUrl || "").trim();
  return userId && token && endpoint ? JSON.stringify([endpoint, userId, token]) : "";
}

/** A server-verified role belongs to one account and one device credential. */
function createAccountFeatureState() {
  let key = null;
  let features = productFeatures({ user: null });

  function current(snapshot) {
    const nextKey = accountFeatureKey(snapshot);
    if (nextKey !== key) {
      key = nextKey;
      features = productFeatures({ ...snapshot, user: null });
    }
    return features;
  }

  function apply(requestSnapshot, serverUser, currentSnapshot) {
    const priorKey = key;
    const priorFeatures = features;
    current(currentSnapshot);
    const requestKey = accountFeatureKey(requestSnapshot);
    if (!requestKey || requestKey !== key || !serverUser?.id || serverUser.id !== requestSnapshot.config.user?.id) {
      return { applied: false, changed: priorKey !== key };
    }
    features = productFeatures({ ...currentSnapshot, user: serverUser });
    return { applied: true, changed: priorKey !== key || JSON.stringify(features) !== JSON.stringify(priorFeatures) };
  }

  function clear(snapshot) {
    const priorKey = key;
    const priorFeatures = features;
    key = accountFeatureKey(snapshot);
    features = productFeatures({ ...snapshot, user: null });
    return priorKey !== key || JSON.stringify(features) !== JSON.stringify(priorFeatures);
  }

  return { current, apply, clear };
}

module.exports = { accountFeatureKey, createAccountFeatureState };
