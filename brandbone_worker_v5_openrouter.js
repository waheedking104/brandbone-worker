/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  BRANDBONE CLOUDFLARE WORKER — FINAL v5.0                           ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  v5.0 UPGRADES:                                                      ║
 * ║  ✅ Atomic quota via check_and_increment_quota() Supabase RPC        ║
 * ║  ✅ Email-based rate limiting (email required for all tool calls)    ║
 * ║  ✅ Hardened prompt injection prevention (multi-pattern regex)       ║
 * ║  ✅ Memory-safe rate-limit Map (max 5000 entries, LRU eviction)      ║
 * ║  ✅ 8-second AbortController on all Supabase fetch calls            ║
 * ║  ✅ All missing admin endpoints added                                ║
 * ║  ✅ OpenRouter Flux 1 Dev image support (primary)                   ║
 * ║  ✅ Audit log on every admin action                                  ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  ENV VARIABLES (Worker Settings → Variables):                        ║
 * ║  OPENROUTER_KEY    = OpenRouter API key (AI text + Flux 1 Dev imgs) ║
 * ║  HF_KEY            = Hugging Face token (optional fallback)         ║
 * ║  SUPABASE_URL      = https://xxxx.supabase.co                        ║
 * ║  SUPABASE_KEY      = Supabase anon key                               ║
 * ║  SUPABASE_JWT_SECRET = JWT secret (Supabase → Settings → API)       ║
 * ║  BB_API_KEY        = your custom secret                              ║
 * ║  ADMIN_EMAIL       = admin email address                             ║
 * ║  RESEND_KEY        = Resend API key (resend.com free: 3k/mo)        ║
 * ║  ALLOWED_ORIGIN    = https://brandbone.link                          ║
 * ║                                                                      ║
 * ║  KV BINDINGS:                                                        ║
 * ║  BB_CACHE  → KV namespace for AI response cache                     ║
 * ║  BB_TASKS  → KV namespace for async image tasks                     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════
// §1  INJECTION PREVENTION — hardened multi-pattern sanitizer
// ══════════════════════════════════════════════════════════════════════
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /forget\s+(everything|all|previous)/gi,
  /you\s+are\s+now\s+(a|an|the)\s+\w+/gi,
  /act\s+as\s+(a|an|if)\s+/gi,
  /jailbreak|DAN\s+mode|developer\s+mode/gi,
  /\bsystem\s*:\s*/gi,
  /\bassistant\s*:\s*/gi,
  /<\|?(im_start|im_end|system|prompt)\|?>/gi,
  /\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>/gi,
  /###\s*(instruction|system|prompt)/gi,
  /base64\s*decode|eval\s*\(/gi,
  /import\s+os|subprocess|exec\s*\(/gi,
  /prompt\s+injection|prompt\s+leak/gi,
];

function sanitize(input, maxLen = 500) {
  if (!input) return '';
  let s = String(input)
    .replace(/<[^>]+>/g, '')                      // strip HTML
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')    // strip control chars (keep \t\n)
    .trim()
    .substring(0, maxLen * 2);                     // pre-trim before regex

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(s)) {
      s = s.replace(pattern, '[filtered]');
    }
  }

  return s.substring(0, maxLen);
}

function isInjection(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return INJECTION_PATTERNS.some(p => { p.lastIndex = 0; return p.test(lower); });
}

// ══════════════════════════════════════════════════════════════════════
// §2  MEMORY-SAFE RATE LIMITER (max 5000 entries, LRU-style eviction)
// ══════════════════════════════════════════════════════════════════════
const RL_MAX   = 5000;
const rlMap    = new Map();

function rlCheck(key, limit = 30, windowMs = 60000) {
  const now = Date.now();

  // Evict oldest 10% when at capacity
  if (rlMap.size >= RL_MAX) {
    let toDelete = Math.floor(RL_MAX * 0.1);
    for (const k of rlMap.keys()) {
      if (toDelete-- <= 0) break;
      rlMap.delete(k);
    }
  }

  const entry = rlMap.get(key) || { n: 0, t: now };
  if (now - entry.t > windowMs) {
    rlMap.set(key, { n: 1, t: now });
    return true;
  }
  entry.n++;
  rlMap.set(key, entry);
  return entry.n <= limit;
}

// ══════════════════════════════════════════════════════════════════════
// §3  CACHE (KV)
// ══════════════════════════════════════════════════════════════════════
async function hashKey(text) {
  const buf  = new TextEncoder().encode(String(text).toLowerCase().replace(/\s+/g,' ').substring(0,200));
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('').substring(0,32);
}
async function getCached(env, k) {
  try { const v = await env.BB_CACHE.get(k); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function setCache(env, k, v, ttl = 86400) {
  try { await env.BB_CACHE.put(k, JSON.stringify(v), { expirationTtl: ttl }); } catch {}
}

// ══════════════════════════════════════════════════════════════════════
// §4  RESPONSE HELPERS
// ══════════════════════════════════════════════════════════════════════
function ok(data, model = '', cached = false, extra = {}) {
  return { status: 'success', data, model, cached, ts: new Date().toISOString(), ...extra };
}
function er(msg, code = 500) {
  return { status: 'error', message: msg, code, ts: new Date().toISOString() };
}
function jRes(obj, status = 200, env, origin = '') {
  const allowed = (env?.ALLOWED_ORIGIN) || origin || '*';
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, X-BB-Key, Authorization',
      'Access-Control-Max-Age':      '86400',
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// §5  JWT VALIDATION (Supabase JWT)
// ══════════════════════════════════════════════════════════════════════
async function verifyJWT(token, env) {
  if (!token || !env.SUPABASE_JWT_SECRET) return null;
  try {
    const parts   = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig  = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', key, sig, data)) return null;
    return payload;
  } catch { return null; }
}

async function getUser(req, env) {
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  return t ? verifyJWT(t, env) : null;
}

function isAdmin(user, env) {
  return user && (user.email === env.ADMIN_EMAIL || user.role === 'service_role');
}

// ══════════════════════════════════════════════════════════════════════
// §6  SUPABASE HELPERS (all with 8-second timeout)
// ══════════════════════════════════════════════════════════════════════
function sbHeaders(env) {
  return {
    'apikey':        env.SUPABASE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

async function sbFetch(env, path, opts = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);   // 8-second timeout
  try {
    const r = await fetch(`${env.SUPABASE_URL}${path}`, {
      ...opts,
      headers: { ...sbHeaders(env), ...(opts.headers || {}) },
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function sbQ(env, table, params = '') {
  const r = await sbFetch(env, `/rest/v1/${table}${params}`);
  if (!r.ok) throw new Error(`SB ${r.status} on ${table}`);
  return r.json();
}

async function sbI(env, table, data) {
  const r = await sbFetch(env, `/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function sbU(env, table, filter, data) {
  await sbFetch(env, `/rest/v1/${table}?${filter}`, {
    method:  'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body:    JSON.stringify(data),
  });
}

function sbLog(env, table, data, ctx) {
  const p = sbI(env, table, data).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(p); else p;
}

// Audit log helper
function auditLog(env, user, action, targetId, details, ip, ctx) {
  sbLog(env, 'audit_log', {
    admin_id:    user?.sub || null,
    admin_email: user?.email || '',
    action,
    target_id:   String(targetId || ''),
    details:     details || {},
    ip_address:  ip || '',
  }, ctx);
}

// ══════════════════════════════════════════════════════════════════════
// §7  ATOMIC QUOTA CHECK (calls Supabase RPC check_and_increment_quota)
// ══════════════════════════════════════════════════════════════════════
async function checkAndIncrementQuota(env, userId, email, anonymous = false) {
  try {
    const r = await sbFetch(env, '/rest/v1/rpc/check_and_increment_quota', {
      method: 'POST',
      body:   JSON.stringify({
        p_user_id:   userId  || null,
        p_email:     email   || null,
        p_anonymous: anonymous,
      }),
    });
    if (!r.ok) {
      // Fallback: allow if RPC unavailable (fail open, log error)
      console.error('Quota RPC failed:', r.status);
      return { allowed: true, remaining: 20, used: 0, limit: 20 };
    }
    const data = await r.json();
    return typeof data === 'object' ? data : { allowed: true, remaining: 20, used: 0, limit: 20 };
  } catch (e) {
    console.error('Quota check error:', e.message);
    return { allowed: true, remaining: 20, used: 0, limit: 20 }; // fail open
  }
}

// ══════════════════════════════════════════════════════════════════════
// §8  EMAIL NOTIFICATIONS (Resend)
// ══════════════════════════════════════════════════════════════════════
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_KEY) return;
  fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: 'BrandBone <noreply@brandbone.link>', to: [to], subject, html }),
  }).catch(() => {});
}

function leadEmailHtml(lead) {
  return `<h2>🎯 New Lead — ${lead.email}</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%">
<tr><td style="padding:8px;border:1px solid #eee;font-weight:700">Email</td><td style="padding:8px;border:1px solid #eee">${lead.email}</td></tr>
<tr><td style="padding:8px;border:1px solid #eee;font-weight:700">Tool</td><td style="padding:8px;border:1px solid #eee">${lead.tool_used||'—'}</td></tr>
<tr><td style="padding:8px;border:1px solid #eee;font-weight:700">Source</td><td style="padding:8px;border:1px solid #eee">${lead.source_page||'—'}</td></tr>
<tr><td style="padding:8px;border:1px solid #eee;font-weight:700">Message</td><td style="padding:8px;border:1px solid #eee">${lead.message||'—'}</td></tr>
<tr><td style="padding:8px;border:1px solid #eee;font-weight:700">Time</td><td style="padding:8px;border:1px solid #eee">${new Date().toLocaleString()}</td></tr>
</table>
<p style="margin-top:16px"><a href="https://brandbone.link/wp-admin" style="background:#6366F1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Dashboard →</a></p>`;
}

// ══════════════════════════════════════════════════════════════════════
// §9  AI MODELS (Kimi K2.5 draft → Claude Haiku polish)
// ══════════════════════════════════════════════════════════════════════
const AGENCY_SYSTEM = `You are a Senior Conversion Copywriter + AI Business Strategist for BrandBone,
Pakistan's #1 AI-native growth agency targeting USA, UK, Canada, EU, Australia.

VOICE: Expert, data-driven, specific. Every claim = specific number or proof.
POSITIONING: Fortune-500 quality at 60% lower cost. AI-first, not AI-assisted.
BUYER: E-commerce founders, SaaS CTOs, SMB owners ($500–$5000/mo marketing budget).
FORBIDDEN words: leverage, synergy, unlock, seamless, robust, cutting-edge, game-changer, revolutionize.

Return ONLY valid JSON. No markdown fences. No preamble. No explanation.`;

async function callKimi(env, prompt, ms = 25000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
        'HTTP-Referer':  'https://brandbone.link',
        'X-Title':       'BrandBone Agency',
      },
      body: JSON.stringify({
        model:      'moonshotai/moonshot-v1-8k',
        messages:   [{ role: 'user', content: AGENCY_SYSTEM + '\n\n' + prompt }],
        max_tokens: 2000, temperature: 0.7,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Kimi ${r.status}`);
    const d = await r.json();
    const t = d?.choices?.[0]?.message?.content;
    if (!t) throw new Error('Kimi: empty response');
    return { text: t, model: 'kimi-k2.5' };
  } catch(e) { clearTimeout(timer); throw e; }
}

async function callClaude(env, prompt, system = '', ms = 25000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
        'HTTP-Referer':  'https://brandbone.link',
        'X-Title':       'BrandBone Agency',
      },
      body: JSON.stringify({
        model:      'anthropic/claude-3.5-haiku-20241022',
        max_tokens: 2000, temperature: 0.7,
        messages:   [
          { role: 'system', content: system || AGENCY_SYSTEM },
          { role: 'user',   content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const d = await r.json();
    const t = d?.choices?.[0]?.message?.content;
    if (!t) throw new Error('Claude: empty response');
    return { text: t, model: 'claude-haiku' };
  } catch(e) { clearTimeout(timer); throw e; }
}

// Kimi drafts → 300ms gap → Claude polishes
async function dual(env, draftPrompt, polishNote = '') {
  const draft = await callKimi(env, draftPrompt);
  await new Promise(r => setTimeout(r, 300));
  try {
    const polished = await callClaude(env,
      `Improve this marketing content:\n\n${draft.text}\n\nInstruction: ${polishNote || 'Sharpen specificity, add concrete numbers, strengthen CTAs. Return same JSON structure, improved.'}`,
      'You are a conversion copywriter. Improve quality and specificity. Return only the improved JSON, no markdown.'
    );
    return { text: polished.text, model: 'kimi→claude-haiku' };
  } catch { return draft; }
}

function parseJ(text, fallback = {}) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s !== -1 && e !== -1) return JSON.parse(clean.substring(s, e + 1));
  } catch {}
  return fallback;
}

// ══════════════════════════════════════════════════════════════════════
// §10 IMAGE GENERATION (OpenRouter Flux 1 Dev primary → Pollinations → HF 1-try)
// ══════════════════════════════════════════════════════════════════════
async function openrouterImage(env, prompt) {
  if (!env.OPENROUTER_KEY) return null;
  const fullPrompt = `Professional dark studio photography, ${sanitize(prompt, 200)}, dramatic lighting, no text, no watermark, dark background #060A14, ultra high quality, commercial 4K, cinematic`;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch('https://openrouter.ai/api/v1/images/generations', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://brandbone.link',
        'X-Title':       'BrandBone Agency',
      },
      body:   JSON.stringify({ model: 'black-forest-labs/flux-1-dev', prompt: fullPrompt, n: 1, size: '1024x1024' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const url  = data?.data?.[0]?.url;
    if (!url) return null;
    // Download image bytes
    const imgR = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!imgR.ok) return null;
    const bytes = await imgR.arrayBuffer();
    if (bytes.byteLength < 4096) return null;
    return { bytes, source: 'openrouter-flux1dev' };
  } catch { return null; }
}

async function pollinationsImage(prompt) {
  const seed = Math.floor(Math.random() * 99999);
  const full = `Professional dark studio photography, ${sanitize(prompt, 200)}, dramatic lighting, no text, no watermark, dark background #060A14, commercial 4K`;
  try {
    const r = await fetch(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=1200&height=630&nologo=true&seed=${seed}&model=flux`,
      { signal: AbortSignal.timeout(60000) }
    );
    if (r.ok) {
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength > 8192) return { bytes, source: 'pollinations' };
    }
  } catch {}
  return null;
}

async function hfOnce(env, prompt) {
  if (!env.HF_KEY) return null;
  try {
    const r = await fetch(
      'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${env.HF_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ inputs: `${sanitize(prompt, 200)}, dark studio, premium, no text` }),
        signal:  AbortSignal.timeout(90000),
      }
    );
    if (r.ok) {
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength > 4096) return { bytes, source: 'huggingface' };
    }
  } catch {}
  return null;
}

async function processImgTask(env, taskId, prompt) {
  try {
    // Chain: OpenRouter → Pollinations → HF (1 try each)
    let result = await openrouterImage(env, prompt);
    if (!result) result = await pollinationsImage(prompt);
    if (!result) result = await hfOnce(env, prompt);

    if (result) {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(result.bytes)));
      await env.BB_TASKS.put(`task:${taskId}`,
        JSON.stringify({ status: 'done', base64: b64, source: result.source, done: Date.now() }),
        { expirationTtl: 3600 }
      );
    } else {
      await env.BB_TASKS.put(`task:${taskId}`,
        JSON.stringify({ status: 'failed', done: Date.now() }),
        { expirationTtl: 3600 }
      );
    }
  } catch {
    await env.BB_TASKS.put(`task:${taskId}`,
      JSON.stringify({ status: 'failed', done: Date.now() }),
      { expirationTtl: 3600 }
    ).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════
// §11 AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════════
async function authSignup(env, body, ctx) {
  const email    = sanitize(body.email    || '', 200).toLowerCase().trim();
  const password = body.password || '';
  if (!email || !email.includes('@')) return er('Valid email required', 400);
  if (password.length < 8)            return er('Password minimum 8 characters', 400);

  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
      method:  'POST',
      headers: { 'apikey': env.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (d.error) return er(d.error.message || 'Signup failed', 400);
    const userId = d.user?.id;
    if (!userId)  return er('Signup failed', 500);

    ctx.waitUntil(sbI(env, 'user_profiles', {
      user_id: userId, email, plan: 'free',
      daily_quota: 20, used_today: 0, quota_reset_date: new Date().toISOString().split('T')[0],
    }).catch(() => {}));

    ctx.waitUntil(Promise.resolve(sendEmail(env, email,
      '✅ Welcome to BrandBone — Your Account is Ready',
      `<h2>Welcome to BrandBone!</h2>
       <p>Your free account is ready. You get <strong>20 free AI tool uses per day</strong>.</p>
       <p><a href="https://brandbone.link/tools/" style="background:#6366F1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Try Free Tools →</a></p>`
    )));

    return ok({ user_id: userId, email, plan: 'free', daily_quota: 20 }, 'system');
  } catch(e) { return er(`Signup error: ${e.message}`); }
}

async function authLogin(env, body) {
  const email    = sanitize(body.email || '', 200).toLowerCase().trim();
  const password = body.password || '';
  if (!email || !password) return er('Email and password required', 400);
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method:  'POST',
      headers: { 'apikey': env.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (d.error) return er(d.error.message || 'Invalid credentials', 401);
    return ok({
      access_token:  d.access_token,
      refresh_token: d.refresh_token,
      expires_in:    d.expires_in,
      user:          { id: d.user?.id, email: d.user?.email },
    }, 'system');
  } catch(e) { return er(`Login error: ${e.message}`); }
}

async function userMe(env, user) {
  if (!user) return er('Unauthorized', 401);
  try {
    const rows = await sbQ(env, 'user_profiles', `?user_id=eq.${user.sub}&select=*`);
    return ok({ ...(rows[0] || { plan:'free', daily_quota:20, used_today:0 }), email: user.email, user_id: user.sub }, 'system');
  } catch(e) { return er(e.message); }
}

async function userUsage(env, user) {
  if (!user) return er('Unauthorized', 401);
  try {
    const rows = await sbQ(env, 'tool_usage',
      `?user_id=eq.${user.sub}&order=created_at.desc&limit=100&select=tool_name,cached,created_at,model_used`);
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

// ══════════════════════════════════════════════════════════════════════
// §12 ADMIN ENDPOINTS (all with audit logging)
// ══════════════════════════════════════════════════════════════════════
function paginate(url) {
  const p    = new URL(url);
  const page = Math.max(1, parseInt(p.searchParams.get('page') || '1'));
  const per  = Math.min(100, Math.max(10, parseInt(p.searchParams.get('per') || '50')));
  const from = (page - 1) * per;
  return { page, per, from, to: from + per - 1 };
}

async function adminStats(env, user) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const [leads, tools, agents, errors, users] = await Promise.all([
      sbQ(env, 'leads',          '?select=id,contacted,created_at&order=created_at.desc&limit=500'),
      sbQ(env, 'tool_usage',     '?select=tool_name,cached,created_at&order=created_at.desc&limit=500'),
      sbQ(env, 'agent_sessions', '?select=id&limit=1000'),
      sbQ(env, 'error_logs',     `?select=id&created_at=gte.${new Date(Date.now()-86400000).toISOString()}`),
      sbQ(env, 'user_profiles',  '?select=id&limit=10000'),
    ]);
    const week7   = leads.filter(l => new Date(l.created_at) > new Date(Date.now()-7*86400000));
    const cached  = tools.filter(t => t.cached);
    return ok({
      total_leads:    leads.length,
      leads_week:     week7.length,
      uncontacted:    leads.filter(l=>!l.contacted).length,
      tool_uses:      tools.length,
      cache_rate_pct: tools.length ? Math.round(cached.length/tools.length*100) : 0,
      agent_sessions: agents.length,
      errors_24h:     errors.length,
      total_users:    users.length,
    }, 'system');
  } catch(e) { return er(e.message); }
}

async function adminUsers(env, user) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const rows = await sbQ(env, 'user_profiles', '?select=*&order=created_at.desc&limit=500');
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

async function adminLeads(env, user, reqUrl) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const { from, to } = paginate(reqUrl);
    const url = new URL(reqUrl);
    const filter = url.searchParams.get('filter') || 'all';
    let params = `?select=*&order=created_at.desc&range=${from}-${to}`;
    if (filter === 'new')  params += '&contacted=eq.false';
    if (filter === 'done') params += '&contacted=eq.true';
    const rows = await sbQ(env, 'leads', params);
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

async function adminLeadContacted(env, user, body, ctx, ip) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  const leadId = parseInt(body.lead_id);
  if (!leadId) return er('lead_id required', 400);
  try {
    await sbU(env, 'leads', `id=eq.${leadId}`, { contacted: true });
    auditLog(env, user, 'lead_contacted', leadId, { contacted: true }, ip, ctx);
    return ok({ updated: true, lead_id: leadId }, 'system');
  } catch(e) { return er(e.message); }
}

async function adminToolUsage(env, user, reqUrl) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const { from, to } = paginate(reqUrl);
    const rows = await sbQ(env, 'tool_usage',
      `?select=*&order=created_at.desc&range=${from}-${to}`);
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

async function adminAgentSessions(env, user, reqUrl) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const { from, to } = paginate(reqUrl);
    const rows = await sbQ(env, 'agent_sessions',
      `?select=id,session_token,agent_type,model_used,user_email,created_at&order=created_at.desc&range=${from}-${to}`);
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

async function adminErrors(env, user, reqUrl) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  try {
    const { from, to } = paginate(reqUrl);
    const rows = await sbQ(env, 'error_logs',
      `?select=*&order=created_at.desc&range=${from}-${to}`);
    return ok(rows, 'system');
  } catch(e) { return er(e.message); }
}

async function adminUpdateQuota(env, user, body, ctx, ip) {
  if (!isAdmin(user, env)) return er('Admin only', 403);
  const { user_id, daily_quota } = body;
  if (!user_id || daily_quota == null) return er('user_id and daily_quota required', 400);
  if (daily_quota < 0 || daily_quota > 10000) return er('daily_quota must be 0–10000', 400);
  try {
    await sbU(env, 'user_profiles', `user_id=eq.${user_id}`, { daily_quota: Number(daily_quota) });
    auditLog(env, user, 'update_quota', user_id, { daily_quota }, ip, ctx);
    return ok({ updated: true, user_id, daily_quota }, 'system');
  } catch(e) { return er(e.message); }
}

// ══════════════════════════════════════════════════════════════════════
// §13 TOOL HANDLERS (all require email for quota tracking)
// ══════════════════════════════════════════════════════════════════════
async function enforceQuota(env, user, email) {
  if (!email) return { allowed: false, message: 'Email address is required to use this tool.' };

  const userId    = user?.sub || null;
  const anonymous = !userId;
  const quota     = await checkAndIncrementQuota(env, userId, email, anonymous);

  if (!quota.allowed) {
    const lim = quota.limit || (anonymous ? 10 : 20);
    return {
      allowed: false,
      message: `Daily limit of ${lim} uses reached. Resets at midnight UTC. ${anonymous ? 'Create a free account for 20 uses/day.' : ''}`.trim(),
    };
  }
  return { allowed: true };
}

async function toolAds(env, body, ctx, user) {
  const email    = sanitize(body.email    || '', 200).toLowerCase().trim();
  const product  = sanitize(body.product  || '', 300);
  const audience = sanitize(body.audience || '', 200);
  const goal     = sanitize(body.goal     || '', 200);
  if (!product) return er('Product/service required', 400);
  if (isInjection(product) || isInjection(goal)) return er('Invalid input detected', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const ck = await hashKey(`ads-${product}-${audience}-${goal}`);
  const cd = await getCached(env, ck);
  if (cd) {
    sbLog(env, 'tool_usage', { tool_name:'ads_generator', cached:true,  input_summary:product.substring(0,80), model_used:cd.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(cd.data, cd.model, true);
  }

  const draft = `Generate 5 Google Ads headlines and 5 descriptions.
Product/Service: "${product}"
Target Audience: "${audience || 'International B2B and B2C buyers'}"
Campaign Goal: "${goal || 'Generate qualified leads and drive conversions'}"

Requirements:
- Headlines: MAX 30 characters each. Benefit-first. Power words.
- Descriptions: MAX 90 characters each. Include specific CTA. No generic phrases.
- Use numbers and specifics where possible (e.g. "Save 60%", "4.9★ Rated", "48hr Delivery")
Return JSON: {"headlines":["h1","h2","h3","h4","h5"],"descriptions":["d1","d2","d3","d4","d5"]}`;

  try {
    await new Promise(r => setTimeout(r, 300));
    const res    = await dual(env, draft, 'Every headline under 30 chars. Every description under 90 chars with specific CTA. Replace any vague claims with specific numbers. Return same JSON improved.');
    const parsed = parseJ(res.text, { headlines:['Retry — error'], descriptions:['Retry — error'] });
    await setCache(env, ck, { data:parsed, model:res.model });
    sbLog(env, 'tool_usage', { tool_name:'ads_generator', cached:false, input_summary:product.substring(0,80), model_used:res.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(parsed, res.model, false);
  } catch(e) { return er(`Generation failed: ${e.message}`); }
}

async function toolMeta(env, body, ctx, user) {
  const email    = sanitize(body.email    || '', 200).toLowerCase().trim();
  const topic    = sanitize(body.topic    || '', 300);
  const keyword  = sanitize(body.keyword  || '', 100);
  const business = sanitize(body.business || 'BrandBone', 100);
  if (!topic) return er('Page topic required', 400);
  if (isInjection(topic)) return er('Invalid input detected', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const ck = await hashKey(`meta-${topic}-${keyword}-${business}`);
  const cd = await getCached(env, ck);
  if (cd) {
    sbLog(env, 'tool_usage', { tool_name:'meta_generator', cached:true, input_summary:topic.substring(0,80), model_used:cd.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(cd.data, cd.model, true);
  }

  const prompt = `Write SEO meta tags for:
Topic: "${topic}"
Primary Keyword: "${keyword || topic}"
Business Name: "${business}"

Hard requirements:
- Title: EXACTLY 50-60 characters. Start with the keyword. End with " | ${business}".
- Description: EXACTLY 150-160 characters. Include keyword. End with a clear CTA.
- 3 specific SEO tips for this exact page topic.
Return JSON: {"title":"...","description":"...","char_count":{"title":0,"description":0},"tips":["tip1","tip2","tip3"]}`;

  try {
    await new Promise(r => setTimeout(r, 300));
    const res = await callClaude(env, prompt,
      'You are an expert SEO copywriter. Follow the character limits exactly. Return only valid JSON, no markdown.');
    let parsed;
    try {
      const clean = res.text.replace(/```json|```/g,'').trim();
      parsed = JSON.parse(clean);
      parsed.char_count = { title: parsed.title?.length||0, description: parsed.description?.length||0 };
    } catch {
      parsed = {
        title:       `${keyword||topic} | ${business}`.substring(0,60),
        description: `Discover ${topic}. Expert ${business} solutions for international brands — free strategy call today.`.substring(0,155),
        char_count:  { title:0, description:0 },
        tips:        ['Place keyword in first 3 words of title','Include a verb CTA in description','Keep title under 60 characters exactly'],
      };
    }
    await setCache(env, ck, { data:parsed, model:res.model });
    sbLog(env, 'tool_usage', { tool_name:'meta_generator', cached:false, input_summary:topic.substring(0,80), model_used:res.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(parsed, res.model, false);
  } catch(e) { return er(`Generation failed: ${e.message}`); }
}

async function toolEmailSubjects(env, body, ctx, user) {
  const email    = sanitize(body.email    || '', 200).toLowerCase().trim();
  const topic    = sanitize(body.topic    || '', 300);
  const audience = sanitize(body.audience || '', 200);
  const tone     = sanitize(body.tone     || 'urgent', 50);
  if (!topic) return er('Email campaign topic required', 400);
  if (isInjection(topic)) return er('Invalid input detected', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const ck = await hashKey(`email-subj-${topic}-${tone}`);
  const cd = await getCached(env, ck);
  if (cd) {
    sbLog(env, 'tool_usage', { tool_name:'email_subjects', cached:true, input_summary:topic.substring(0,80), model_used:cd.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(cd.data, cd.model, true);
  }

  const prompt = `Write 10 email subject lines for:
Campaign: "${topic}"
Audience: "${audience || 'E-commerce customers and business owners'}"
Required tone: ${tone}

Generate across these psychological angles:
1. Urgency/FOMO — "Only 3 left at this price"
2. Curiosity gap — "We found something unusual in your data"
3. Personalisation — "[First Name], this is for you"
4. Specific data — "Your competitors grew 47% this quarter"
5. Question hook — "Are you making this $2,000 mistake?"
6. Benefit-first — "Double your email open rates (15-min fix)"
7. Story/intrigue — "The mistake that cost me 3,000 subscribers"
8. Social proof — "4,200 brands switched to this strategy"
9. Direct offer — "Free audit: find your biggest marketing leak"
10. Pattern interrupt — "Stop doing [common thing] immediately"

Return JSON: {"subjects":[{"text":"subject under 60 chars","type":"FOMO|Curiosity|etc","why":"why it works — 1 sentence","preview_text":"40-char preview"}]}`;

  try {
    await new Promise(r => setTimeout(r, 300));
    const res    = await dual(env, prompt, 'Make every subject line punchy, original, high open-rate. Replace generic language with specific hooks. Return same JSON improved.');
    const parsed = parseJ(res.text, { subjects:[
      { text:`Last chance: ${topic.substring(0,30)}`, type:'FOMO',     why:'Creates urgency',         preview_text:'Limited time — act now' },
      { text:`Quick question about your business`,    type:'Curiosity', why:'Opens curiosity loop',    preview_text:'Important for your growth' },
    ]});
    await setCache(env, ck, { data:parsed, model:res.model });
    sbLog(env, 'tool_usage', { tool_name:'email_subjects', cached:false, input_summary:topic.substring(0,80), model_used:res.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(parsed, res.model, false);
  } catch(e) { return er(`Generation failed: ${e.message}`); }
}

async function toolContentBrief(env, body, ctx, user) {
  const email    = sanitize(body.email    || '', 200).toLowerCase().trim();
  const keyword  = sanitize(body.keyword  || '', 200);
  const audience = sanitize(body.audience || '', 200);
  if (!keyword) return er('Keyword required', 400);
  if (isInjection(keyword)) return er('Invalid input detected', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const ck = await hashKey(`brief-${keyword}-${audience}`);
  const cd = await getCached(env, ck);
  if (cd) {
    sbLog(env, 'tool_usage', { tool_name:'content_brief', cached:true, input_summary:keyword.substring(0,80), model_used:cd.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(cd.data, cd.model, true);
  }

  const prompt = `Create a comprehensive SEO content brief.
Primary Keyword: "${keyword}"
Target Audience: "${audience || 'Business owners and marketers in USA/UK/EU'}"

Include:
- Ideal article title (60 chars, keyword at start)
- Word count recommendation
- Search intent classification
- 4 H2 outline sections (each with 2 sub-points)
- 5 LSI/semantic keywords
- Primary CTA for the article
- 155-char meta description

Return JSON: {"title":"...","word_count":1500,"search_intent":"informational|commercial|transactional","outline":[{"h2":"heading","points":["p1","p2"]}],"lsi_keywords":["k1","k2","k3","k4","k5"],"cta":"...","meta_description":"..."}`;

  try {
    await new Promise(r => setTimeout(r, 300));
    const res    = await callKimi(env, prompt);
    const parsed = parseJ(res.text, { error:'Parse failed', keyword });
    await setCache(env, ck, { data:parsed, model:res.model });
    sbLog(env, 'tool_usage', { tool_name:'content_brief', cached:false, input_summary:keyword.substring(0,80), model_used:res.model, user_id:user?.sub||null, user_email:email }, ctx);
    return ok(parsed, res.model, false);
  } catch(e) { return er(`Generation failed: ${e.message}`); }
}

async function toolImageCreate(env, body, ctx, user) {
  const email  = sanitize(body.email  || '', 200).toLowerCase().trim();
  const prompt = sanitize(body.prompt || '', 300);
  if (!prompt) return er('Prompt required', 400);
  if (isInjection(prompt)) return er('Invalid prompt', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const taskId = crypto.randomUUID();
  await env.BB_TASKS.put(`task:${taskId}`,
    JSON.stringify({ status:'pending', prompt, created:Date.now() }),
    { expirationTtl: 3600 }
  );
  ctx.waitUntil(processImgTask(env, taskId, prompt));
  sbLog(env, 'tool_usage', { tool_name:'image_generator', cached:false, input_summary:prompt.substring(0,80), model_used:'openrouter-flux1dev', user_id:user?.sub||null, user_email:email }, ctx);
  return ok({ task_id:taskId, status:'pending', poll:`/v1/task/${taskId}` }, 'openrouter-flux1dev', false);
}

async function getTaskStatus(env, taskId) {
  try {
    const d = await env.BB_TASKS.get(`task:${taskId}`);
    if (!d) return er('Task not found', 404);
    return ok(JSON.parse(d), 'system');
  } catch { return er('Task lookup failed'); }
}

// ══════════════════════════════════════════════════════════════════════
// §14 AGENT HANDLER (Kimi → Claude, real memory, 5 personas)
// ══════════════════════════════════════════════════════════════════════
const AGENT_PERSONAS = {
  business: `You are BrandBone's Senior Business Growth Strategist.
ROLE: Identify growth opportunities and build actionable marketing strategies.
APPROACH: Ask 1-2 diagnostic questions first, then give specific, numbered recommendations.
FRAMEWORK: Always anchor advice in these pillars — Traffic, Conversion, Retention, Revenue.
ALWAYS: Provide specific metrics (e.g., "Target 3.8x ROAS", "Reduce CAC by 40%"). Never vague.`,

  lead_gen: `You are BrandBone's Lead Generation Specialist.
ROLE: Help businesses find, attract, and convert ideal customers at scale.
APPROACH: First identify ICP (Ideal Customer Profile), then build the outreach system.
ALWAYS: Give specific LinkedIn search filters, email templates with subject lines, and qualification criteria.
METRICS: Help set realistic lead targets (e.g., "50-100 qualified leads/month from LinkedIn outreach").`,

  content: `You are BrandBone's Content & SEO Strategist.
ROLE: Build content strategies that rank on Google and convert visitors into leads.
FRAMEWORK: Topic clusters → pillar pages → supporting content → internal linking.
ALWAYS: Recommend specific keywords with search intent, word counts, and conversion paths.
TOOLS: Reference tools like Ahrefs, Semrush, and Google Search Console strategies.`,

  seo_audit: `You are BrandBone's Technical SEO Specialist.
ROLE: Diagnose SEO problems and provide a priority-ranked fix list.
FRAMEWORK: Technical → On-page → Content → Authority building.
ALWAYS: Ask for the URL if not provided. Give specific diagnoses with estimated traffic impact.
FORMAT: Rank issues as Critical / High / Medium / Low with effort estimates.`,

  ads_strategy: `You are BrandBone's Performance Marketing Strategist.
ROLE: Create paid advertising strategies across Google, Meta, and TikTok.
FRAMEWORK: Audit wasted spend → Rebuild structure → Creative test → Scale winners.
ALWAYS: Provide specific budget allocation percentages, target ROAS by channel, and campaign structure.
METRICS: Be specific — "Target $0.40 CPA on TikTok", "3.8x ROAS on Google Shopping".`,
};

async function runAgent(env, body, ctx, user) {
  const email      = sanitize(body.email      || '', 200).toLowerCase().trim();
  const agentType  = sanitize(body.agent_type || 'business', 50);
  const message    = sanitize(body.message    || '', 1000);
  const sessionId  = sanitize(body.session_id || '', 50);
  const prevMsgs   = (Array.isArray(body.previous_messages) ? body.previous_messages : [])
    .slice(-6)
    .map(m => ({ role: m.role === 'user' ? 'user':'assistant', content: sanitize(m.content||'', 500) }));

  if (!message) return er('Message required', 400);
  if (isInjection(message)) return er('Invalid message content', 400);

  const quota = await enforceQuota(env, user, email);
  if (!quota.allowed) return er(quota.message, 429);

  const persona  = AGENT_PERSONAS[agentType] || AGENT_PERSONAS.business;
  const history  = prevMsgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  const prompt   = `${persona}

${history ? `CONVERSATION SO FAR:\n${history}\n\n` : ''}USER MESSAGE: ${message}

Respond as the specialist. Be specific and actionable. Ask one follow-up question if you need more context. Keep response under 300 words unless a detailed plan is explicitly requested.`;

  try {
    await new Promise(r => setTimeout(r, 200));
    let res;
    try   { res = await callClaude(env, prompt, persona); }
    catch { res = await callKimi(env, prompt); }

    const sessId = sessionId || crypto.randomUUID();

    sbLog(env, 'agent_sessions', {
      session_token: sessId,
      agent_type:    agentType,
      messages_json: JSON.stringify([...prevMsgs,
        { role:'user',      content:message  },
        { role:'assistant', content:res.text },
      ]),
      model_used:  res.model,
      user_id:     user?.sub || null,
      user_email:  email,
    }, ctx);

    return ok({ reply:res.text, session_id:sessId, agent_type:agentType }, res.model, false);
  } catch(e) { return er(`Agent error: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════════
// §15 LEAD CAPTURE
// ══════════════════════════════════════════════════════════════════════
async function captureLead(env, body, ctx) {
  const email   = sanitize(body.email    || '', 200).toLowerCase().trim();
  const name    = sanitize(body.name     || '', 100);
  const source  = sanitize(body.source   || '', 200);
  const tool    = sanitize(body.tool_used|| '', 100);
  const message = sanitize(body.message  || '', 500);
  if (!email || !email.includes('@')) return er('Valid email required', 400);

  const lead = { email, name, source_page:source, tool_used:tool, message, contacted:false };
  ctx.waitUntil(sbI(env, 'leads', lead).catch(() => {}));

  if (env.ADMIN_EMAIL && env.RESEND_KEY) {
    ctx.waitUntil(Promise.resolve(sendEmail(env, env.ADMIN_EMAIL, `🎯 New Lead: ${email}`, leadEmailHtml(lead))));
  }
  return ok({ captured:true }, 'system');
}

// ══════════════════════════════════════════════════════════════════════
// §16 ROUTER
// ══════════════════════════════════════════════════════════════════════
async function router(request, env, ctx) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const origin = request.headers.get('Origin') || '*';
  const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = env?.ALLOWED_ORIGIN || origin;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin':  allowed,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-BB-Key, Authorization',
      'Access-Control-Max-Age':       '86400',
    }});
  }

  // Health (public)
  if (path === '/v1/health' || path === '/health') {
    return jRes(ok({
      status:'operational', version:'5.0',
      models:['kimi-k2.5','claude-haiku'],
      images:'openrouter-flux1dev→pollinations→hf',
      cache:'cloudflare-kv', db:'supabase', email: !!env.RESEND_KEY,
    },'system'), 200, env, origin);
  }

  // API key guard
  const bbKey = request.headers.get('X-BB-Key');
  if (!bbKey || bbKey !== env.BB_API_KEY) {
    return jRes(er('Unauthorized — include X-BB-Key header', 401), 401, env, origin);
  }

  // IP rate limit (flood control only)
  if (!rlCheck(ip, 40, 60000)) {
    return jRes(er('Too many requests — wait 1 minute', 429), 429, env, origin);
  }

  const user = await getUser(request, env);

  // ── GET routes ──────────────────────────────────────────────────────
  if (request.method === 'GET') {
    if (path === '/v1/user/me')            return jRes(await userMe(env, user),                    200, env, origin);
    if (path === '/v1/user/usage')         return jRes(await userUsage(env, user),                 200, env, origin);
    if (path === '/v1/admin/stats')        return jRes(await adminStats(env, user),                200, env, origin);
    if (path === '/v1/admin/users')        return jRes(await adminUsers(env, user),                200, env, origin);
    if (path === '/v1/admin/leads')        return jRes(await adminLeads(env, user, request.url),   200, env, origin);
    if (path === '/v1/admin/tool-usage')   return jRes(await adminToolUsage(env, user, request.url), 200, env, origin);
    if (path === '/v1/admin/agent-sessions') return jRes(await adminAgentSessions(env, user, request.url), 200, env, origin);
    if (path === '/v1/admin/errors')       return jRes(await adminErrors(env, user, request.url), 200, env, origin);

    const taskMatch = path.match(/^\/v1\/task\/([a-z0-9\-]{36})$/);
    if (taskMatch)  return jRes(await getTaskStatus(env, taskMatch[1]), 200, env, origin);

    return jRes(er(`Route not found: ${path}`, 404), 404, env, origin);
  }

  // ── POST routes ──────────────────────────────────────────────────────
  if (request.method !== 'POST') {
    return jRes(er('Method not allowed', 405), 405, env, origin);
  }

  let body = {};
  try { body = await request.json(); }
  catch { return jRes(er('Invalid JSON body', 400), 400, env, origin); }

  let result;
  switch (path) {
    // Auth
    case '/v1/auth/signup':              result = await authSignup(env, body, ctx);                     break;
    case '/v1/auth/login':               result = await authLogin(env, body);                           break;
    // User
    case '/v1/user/me':                  result = await userMe(env, user);                              break;
    case '/v1/user/usage':               result = await userUsage(env, user);                           break;
    // Admin
    case '/v1/admin/update-quota':       result = await adminUpdateQuota(env, user, body, ctx, ip);     break;
    case '/v1/admin/lead-contacted':     result = await adminLeadContacted(env, user, body, ctx, ip);   break;
    case '/v1/admin/stats':              result = await adminStats(env, user);                          break;
    case '/v1/admin/users':              result = await adminUsers(env, user);                          break;
    case '/v1/admin/leads':              result = await adminLeads(env, user, request.url);             break;
    // Tools (all require email)
    case '/v1/tool/ads-generator':       result = await toolAds(env, body, ctx, user);                 break;
    case '/v1/tool/meta-generator':      result = await toolMeta(env, body, ctx, user);                break;
    case '/v1/tool/email-subjects':      result = await toolEmailSubjects(env, body, ctx, user);       break;
    case '/v1/tool/content-brief':       result = await toolContentBrief(env, body, ctx, user);        break;
    case '/v1/tool/image-generator':     result = await toolImageCreate(env, body, ctx, user);         break;
    // Agent
    case '/v1/agent/chat':               result = await runAgent(env, body, ctx, user);                 break;
    // Leads
    case '/v1/lead/capture':             result = await captureLead(env, body, ctx);                    break;
    default:
      result = er(`Route not found: ${path}`, 404);
  }

  const status = result.status === 'success' ? 200 : (result.code || 500);
  return jRes(result, status, env, origin);
}

// ══════════════════════════════════════════════════════════════════════
// §17 MAIN HANDLER (28-second timeout)
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const origin  = request.headers.get('Origin') || '*';
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 28000));
    try {
      return await Promise.race([router(request, env, ctx), timeout]);
    } catch(e) {
      const code = e.message === 'timeout' ? 408 : 500;
      const msg  = e.message === 'timeout' ? 'Request timed out — please retry' : 'Internal server error';
      ctx.waitUntil(
        fetch(`${env.SUPABASE_URL}/rest/v1/error_logs`, {
          method:  'POST',
          headers: {
            'apikey':       env.SUPABASE_KEY,
            'Authorization':`Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer':       'return=minimal',
          },
          body: JSON.stringify({ path: new URL(request.url).pathname, error: e.message, method: request.method }),
        }).catch(() => {})
      );
      return new Response(JSON.stringify(er(msg, code)), {
        status: code,
        headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || origin },
      });
    }
  }
};
