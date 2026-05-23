// src/middleware/adminAuth.js
// Admin auth uses Supabase JWT + DB role check — NO static secret keys

import { verifySupabaseJWT } from './auth.js'
import { supabaseQuery }     from '../services/supabase.js'

export const requireAdmin = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ status: 'error', message: 'Admin authentication required.',
                    error_code: 'AUTH_REQUIRED', data: null,
                    request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
  }

  const token = authHeader.slice(7)
  let payload
  try {
    payload = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET)
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ status: 'error', message: 'Session expired.',
                      error_code: 'AUTH_EXPIRED', data: null,
                      request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
    }
  } catch {
    return c.json({ status: 'error', message: 'Invalid session.',
                    error_code: 'AUTH_INVALID', data: null,
                    request_id: c.get('requestId'), ts: new Date().toISOString() }, 401)
  }

  // Check admin role in DB
  try {
    const profiles = await supabaseQuery(c.env, 'user_profiles', 'GET', null,
      `?id=eq.${payload.sub}&select=role,status&limit=1`)

    const profile = profiles?.[0]
    if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
      return c.json({ status: 'error', message: 'Admin access required.',
                      error_code: 'FORBIDDEN', data: null,
                      request_id: c.get('requestId'), ts: new Date().toISOString() }, 403)
    }
    if (profile.status === 'banned') {
      return c.json({ status: 'error', message: 'Account suspended.',
                      error_code: 'BANNED', data: null,
                      request_id: c.get('requestId'), ts: new Date().toISOString() }, 403)
    }

    c.set('userId',    payload.sub)
    c.set('userEmail', payload.email)
    c.set('adminRole', profile.role)
    await next()
  } catch (err) {
    console.error('[AdminAuth] DB check failed:', err.message)
    return c.json({ status: 'error', message: 'Auth verification failed.',
                    error_code: 'INTERNAL_ERROR', data: null,
                    request_id: c.get('requestId'), ts: new Date().toISOString() }, 500)
  }
        }
                   
