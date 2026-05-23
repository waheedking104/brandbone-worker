// src/routes/stripe.js
// Phase 2 — only activate after manual payment flow is validated
import { Hono }              from 'hono'
import { requireAuth }       from '../middleware/auth.js'
import { supabaseQuery, supabaseInsert } from '../services/supabase.js'
import { sendEmail, templates }          from '../services/email.js'
import { success, error, ERROR_CODES }   from '../utils/response.js'

const stripe = new Hono()

// POST /v1/stripe/create-checkout
stripe.post('/create-checkout', requireAuth, async (c) => {
  const requestId = c.get('requestId')
  const userId    = c.get('userId')
  const userEmail = c.get('userEmail')
  const { planSlug } = await c.req.json()

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(error('Online payments not yet configured. Please contact us to upgrade manually.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 503)
  }

  const plans = await supabaseQuery(c.env, 'plans', 'GET', null, `?slug=eq.${planSlug}&limit=1`)
  if (!plans?.length) return c.json(error('Plan not found.', ERROR_CODES.NOT_FOUND, { requestId }), 404)

  const PRICE_IDS = {
    starter: c.env.STRIPE_PRICE_STARTER,
    pro:     c.env.STRIPE_PRICE_PRO
  }
  const priceId = PRICE_IDS[planSlug]
  if (!priceId) return c.json(error('Plan not available for online purchase.', ERROR_CODES.VALIDATION_ERROR, { requestId }), 400)

  const params = new URLSearchParams({
    mode:                                    'subscription',
    'payment_method_types[]':                'card',
    'line_items[0][price]':                  priceId,
    'line_items[0][quantity]':               '1',
    customer_email:                          userEmail,
    client_reference_id:                     userId,
    'metadata[user_id]':                     userId,
    'metadata[plan_slug]':                   planSlug,
    success_url:                             `${c.env.SITE_URL || 'https://brandbone.link'}/tools?upgraded=1`,
    cancel_url:                              `${c.env.SITE_URL || 'https://brandbone.link'}/pricing?cancelled=1`,
    'subscription_data[metadata][user_id]':   userId,
    'subscription_data[metadata][plan_slug]': planSlug
  })

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:  'POST',
    headers: {
      'Authorization':   `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type':    'application/x-www-form-urlencoded',
      'Idempotency-Key': `checkout_${userId}_${planSlug}_${Math.floor(Date.now() / 3600000)}`
    },
    body: params.toString()
  })

  if (!res.ok) {
    const txt = await res.text()
    console.error('[Stripe] Checkout error:', txt)
    return c.json(error('Payment system error. Please try again.', ERROR_CODES.INTERNAL_ERROR, { requestId }), 503)
  }

  const session = await res.json()
  return c.json(success({ checkoutUrl: session.url }, { requestId }))
})

// POST /v1/stripe/webhook
stripe.post('/webhook', async (c) => {
  const body      = await c.req.text()
  const signature = c.req.header('stripe-signature')

  const isValid = await _verifyWebhook(body, signature, c.env.STRIPE_WEBHOOK_SECRET)
  if (!isValid) return c.json({ error: 'Invalid signature' }, 400)

  const event = JSON.parse(body)

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object
    const userId    = session.metadata?.user_id
    const planSlug  = session.metadata?.plan_slug
    const subId     = session.subscription

    if (!userId || !planSlug) return c.json({ received: true })

    // Idempotency: skip if already processed
    const existing = await supabaseQuery(c.env, 'subscriptions', 'GET', null,
      `?provider_subscription_id=eq.${subId}&limit=1`)
    if (existing?.length > 0) return c.json({ received: true })

    const plans = await supabaseQuery(c.env, 'plans', 'GET', null, `?slug=eq.${planSlug}&limit=1`)
    if (!plans?.length) return c.json({ received: true })

    const plan = plans[0]
    const now  = new Date()
    const end  = new Date(now); end.setDate(end.getDate() + 30)

    await supabaseQuery(c.env, 'user_profiles', 'PATCH',
      { plan_id: plan.id, plan_slug: planSlug, updated_at: now.toISOString() },
      `?id=eq.${userId}`)

    await supabaseInsert(c.env, 'subscriptions', {
      user_id: userId, plan_id: plan.id, provider: 'stripe',
      provider_subscription_id: subId, status: 'active',
      current_period_start: now.toISOString(), current_period_end: end.toISOString()
    })

    await supabaseInsert(c.env, 'payments', {
      user_id: userId, provider: 'stripe',
      provider_transaction_id: session.payment_intent,
      amount: (session.amount_total || 0) / 100,
      currency: (session.currency || 'usd').toUpperCase(),
      status: 'completed'
    })

    const profile = await supabaseQuery(c.env, 'user_profiles', 'GET', null, `?id=eq.${userId}&select=email&limit=1`)
    if (profile?.[0]?.email) {
      c.executionCtx.waitUntil(sendEmail(c.env, templates.upgrade(profile[0].email, plan.name)))
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub    = event.data.object
    const userId = sub.metadata?.user_id
    if (userId) {
      await supabaseQuery(c.env, 'user_profiles', 'PATCH',
        { plan_slug: 'free', updated_at: new Date().toISOString() }, `?id=eq.${userId}`)
      await supabaseQuery(c.env, 'subscriptions', 'PATCH',
        { status: 'cancelled', updated_at: new Date().toISOString() },
        `?provider_subscription_id=eq.${sub.id}`)
    }
  }

  return c.json({ received: true })
})

async function _verifyWebhook(payload, signature, secret) {
  try {
    const parts = signature.split(',')
    const ts    = parts.find(p => p.startsWith('t='))?.slice(2)
    const v1    = parts.find(p => p.startsWith('v1='))?.slice(3)
    if (!ts || !v1) return false

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`))
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    return hex === v1
  } catch { return false }
}

export default stripe
    
