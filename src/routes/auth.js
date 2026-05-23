// src/routes/auth.js
import { Hono }            from 'hono'
import { requireAuth }     from '../middleware/auth.js'
import { supabaseQuery }   from '../services/supabase.js'
import { success, error, ERROR_CODES } from '../utils/response.js'

const auth = new Hono()

auth.get('/profile', requireAuth, async (c) => {
  const userId    = c.get('userId')
  const requestId = c.get('requestId')
  try {
    const [profiles, quotas] = await Promise.all([
      supabaseQuery(c.env, 'user_profiles', 'GET', null,
        `?id=eq.${userId}&select=id,email,display_name,plan_slug,role,status,created_at&limit=1`),
      supabaseQuery(c.env, 'quotas', 'GET', null,
        `?user_id=eq.${userId}&select=daily_used,daily_limit,last_reset_at&limit=1`)
    ])

    if (!profiles?.length) {
      return c.json(error('Profile not found.', ERROR_CODES.NOT_FOUND, { requestId }), 404)
    }

    const p = profiles[0]
    const q = quotas?.[0] || { daily_used: 0, daily_limit: 3 }
    const remaining = Math.max(0, q.daily_limit - q.daily_used)

    return c.json(success({
      user: {
        id: p.id, email: p.email, displayName: p.display_name,
        plan: p.plan_slug, role: p.role, status: p.status, memberSince: p.created_at
      },
      quota: {
        used: q.daily_used, limit: q.daily_limit,
        remaining, resetDate: q.last_reset_at,
        percentage: Math.round((q.daily_used / q.daily_limit) * 100)
      }
    }, { requestId }))
  } catch (err) {
    return c.json(error('Failed to load profile.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }
})

auth.post('/logout', requireAuth, async (c) => {
  return c.json(success({ loggedOut: true }, { requestId: c.get('requestId') }))
})

export default auth
      
