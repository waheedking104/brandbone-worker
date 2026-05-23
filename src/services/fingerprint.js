// src/services/fingerprint.js
// Guest identity via hashed headers — more entropy than IP alone
// Not PII — original values never stored

export async function generateFingerprint(ip, ua, lang, encoding, country, timezone) {
  const raw  = `${ip}|${ua}|${lang}|${encoding}|${country}|${timezone}`
  const data = new TextEncoder().encode(raw)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

