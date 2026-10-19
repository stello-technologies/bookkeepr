// Verifies the Auth0 access token and sets req.tenantId from its `sub`.
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { fail } from './db';

declare module 'fastify' {
  interface FastifyRequest { tenantId: string }
}

/** `getKey` is only for tests (a local key instead of Auth0's public keys). */
export function auth(app: FastifyInstance, getKey?: JWTVerifyGetKey) {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!domain || !audience) throw new Error('AUTH0_DOMAIN and AUTH0_AUDIENCE must be set');
  const issuer = `https://${domain}/`;
  const key = getKey ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));

  app.decorateRequest('tenantId', '');
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return; // static files and /health stay public
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) fail(401, 'unauthorized', 'missing bearer token');
    try {
      const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ['RS256'] });
      if (!payload.sub) throw new Error('token has no sub');
      req.tenantId = payload.sub; // the ONLY source of tenantId
      req.log = req.log.child({ tenant: payload.sub });
    } catch (err) {
      req.log.warn({ reason: (err as Error).message }, 'token rejected');
      fail(401, 'unauthorized', 'invalid token');
    }
  });
}
