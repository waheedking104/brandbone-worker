// src/routes/admin.js
import { Hono }              from 'hono'
import { requireAdmin }      from '../middleware/adminAuth.js'
import { supabaseQuery, supabaseInsert } from '../services/supabase.js'
import { sendEmail, templates }          from '../services/email.js'
import { logAudit }          from '../services/auditLog.js'
import { success, error, ERROR_CODES }   from '../utils/response.js'

const admin = new Hono()
admin.use('*', requireAdmin)

// GET /v1/admin/me — verify admin + get own info
admin.get('/me', (c) => {
  return c.json(success({ adminRole: c.get('adminRole'), userId: c.get('userId') }))
})

// GET /v1/admin/analytics — main dashboard data
admin.get('/analytics', async (c) => {
  const requestId = c.get('requestId')
  try {
    const [toolRuns, leads, users, errors] = await Promise.all([
      supabaseQuery(c.env, 'tool_runs', 'GET', null,
        '?select=tool_name,created_at,estimated_cost_usd,cached,status,model_used,latency_ms,user_id&order=created_at.desc&limit=200'),
      supabaseQuery(c.env, 'leads', 'GET', null,
        '?order=created_at.desc&limit=100'),
      supabaseQuery(c.env, 'user_profiles', 'GET', null,
        '?select=id,email,plan_slug,status,role,created_at&order=created_at.desc&limit=200'),
      supabaseQuery(c.env, 'error_logs', 'GET', null,
        '?select=*&order=created_at.desc&limit=50')
    ])
    return c.json(success({ toolRuns, leads, users, errors }, { requestId }))
  } catch (err) {
    return c.json(error('Analytics load failed.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }
})

// POST /v1/admin/user/upgrade
admin.post('/user/upgrade', async (c) => {
  const requestId = c.get('requestId')
  const adminId   = c.get('userId')
  const body      = await c.req.json()
  const { userId, planSlug, daysOverride = 30 } = body

  if (!userId || !planSlug) {
    return c.json(error('userId and planSlug required.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)
  }

  const plans = await supabaseQuery(c.env, 'plans', 'GET', null, `?slug=eq.${planSlug}&limit=1`)
  if (!plans?.length) return c.json(error('Plan not found.', ERROR_CODES.NOT_FOUND, { requestId }), 404)

  const plan = plans[0]

  // Get current plan for audit
  const oldProfile = await supabaseQuery(c.env, 'user_profiles', 'GET', null, `?id=eq.${userId}&select=plan_slug,email&limit=1`)

  await supabaseQuery(c.env, 'user_profiles', 'PATCH',
    { plan_id: plan.id, plan_slug: planSlug, updated_at: new Date().toISOString() },
    `?id=eq.${userId}`)

  const now = new Date()
  const end = new Date(now); end.setDate(end.getDate() + daysOverride)

  await supabaseInsert(c.env, 'subscriptions', {
    user_id: userId, plan_id: plan.id, provider: 'manual',
    status: 'active', current_period_start: now.toISOString(),
    current_period_end: end.toISOString()
  })

  // Send upgrade email
  const userEmail = oldProfile?.[0]?.email
  if (userEmail) {
    c.executionCtx.waitUntil(sendEmail(c.env, templates.upgrade(userEmail, plan.name)))
  }

  c.executionCtx.waitUntil(logAudit(c.env, {
    actorId: adminId, actorRole: c.get('adminRole'),
    actorIp: c.req.header('CF-Connecting-IP'),
    action: 'user.upgrade', resourceType: 'user', resourceId: userId,
    oldValue: { plan: oldProfile?.[0]?.plan_slug },
    newValue: { plan: planSlug, days: daysOverride }
  }))

  return c.json(success({ upgraded: true, plan: planSlug, until: end.toISOString() }, { requestId }))
})

// POST /v1/admin/user/ban
admin.post('/user/ban', async (c) => {
  const requestId = c.get('requestId')
  const adminId   = c.get('userId')
  const { userId, reason } = await c.req.json()
  if (!userId) return c.json(error('userId required.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)

  await supabaseQuery(c.env, 'user_profiles', 'PATCH',
    { status: 'banned', updated_at: new Date().toISOString() }, `?id=eq.${userId}`)

  try {
    await supabaseInsert(c.env, 'user_limits', {
      user_id: userId, custom_status: 'banned',
      override_reason: reason || 'Admin action', updated_by: adminId, updated_at: new Date().toISOString()
    })
  } catch {
    await supabaseQuery(c.env, 'user_limits', 'PATCH',
      { custom_status: 'banned', override_reason: reason || 'Admin action', updated_by: adminId, updated_at: new Date().toISOString() },
      `?user_id=eq.${userId}`)
  }

  c.executionCtx.waitUntil(logAudit(c.env, {
    actorId: adminId, actorRole: c.get('adminRole'),
    action: 'user.ban', resourceType: 'user', resourceId: userId,
    newValue: { reason }
  }))

  return c.json(success({ banned: true }, { requestId }))
})

// POST /v1/admin/quota/reset
admin.post('/quota/reset', async (c) => {
  const requestId = c.get('requestId')
  const { userId } = await c.req.json()
  if (!userId) return c.json(error('userId required.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)

  await supabaseQuery(c.env, 'quotas', 'PATCH',
    { daily_used: 0, updated_at: new Date().toISOString() }, `?user_id=eq.${userId}`)

  return c.json(success({ reset: true }, { requestId }))
})

// GET /v1/admin/plans
admin.get('/plans', async (c) => {
  const plans = await supabaseQuery(c.env, 'plans', 'GET', null, '?order=monthly_price.asc')
  return c.json(success({ plans }, { requestId: c.get('requestId') }))
})

export default admin
      
