// src/routes/history.js
import { Hono }           from 'hono'
import { requireAuth }    from '../middleware/auth.js'
import { supabaseQuery }  from '../services/supabase.js'
import { success, error, ERROR_CODES } from '../utils/response.js'

const history = new Hono()
history.use('*', requireAuth)

// GET /v1/history/runs
history.get('/runs', async (c) => {
  const userId    = c.get('userId')
  const requestId = c.get('requestId')
  const page      = parseInt(c.req.query('page')  || '1')
  const limit     = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset    = (page - 1) * limit
  const tool      = c.req.query('tool') || ''

  try {
    let params = `?user_id=eq.${userId}`
      + `&select=id,tool_name,input_data,output_data,model_used,latency_ms,cached,estimated_cost_usd,created_at`
      + `&order=created_at.desc`
      + `&limit=${limit}`
      + `&offset=${offset}`
    if (tool) params += `&tool_name=eq.${tool}`

    const runs = await supabaseQuery(c.env, 'tool_runs', 'GET', null, params)

    let countParams = `?user_id=eq.${userId}&select=id`
    if (tool) countParams += `&tool_name=eq.${tool}`
    const all = await supabaseQuery(c.env, 'tool_runs', 'GET', null, countParams)

    return c.json(success({
      runs:       runs  || [],
      total:      all?.length || 0,
      page,
      limit,
      totalPages: Math.ceil((all?.length || 0) / limit)
    }, { requestId }))

  } catch (err) {
    return c.json(error('History load failed.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }
})

// GET /v1/history/run/:id
history.get('/run/:id', async (c) => {
  const userId    = c.get('userId')
  const requestId = c.get('requestId')
  const runId     = c.req.param('id')

  try {
    const runs = await supabaseQuery(c.env, 'tool_runs', 'GET', null,
      `?id=eq.${runId}&user_id=eq.${userId}&select=*&limit=1`)
    if (!runs?.length) {
      return c.json(error('Not found.', ERROR_CODES.NOT_FOUND, { requestId }), 404)
    }
    return c.json(success(runs[0], { requestId }))
  } catch (err) {
    return c.json(error('Failed to load run.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }
})

// GET /v1/history/stats
history.get('/stats', async (c) => {
  const userId    = c.get('userId')
  const requestId = c.get('requestId')

  try {
    const runs = await supabaseQuery(c.env, 'tool_runs', 'GET', null,
      `?user_id=eq.${userId}&select=tool_name,created_at,cached,estimated_cost_usd,status`)

    if (!runs?.length) {
      return c.json(success({ totalRuns: 0, todayRuns: 0, weekRuns: 0, toolBreakdown: {}, favoriteTools: [] }, { requestId }))
    }

    const toolBreakdown = {}
    runs.forEach(r => { toolBreakdown[r.tool_name] = (toolBreakdown[r.tool_name] || 0) + 1 })

    const today     = new Date().toISOString().slice(0, 10)
    const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const todayRuns = runs.filter(r => r.created_at?.slice(0, 10) === today)
    const weekRuns  = runs.filter(r => r.created_at?.slice(0, 10) >= weekAgo)

    return c.json(success({
      totalRuns:     runs.length,
      todayRuns:     todayRuns.length,
      weekRuns:      weekRuns.length,
      toolBreakdown,
      favoriteTools: Object.entries(toolBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3)
    }, { requestId }))

  } catch (err) {
    return c.json(error('Stats failed.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }
})

export default history
            
