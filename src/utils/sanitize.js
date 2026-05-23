// src/utils/sanitize.js
const BLOCKED = [
  /ignore (previous|above|all) instructions/i,
  /forget (your|all) instructions/i,
  /you are now/i,
  /act as (a|an|if)/i,
  /jailbreak/i,
  /system prompt/i,
  /<script/i,
  /javascript:/i,
  /on(load|error|click)=/i
]

export function sanitize(input) {
  if (typeof input === 'string') {
    for (const p of BLOCKED) {
      if (p.test(input)) return '[BLOCKED]'
    }
    return input.trim().slice(0, 2000)
  }
  if (Array.isArray(input)) return input.map(sanitize)
  if (typeof input === 'object' && input !== null) {
    const out = {}
    for (const [k, v] of Object.entries(input)) out[k] = sanitize(v)
    return out
  }
  return input
}

