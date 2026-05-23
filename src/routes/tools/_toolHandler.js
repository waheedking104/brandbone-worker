// src/routes/tools/_toolHandler.js
// Factory: eliminates ~80% duplicated code across tools

import { generateWithDualPipeline, estimateCost } from '../../services/openrouter.js'
import { getCached, setCache }                     from '../../services/cache.js'
import { supabaseInsert }                          from '../../services/supabase.js'
import { hashInput }                               from '../../utils/hash.js'
import { sanitize }                                from '../../utils/sanitize.js'
import { success, error, ERROR_CODES }             from '../../utils/response.js'
import { optionalAuth }                            from '../../middleware/optionalAuth.js'
import { checkQuota }                              from '../../middleware/quota.js'

export function createToolRoute(router, { path, validate, buildPrompts, skipPolish = false }) {
  router.post(path, optionalAuth, checkQuota, async (c) => {
    const requestId   = c.get('requestId')
    const userId      = c.get('userId')    || null
    const fingerprint = c.get('fingerprint') || null
    const ip          = c.req.header('CF-Connecting-IP') || 'unknown'
    const start       = Date.now()

    let body
    try { body = await c.req.json() }
    catch { return c.json(error('Invalid request body.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400) }

    const clean = sanitize(body)
    const valErr = validate(clean)
    if (valErr) return c.json(error(valErr, ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)

    // Cache check — same input = same output
    const cacheKey = `tool:${path}:${await hashInput(JSON.stringify(clean))}`
    const cached   = await getCached(c.env.BB_CACHE, cacheKey)
    if (cached) {
      c.executionCtx.waitUntil(_logRun(c.env, {
        requestId, userId, fingerprint, tool: path.replace('/', ''),
        input: clean, output: cached, model: 'cached',
        tokens: { input: 0, output: 0 }, cost: 0,
        latency: Date.now() - start, ip, cached: true
      }))
      return c.json(success(cached, { model: 'cached', cached: true, requestId }))
    }

    // Generate
    const { systemPrompt, userPrompt } = buildPrompts(clean)
    let result
    try {
      result = await generateWithDualPipeline(c.env, systemPrompt, userPrompt, { skipPolish })
    } catch (err) {
      const isTimeout = err.message?.includes('timeout')
      c.executionCtx.waitUntil(_logError(c.env, {
        requestId, endpoint: path, errorMsg: err.message, userId
      }))
      return c.json(
        error(
          isTimeout
            ? 'AI is taking longer than expected. Please try again.'
            : 'AI generation failed. Please try again in a moment.',
          isTimeout ? ERROR_CODES.AI_TIMEOUT : ERROR_CODES.AI_ERROR,
          { requestId }
        ),
        isTimeout ? 504 : 503
      )
    }

    const output = { content: result.content, tool: path.replace('/', '') }
    const cost   = estimateCost(result.model, result.tokens)

    // Fire-and-forget: cache + log (don't block response)
    c.executionCtx.waitUntil(Promise.all([
      setCache(c.env.BB_CACHE, cacheKey, output, 3600),
      _logRun(c.env, {
        requestId, userId, fingerprint, tool: path.replace('/', ''),
        input: clean, output, model: result.model,
        tokens: result.tokens, cost,
        latency: Date.now() - start, ip, cached: false
      })
    ]))

    return c.json(success(output, { model: result.model, cached: false, requestId }))
  })
}

async function _logRun(env, d) {
  try {
    await supabaseInsert(env, 'tool_runs', {
      request_id:         d.requestId,
      user_id:            d.userId,
      fingerprint:        d.fingerprint,
      tool_name:          d.tool,
      input_data:         d.input,
      output_data:        d.output,
      model_used:         d.model,
      token_input:        d.tokens?.input  || 0,
      token_output:       d.tokens?.output || 0,
      estimated_cost_usd: d.cost || 0,
      latency_ms:         d.latency,
      cached:             d.cached,
      ip_address:         d.ip,
      status:             'success'
    })
  } catch (err) { console.error('[ToolLog]', err.message) }
}

async function _logError(env, d) {
  try {
    await supabaseInsert(env, 'error_logs', {
      request_id:     d.requestId,
      endpoint:       d.endpoint,
      error_code:     'AI_ERROR',
      error_message:  d.errorMsg,
      worker_version: env.WORKER_VERSION,
      user_id:        d.userId
    })
  } catch {}
  }
                              
