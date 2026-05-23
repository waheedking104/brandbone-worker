// src/services/email.js
const FROM = 'BrandBone <noreply@brandbone.link>'

export async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return  // Skip if not configured

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: FROM, to, subject, html })
    })
    if (!res.ok) console.error('[Email] Failed:', res.status, await res.text())
  } catch (err) {
    console.error('[Email] Exception:', err.message)
    // Email failure NEVER blocks main operation
  }
}

export const templates = {
  welcome: (email) => ({
    to:      email,
    subject: 'Welcome to BrandBone — Your AI Marketing Toolkit',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
      <h2 style="color:#111">Welcome to BrandBone!</h2>
      <p>Your account is active. You have <strong>3 free generations per day</strong>.</p>
      <a href="https://brandbone.link/tools"
         style="display:inline-block;background:#0a0a0a;color:#fff;padding:12px 24px;
                border-radius:6px;text-decoration:none;margin-top:16px">
        Start Generating →
      </a></div>`
  }),

  upgrade: (email, planName) => ({
    to:      email,
    subject: `Your BrandBone ${planName} plan is now active ✅`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
      <h2 style="color:#111">You're on ${planName}!</h2>
      <p>Your plan upgrade is active. Enjoy your increased daily limit.</p>
      <a href="https://brandbone.link/tools"
         style="display:inline-block;background:#0a0a0a;color:#fff;padding:12px 24px;
                border-radius:6px;text-decoration:none;margin-top:16px">
        Open Tools →
      </a></div>`
  })
    }
  
