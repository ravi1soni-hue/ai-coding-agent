# Code Review Findings

## 1) Critical: WebSocket endpoint has no CSRF/origin validation

`createSocketServer` accepts authenticated browser cookies (`sid`) during the WebSocket handshake but does not validate the `Origin` header. A malicious website can open a socket to this backend from a victim browser and execute actions as that user (Cross-Site WebSocket Hijacking).

- File: `backend/src/api/socket.ts`
- Recommendation: Reject connections where `request.headers.origin` is not an expected frontend origin; consider token-based auth instead of ambient cookies for WebSocket handshakes.

## 2) High: Runtime serves static frontend before API route registration

In `start()`, static assets are registered with `prefix: '/'` before API routes. This can unexpectedly shadow API endpoints in some setups and make routing behavior environment-dependent.

- File: `backend/src/index.ts`
- Recommendation: Register API routes before static file handler, or place static files on a non-root prefix.

## 3) Medium: Duplicate server bootstrap implementation can drift

There are two different server bootstrap paths (`backend/src/index.ts` and `backend/src/api/server.ts`). Only `index.ts` appears to be used, while `server.ts` defines different static root and its own `/health` route. This duplication increases drift risk.

- Files: `backend/src/index.ts`, `backend/src/api/server.ts`
- Recommendation: Remove the unused bootstrap or consolidate into one canonical server entrypoint.
