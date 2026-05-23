// src/services/supabase.js
// Direct REST API — NOT @supabase/supabase-js (causes issues in Workers)
// Always uses SERVICE_ROLE_KEY — bypasses RLS

function headers(env) {
  return {
    'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation'
  }
}

export async function supabaseQuery(env, table, method = 'GET', body = null, params = '') {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${params}`
  const opts = { method, headers: headers(env) }
  if (body) opts.body = JSON.stringify(body)

  const res = await fetch(url, opts)
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Supabase ${method} ${table}: ${res.status} — ${txt}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}

export async function supabaseInsert(env, table, data) {
  return supabaseQuery(env, table, 'POST', data)
}

export async function supabaseRPC(env, fnName, params = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`
  const res = await fetch(url, {
    method:  'POST',
    headers: headers(env),
    body:    JSON.stringify(params)
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Supabase RPC ${fnName}: ${res.status} — ${txt}`)
  }
  return res.json()
                       }
                       
