import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { JWTVerifyGetKey } from 'jose';
import { auth } from './auth';
import { connect } from './db';
import { crudRoutes } from './crud';
import { reportRoutes } from './reports';

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
  crudRoutes(app);
  reportRoutes(app);
  app.register(fastifyStatic, { root: path.resolve('public') });
  return app;
}

// Start listening only when run directly (tests import buildApp instead).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI must be set');
  await connect(uri);
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
