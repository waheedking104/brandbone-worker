// src/middleware/optionalAuth.js
// Works for both guests AND logged-in users
// Does NOT block if token missing or invalid — just sets userId if valid

import { verifySupabaseJWT } from './auth.js'

export const optionalAuth = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const payload = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET)
      // Only set if token is valid AND not expired
      if (!payload.exp || payload.exp > Math.floor(Date.now() / 1000)) {
        c.set('userId',    payload.sub)
        c.set('userEmail', payload.email)
      }
      // If expired: treat as guest silently (frontend will refresh)
    } catch {
      // Invalid token: treat as guest silently
    }
  }
  await next()
}

