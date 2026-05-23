// src/services/auditLog.js
// Only logs important events — not every tool run (saves DB writes on free plan)
import { supabaseInsert } from './supabase.js'

const IMPORTANT = [
  'user.signup','user.upgrade','user.ban','user.unban',
  'admin.login','payment.completed','payment.failed',
  'quota.exceeded','plan.changed'
]

export async function logAudit(env, data) {
  if (!IMPORTANT.includes(data.action)) return  // Skip routine events

  try {
    await supabaseInsert(env, 'audit_logs', {
      actor_id:       data.actorId      || null,
      actor_email:    data.actorEmail   || null,
      actor_role:     data.actorRole    || 'system',
      actor_ip:       data.actorIp      || null,
      action:         data.action,
      resource_type:  data.resourceType || null,
      resource_id:    data.resourceId ? String(data.resourceId) : null,
      old_value:      data.oldValue     || null,
      new_value:      data.newValue     || null,
      metadata:       data.metadata     || {},
      result:         data.result       || 'success',
      failure_reason: data.failureReason || null
    })
  } catch (err) {
    console.error('[AuditLog] Failed (non-blocking):', err.message)
  }
}

