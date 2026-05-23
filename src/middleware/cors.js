// ============================================================
// FILE: src/middleware/cors.js
// ============================================================
export const corsMiddleware = async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS || 'https://brandbone.link,https://www.brandbone.link')
    .split(',').map(o => o.trim())
  const origin = c.req.header('Origin') || ''
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0]

  const headers = {
    'Access-Control-Allow-Origin':  corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
    'Access-Control-Max-Age':       '86400'
  }

  // Preflight — MUST return 200 (previous system failed here)
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers })
  }

  await next()
  Object.entries(headers).forEach(([k, v]) => c.res.headers.set(k, v))
}
