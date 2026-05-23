import { Hono } from 'hono'
import { corsMiddleware }      from './middleware/cors.js'
import { requestIdMiddleware } from './middleware/requestId.js'
import systemRoutes            from './routes/system.js'
import authRoutes              from './routes/auth.js'
import toolRoutes              from './routes/tools/index.js'
import agentRoutes             from './routes/agent.js'
import adminRoutes             from './routes/admin.js'
import stripeRoutes            from './routes/stripe.js'
import historyRoutes           from './routes/history.js'

const app = new Hono()

// ── Global middleware (order matters) ─────────────────────────────
app.use('*', requestIdMiddleware)
app.use('*', corsMiddleware)

// ── Routes ────────────────────────────────────────────────────────
app.route('/v1/system',  systemRoutes)
app.route('/v1/auth',    authRoutes)
app.route('/v1/tools',   toolRoutes)
app.route('/v1/agent',   agentRoutes)
app.route('/v1/admin',   adminRoutes)
app.route('/v1/stripe',  stripeRoutes)
app.route('/v1/history', historyRoutes)

// ── 404 ───────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json({ status: 'error', message: 'Not found', error_code: 'NOT_FOUND', data: null,
           request_id: c.get('requestId'), ts: new Date().toISOString() }, 404)
)

// ── Global error handler ──────────────────────────────────────────
app.onError((err, c) => {
  console.error(`[${c.get('requestId')}] Unhandled:`, err.message)
  return c.json({
    status: 'error', message: 'Internal server error',
    error_code: 'INTERNAL_ERROR', data: null,
    request_id: c.get('requestId'), ts: new Date().toISOString()
  }, 500)
})

export default app
  
