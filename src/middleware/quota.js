// src/middleware/quota.js
import { supabaseRPC }        from '../services/supabase.js'
import { generateFingerprint } from '../services/fingerprint.js'

export const checkQuota = async (c, next) => {
  const userId = c.get('userId') || null
  const ip     = c.req.header('CF-Connecting-IP') || 'unknown'

  let fingerprint = null
  if (!userId) {
    // Guest: generate fingerprint from request headers
    fingerprint = await generateFingerprint(
      ip,
      c.req.header('User-Agent')       || '',
      c.req.header('Accept-Language')  || '',
      c.req.header('Accept-Encoding')  || '',
      c.req.header('CF-IPCountry')     || '',
      c.req.header('CF-Timezone')      || ''
    )
    c.set('fingerprint', fingerprint)
  }

  // AWAIT is critical — missing await caused quota bypass in old system
  let result
  try {
    result = await supabaseRPC(c.env, 'check_and_use_quota', {
      p_user_id:     userId,
      p_fingerprint: fingerprint,
      p_ip:          ip
    })
  } catch (err) {
    console.error('[Quota] RPC failed:', err.message)
    // Fail open — don't block users if quota system is down
    await next()
    return
  }

  if (!result?.allowed) {
    const isBanned = result?.reason === 'banned'
    return c.json({
      status:     'error',
      message:    isBanned
        ? 'Your account has been suspended. Contact support.'
        : 'Daily limit reached. Upgrade your plan to continue.',
      error_code: isBanned ? 'ACCOUNT_BANNED' : 'QUOTA_EXCEEDED',
      data: {
        used:      result?.used  || 0,
        limit:     result?.limit || 3,
        remaining: 0,
        plans_url: '/pricing'
      },
      request_id: c.get('requestId'),
      ts:         new Date().toISOString()
    }, 429)
  }

  c.set('quotaResult', result)
  await next()
}
  
