import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { JWTVerifyGetKey } from 'jose';
import { auth } from './auth';
import { connect } from './db';
import { crudRoutes } from './crud';
import { reportRoutes } from './reports';
import { accountRoutes } from './accounts';
import { syncRoutes } from './sync';
import { existsSync } from 'node:fs';

export function buildApp(getKey?: JWTVerifyGetKey) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // One error shape for everything: { error, code }. Details go to the log, not the client.
  app.setErrorHandler((error, req, reply) => {
    const err = error as FastifyError;
    if (err instanceof ZodError) {
      req.log.warn({ issues: err.issues }, 'validation failed');
      return reply.code(400).send({ error: 'invalid input', code: 'validation', details: err.issues });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    else req.log.warn({ code: err.code, msg: err.message }, 'request rejected');
    return reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message, code: status >= 500 ? 'internal' : err.code });
  });

  auth(app, getKey);
  app.get('/health', async () => ({ ok: true }));
  // What the browser needs to start Auth0 sign-in. Public on purpose: none of it is secret.
  if (!process.env.AUTH0_CLIENT_ID) app.log.error('AUTH0_CLIENT_ID is not set: browser sign-in cannot start');
  app.get('/config.json', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      domain: process.env.AUTH0_DOMAIN,
      clientId: process.env.AUTH0_CLIENT_ID,
      audience: process.env.AUTH0_AUDIENCE,
    };
  });
  accountRoutes(app);
  syncRoutes(app);
  crudRoutes(app);
  reportRoutes(app);
  const webDir = fileURLToPath(new URL('../web', import.meta.url));
  if (!existsSync(webDir)) app.log.error(`Web folder not found: ${webDir}`);
  app.register(fastifyStatic, { root: webDir });
  app.get('/favicon.svg', (_req, reply) => reply.sendFile('assets/favicon.svg'));
  app.get('/favicon.ico', (_req, reply) => reply.sendFile('assets/favicon.ico'));
  app.get('/apple-touch-icon.png', (_req, reply) => reply.sendFile('assets/apple-touch-icon.png'));
  return app;
}

// Start listening only when run directly (tests import buildApp instead).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI must be set');
  if (!process.env.AUTH0_CLIENT_ID) throw new Error('AUTH0_CLIENT_ID must be set');
  await connect(uri);
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}