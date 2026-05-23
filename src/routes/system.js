// src/routes/system.js
import { Hono }            from 'hono'
import { supabaseQuery }   from '../services/supabase.js'
import { success }         from '../utils/response.js'

const system = new Hono()

system.get('/health', async (c) => {
  let dbOk = false
  try {
    await supabaseQuery(c.env, 'plans', 'GET', null, '?limit=1')
    dbOk = true
  } catch {}
  return c.json(success({
    healthy: true, db: dbOk,
    version: c.env.WORKER_VERSION || '2.0.0',
    env:     c.env.ENVIRONMENT    || 'production',
    ts:      new Date().toISOString()
  }))
})

export default system
      
