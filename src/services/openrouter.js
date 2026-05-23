// src/services/openrouter.js
// Exact model strings — wrong strings caused 400 errors in old system

const MODELS = {
  DRAFT:    'deepseek/deepseek-chat',
  POLISH:   'anthropic/claude-haiku-20240307',
  FALLBACK: 'deepseek/deepseek-chat'
}

const COST_RATES = {
  'deepseek/deepseek-chat':          { input: 0.14, output: 0.28 },
  'anthropic/claude-haiku-20240307': { input: 0.25, output: 1.25 }
}

export async function generateWithDualPipeline(env, systemPrompt, userPrompt, opts = {}) {
  const { skipPolish = false, maxTokens = 900 } = opts

  // Step 1: Draft with DeepSeek
  let draft
  try {
    draft = await callOpenRouter(env, MODELS.DRAFT, systemPrompt, userPrompt, maxTokens)
  } catch (err) {
    throw new Error(`Draft failed: ${err.message}`)
  }

  if (skipPolish) {
    return { content: draft.content, model: MODELS.DRAFT, tokens: draft.tokens }
  }

  // Step 2: Polish with Claude Haiku
  try {
    const polishSys    = 'You are an expert marketing copywriter. Return ONLY the polished content, no preamble, no commentary.'
    const polishPrompt = `Polish this for clarity, persuasion and conversion impact. Keep all information:\n\n${draft.content}`
    const polished     = await callOpenRouter(env, MODELS.POLISH, polishSys, polishPrompt, maxTokens)
    return {
      content: polished.content,
      model:   `${MODELS.DRAFT} → ${MODELS.POLISH}`,
      tokens: {
        input:  draft.tokens.input  + polished.tokens.input,
        output: draft.tokens.output + polished.tokens.output
      }
    }
  } catch (err) {
    // Polish failed — return draft (graceful fallback)
    console.warn('[AI] Polish failed, returning draft:', err.message)
    return { content: draft.content, model: MODELS.DRAFT, tokens: draft.tokens }
  }
}

async function callOpenRouter(env, model, systemPrompt, userPrompt, maxTokens) {
  // 29s timeout — Cloudflare Worker limit is 30s
  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 29000)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://brandbone.link',
        'X-Title':       'BrandBone AI Tools'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ]
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`OpenRouter [${model}] ${res.status}: ${txt}`)
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error(`Empty response from ${model}`)

    return {
      content,
      tokens: {
        input:  data.usage?.prompt_tokens     || 0,
        output: data.usage?.completion_tokens || 0
      }
    }
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') throw new Error(`AI timeout: ${model} exceeded 29s`)
    throw err
  }
}

export function estimateCost(model, tokens) {
  // For dual pipeline, split cost estimate
  const models = model.includes('→') ? model.split('→').map(m => m.trim()) : [model]
  let total = 0
  for (const m of models) {
    const rate = COST_RATES[m] || { input: 0.5, output: 1.5 }
    const inp  = (tokens.input  || 0) / models.length
    const out  = (tokens.output || 0) / models.length
    total += (inp * rate.input + out * rate.output) / 1_000_000
  }
  return total
}
  
