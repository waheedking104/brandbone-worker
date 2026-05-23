// src/middleware/requestId.js
export const requestIdMiddleware = async (c, next) => {
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID()
  c.set('requestId', requestId)
  await next()
  c.res.headers.set('X-Request-ID', requestId)
}

