// src/routes/agent.js
import { Hono }                       from 'hono'
import { requireAuth }                from '../middleware/auth.js'
import { checkQuota }                 from '../middleware/quota.js'
import { generateWithDualPipeline }   from '../services/openrouter.js'
import { supabaseInsert, supabaseQuery } from '../services/supabase.js'
import { success, error, ERROR_CODES } from '../utils/response.js'
import { buildAgentStepPrompt, AGENT_STEPS } from '../prompts/all-prompts.js'

const agent = new Hono()
agent.use('*', requireAuth)  // Agent requires login

// POST /v1/agent/session — start new campaign session
agent.post('/session', checkQuota, async (c) => {
  const requestId = c.get('requestId')
  const userId    = c.get('userId')
  let body
  try { body = await c.req.json() }
  catch { return c.json(error('Invalid request.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400) }

  const { goal } = body
  if (!goal || goal.trim().length < 10) {
    return c.json(error('Please describe your campaign goal in at least 10 characters.',
                         ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)
  }

  // Create session
  let sessions
  try {
    sessions = await supabaseInsert(c.env, 'agent_sessions', {
      user_id:      userId,
      goal:         goal.trim(),
      context_json: { goal: goal.trim() },
      total_steps:  AGENT_STEPS.length,
      current_step: 1,
      status:       'active'
    })
  } catch (err) {
    return c.json(error('Failed to start session.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }

  const session = sessions[0]

  // Generate Step 1
  let output
  try {
    const { systemPrompt, userPrompt } = buildAgentStepPrompt(AGENT_STEPS[0].type, goal)
    const result = await generateWithDualPipeline(c.env, systemPrompt, userPrompt)
    output = result.content

    c.executionCtx.waitUntil(supabaseInsert(c.env, 'agent_steps', {
      session_id:  session.id,
      step_number: 1,
      step_type:   AGENT_STEPS[0].type,
      step_label:  AGENT_STEPS[0].label,
      input_data:  { goal },
      output_data: { content: output },
      model_used:  result.model
    }))
  } catch (err) {
    const isTimeout = err.message?.includes('timeout')
    return c.json(error(
      isTimeout ? 'AI is taking longer than usual. Please try again.' : 'Step generation failed.',
      isTimeout ? ERROR_CODES.AI_TIMEOUT : ERROR_CODES.AI_ERROR,
      { requestId }
    ), isTimeout ? 504 : 503)
  }

  return c.json(success({
    sessionId:  session.id,
    stepNumber: 1,
    stepLabel:  AGENT_STEPS[0].label,
    output,
    hasMore:    true,
    progress:   `1/${AGENT_STEPS.length}`,
    totalSteps: AGENT_STEPS.length
  }, { requestId }))
})

// POST /v1/agent/step — advance to next step
agent.post('/step', checkQuota, async (c) => {
  const requestId = c.get('requestId')
  const userId    = c.get('userId')
  let body
  try { body = await c.req.json() }
  catch { return c.json(error('Invalid request.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400) }

  const { sessionId } = body
  if (!sessionId) {
    return c.json(error('sessionId required.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)
  }

  // Verify session belongs to user
  let sessions
  try {
    sessions = await supabaseQuery(c.env, 'agent_sessions', 'GET', null,
      `?id=eq.${sessionId}&user_id=eq.${userId}&limit=1`)
  } catch {
    return c.json(error('Session lookup failed.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 500)
  }

  if (!sessions?.length) {
    return c.json(error('Session not found.', ERROR_CODES.NOT_FOUND, { requestId }), 404)
  }

  const session     = sessions[0]
  const nextStepNum = session.current_step + 1

  if (nextStepNum > AGENT_STEPS.length) {
    c.executionCtx.waitUntil(
      supabaseQuery(c.env, 'agent_sessions', 'PATCH',
        { status: 'completed', updated_at: new Date().toISOString() },
        `?id=eq.${sessionId}`)
    )
    return c.json(success({ completed: true, message: 'Campaign strategy complete!' }, { requestId }))
  }

  const stepDef = AGENT_STEPS[nextStepNum - 1]
  let output
  try {
    const { systemPrompt, userPrompt } = buildAgentStepPrompt(stepDef.type, session.goal)
    const result = await generateWithDualPipeline(c.env, systemPrompt, userPrompt)
    output = result.content

    c.executionCtx.waitUntil(Promise.all([
      supabaseInsert(c.env, 'agent_steps', {
        session_id:  sessionId,
        step_number: nextStepNum,
        step_type:   stepDef.type,
        step_label:  stepDef.label,
        input_data:  { goal: session.goal },
        output_data: { content: output },
        model_used:  result.model
      }),
      supabaseQuery(c.env, 'agent_sessions', 'PATCH',
        { current_step: nextStepNum, updated_at: new Date().toISOString() },
        `?id=eq.${sessionId}`)
    ]))
  } catch (err) {
    const isTimeout = err.message?.includes('timeout')
    return c.json(error(
      isTimeout ? 'AI is taking longer than usual. Please try again.' : 'Step generation failed.',
      isTimeout ? ERROR_CODES.AI_TIMEOUT : ERROR_CODES.AI_ERROR,
      { requestId }
    ), isTimeout ? 504 : 503)
  }

  return c.json(success({
    sessionId,
    stepNumber: nextStepNum,
    stepLabel:  stepDef.label,
    output,
    hasMore:    nextStepNum < AGENT_STEPS.length,
    progress:   `${nextStepNum}/${AGENT_STEPS.length}`,
    totalSteps: AGENT_STEPS.length
  }, { requestId }))
})

export default agent
  
