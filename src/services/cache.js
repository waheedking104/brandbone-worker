// src/services/cache.js
// Fail silently — cache miss = AI call. Never block requests.

export async function getCached(kvNamespace, key) {
  try {
    const val = await kvNamespace.get(key, { type: 'json' })
    return val || null
  } catch {
    return null  // KV read fail = cache miss = fine
  }
}

export async function setCache(kvNamespace, key, value, ttlSeconds = 3600) {
  try {
    await kvNamespace.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds })
  } catch (err) {
    // KV write fail = no problem (free plan limit or outage)
    console.warn('[Cache] Write skipped:', err.message)
  }
}

