// src/utils/response.js — FROZEN response format
// ALL endpoints return this exact structure — never change field names

export const ERROR_CODES = {
  AUTH_REQUIRED:    'AUTH_REQUIRED',
  AUTH_INVALID:     'AUTH_INVALID',
  AUTH_EXPIRED:     'AUTH_EXPIRED',
  QUOTA_EXCEEDED:   'QUOTA_EXCEEDED',
  RATE_LIMITED:     'RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AI_ERROR:         'AI_ERROR',
  AI_TIMEOUT:       'AI_TIMEOUT',
  NOT_FOUND:        'NOT_FOUND',
  FORBIDDEN:        'FORBIDDEN',
  BANNED:           'ACCOUNT_BANNED',
  INTERNAL_ERROR:   'INTERNAL_ERROR'
}

export function success(data, meta = {}) {
  return {
    status:     'success',
    data,
    message:    meta.message   || null,
    model:      meta.model     || null,
    cached:     meta.cached    || false,
    error_code: null,
    request_id: meta.requestId || null,
    ts:         new Date().toISOString()
  }
}

export function error(message, code = ERROR_CODES.INTERNAL_ERROR, extra = {}) {
  return {
    status:     'error',
    data:       extra.data || null,
    message,
    model:      null,
    cached:     false,
    error_code: code,
    request_id: extra.requestId || null,
    ts:         new Date().toISOString()
  }
    }

