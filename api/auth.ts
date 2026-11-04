// Verifies the Auth0 access token, then works out which business the login belongs to and its role.
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { fail } from './db';
import { resolveAccount, type Role } from './accounts';

declare module 'fastify' {
  interface FastifyRequest { tenantId: string; userId: string; role: Role; deviceId: string }
}

/** `getKey` is only for tests (a local key instead of Auth0's public keys). */
export function auth(app: FastifyInstance, getKey?: JWTVerifyGetKey) {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!domain || !audience) throw new Error('AUTH0_DOMAIN and AUTH0_AUDIENCE must be set');
  const issuer = `https://${domain}/`;
  const key = getKey ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));

  app.decorateRequest('tenantId', '');
  app.decorateRequest('userId', '');
  app.decorateRequest('role', 'staff' as Role); // overwritten for every request
  app.decorateRequest('deviceId', '');
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return; // static files and /health stay public
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) fail(401, 'unauthorized', 'missing bearer token');
    let sub = '', name = 'Boss';
    try {
      const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ['RS256'] });
      if (!payload.sub) throw new Error('token has no sub');
      sub = payload.sub;
      name = String(payload.name ?? payload.email ?? name).slice(0, 100);
    } catch (err) {
      req.log.warn({ reason: (err as Error).message }, 'token rejected');
      fail(401, 'unauthorized', 'invalid token');
    }
    const a = await resolveAccount(sub, name); // the ONLY source of tenantId and role (403 if the member was removed)
    req.tenantId = a.tenantId;
    req.userId = sub;
    req.role = a.role;
    const device = String(req.headers['x-device-id'] ?? '');
    req.deviceId = /^[A-Za-z0-9_-]{8,64}$/.test(device) ? device : '';
    req.log = req.log.child({ tenant: a.tenantId, user: sub });
  });
}
