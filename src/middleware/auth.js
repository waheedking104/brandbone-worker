// src/middleware/auth.js
// JWT verification using Web Crypto API — no external library needed

export async function verifySupabaseJWT(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed token')

  const [headerB64, payloadB64, sigB64] = parts
  const encoder = new TextEncoder()

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )

  const sig  = base64urlToBuffer(sigB64)
  const data = encoder.encode(`${headerB64}.${payloadB64}`)
  const valid = await crypto.subtle.verify('HMAC', key, sig, data)
  if (!valid) throw new Error('Invalid signature')

  return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
}

function base64urlToBuffer(str) {
  const b64    = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=')
  const bin    = atob(padded)
  const buf    = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

// Require authenticated user
export const requireAuth = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ status: 'error', message: 'Sign in required.', error_code: 'AUTH_REQUIRED', data: null,
                    request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
  }

  const token = authHeader.slice(7)
  try {
    const payload = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET)
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ status: 'error', message: 'Session expired. Please sign in again.',
                      error_code: 'AUTH_EXPIRED', data: null,
                      request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
    }
    c.set('userId',    payload.sub)
    c.set('userEmail', payload.email)
    await next()
  } catch {
    return c.json({ status: 'error', message: 'Invalid session. Please sign in again.',
                    error_code: 'AUTH_INVALID', data: null,
                    request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
  }
    }
    
