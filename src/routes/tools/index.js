// src/routes/tools/index.js
import { Hono }              from 'hono'
import { createToolRoute }   from './_toolHandler.js'
import { buildAdsPrompt }    from '../../prompts/adsGenerator.js'
import { buildMetaPrompt }   from '../../prompts/all-prompts.js'
import { buildEmailPrompt }  from '../../prompts/all-prompts.js'
import { optionalAuth }      from '../../middleware/optionalAuth.js'
import { success, error, ERROR_CODES } from '../../utils/response.js'

const tools = new Hono()

// ── ROI CALCULATOR (no AI — pure math) ────────────────────────────
tools.post('/roi-calculator', optionalAuth, async (c) => {
  const requestId = c.get('requestId')
  let body
  try { body = await c.req.json() }
  catch { return c.json(error('Invalid request body.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400) }

  const { adSpend, conversionRate, avgOrderValue, cogs } = body
  if (!adSpend || !conversionRate || !avgOrderValue) {
    return c.json(error('adSpend, conversionRate and avgOrderValue are required.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)
  }
  if (adSpend <= 0 || conversionRate <= 0 || avgOrderValue <= 0) {
    return c.json(error('All values must be greater than 0.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)
  }

  const avgCPC      = 0.50
  const clicks      = Math.round(adSpend / avgCPC)
  const conversions = Math.round(clicks * (conversionRate / 100))
  const revenue     = conversions * avgOrderValue
  const cogsTotal   = cogs ? conversions * cogs : revenue * 0.3
  const grossProfit = revenue - cogsTotal
  const netProfit   = grossProfit - adSpend
  const roas        = adSpend > 0 ? (revenue / adSpend).toFixed(2) : 0
  const cac         = conversions > 0 ? (adSpend / conversions).toFixed(2) : 0
  const breakEven   = avgOrderValue > 0 ? Math.ceil(adSpend / (avgOrderValue - (cogs || avgOrderValue * 0.3))) : 0
  const roi         = adSpend > 0 ? ((netProfit / adSpend) * 100).toFixed(1) : 0

  return c.json(success({
    adSpend, clicks, conversions, revenue: revenue.toFixed(2),
    grossProfit: grossProfit.toFixed(2), netProfit: netProfit.toFixed(2),
    roas, cac, breakEven, roi,
    profitMargin: revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : 0
  }, { requestId }))
})

// ── ADS GENERATOR ─────────────────────────────────────────────────
createToolRoute(tools, {
  path:  '/ads-generator',
  validate: ({ product }) => {
    if (!product || product === '[BLOCKED]' || product.length < 3)
      return 'Product/service description is required (min 3 characters).'
    return null
  },
  buildPrompts: buildAdsPrompt,
  skipPolish:   false
})

// ── META ADS GENERATOR ────────────────────────────────────────────
createToolRoute(tools, {
  path:  '/meta-generator',
  validate: ({ product }) => {
    if (!product || product === '[BLOCKED]' || product.length < 3)
      return 'Product/service description is required (min 3 characters).'
    return null
  },
  buildPrompts: buildMetaPrompt,
  skipPolish:   false
})

// ── EMAIL SUBJECT GENERATOR ───────────────────────────────────────
createToolRoute(tools, {
  path:  '/email-generator',
  validate: ({ product }) => {
    if (!product || product === '[BLOCKED]' || product.length < 3)
      return 'Product/service description is required (min 3 characters).'
    return null
  },
  buildPrompts: buildEmailPrompt,
  skipPolish:   true   // Email subjects: single AI call is enough
})

export default tools
    
