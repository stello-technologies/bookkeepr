// One endpoint keeps every device in step: it takes what the device made, and returns what changed since it last asked.
// Merging is simple because records are only ever created or deleted: union of everything, deleted wins.
import type { FastifyInstance } from 'fastify';
import type { Collection } from 'mongodb';
import { z, ZodError } from 'zod';
import { parties, items, entries, view, fail, oid } from './db';
import { createParty, createItem, createEntry, updateItem, removeRecord, partyBody, itemBody, priceBody, entryBody } from './crud';
import { who, accountInfo } from './accounts';

const PAGE = 500; // most records of one kind returned per call
const OVERLAP = 200; // every pull re-reads this many recent changes, so one that committed late is never missed. Repeats are harmless.
const MAX_PUSH = 500; // most records a device may send in one call

const list = z.array(z.unknown()).default([]);
const syncBody = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  cursor: z.number().int().min(0).default(0), // the highest change number this device has seen
  push: z.object({ parties: list, items: list, entries: list, deletes: list, updates: list }).default({}), // `updates`: price changes; older phones omit it
}).refine((b) => Object.values(b.push).reduce((n, l) => n + l.length, 0) <= MAX_PUSH, { message: `at most ${MAX_PUSH} records per sync` });

const deleteBody = z.object({ kind: z.enum(['parties', 'items', 'entries']), id: oid, reason: z.string().trim().max(200).default('') });

type Rejection = { id: string; code: string; kind?: 'update' }; // `kind` tells a refused price change from a refused create with the same id

/** Apply each record on its own. A bad one is reported back and skipped; it never blocks the rest. */
async function each(records: unknown[], run: (r: unknown) => Promise<unknown>, rejected: Rejection[], kind?: 'update') {
  let applied = 0;
  for (const r of records) {
    try { await run(r); applied++; }
    catch (err: any) {
      const known = err instanceof ZodError || err.statusCode;
      if (!known) throw err; // a database outage is not the record's fault: fail the call so the device retries it all
      rejected.push({ id: String((r as any)?.id ?? ''), code: err instanceof ZodError ? 'validation' : err.code, ...(kind && { kind }) });
    }
  }
  return applied;
}
const needId = (b: { id?: string }) => { if (!b.id) fail(400, 'validation', 'id is required'); };

/** Everything for this business that changed after `cursor - OVERLAP`, deleted records included. */
async function pull(tenantId: string, cursor: number) {
  const read = (c: Collection<any>) => c.find({ tenantId, seq: { $gt: Math.max(0, cursor - OVERLAP) } }).sort({ seq: 1 }).limit(PAGE).toArray();
  const [p, i, e] = await Promise.all([read(parties() as any), read(items() as any), read(entries() as any)]);
  const lists = [p, i, e];
  const top = Math.max(cursor, ...lists.flat().map((d) => d.seq));
  // A kind that hit the page limit has more behind it, so the cursor may only move up to where that kind stopped.
  const stops = lists.filter((l) => l.length === PAGE).map((l) => l[l.length - 1].seq);
  return { changes: { parties: p.map(view), items: i.map(view), entries: e.map(view) }, cursor: stops.length ? Math.max(cursor, Math.min(...stops)) : top, more: stops.length > 0 };
}

export function syncRoutes(app: FastifyInstance) {
  app.post('/api/sync', async (req) => {
    const b = syncBody.parse(req.body);
    const w = { ...who(req), deviceId: b.deviceId };
    const rejected: Rejection[] = [];
    let applied = 0;
    // Order matters: people and items first, so an entry sent in the same call can point at them.
    applied += await each(b.push.parties, async (r) => { const x = partyBody.parse(r); needId(x); await createParty(w, x); }, rejected);
    applied += await each(b.push.items, async (r) => { const x = itemBody.parse(r); needId(x); await createItem(w, x); }, rejected);
    applied += await each(b.push.updates, async (r) => { const x = priceBody.parse(r); needId(x); await updateItem(w, x.id!, x.priceKobo); }, rejected, 'update');
    applied += await each(b.push.entries, async (r) => { const x = entryBody.parse(r); needId(x); await createEntry(w, x, { keepRemoved: true }); }, rejected);
    applied += await each(b.push.deletes, async (r) => { const x = deleteBody.parse(r); await removeRecord(w, x.kind, x.id, x.reason); }, rejected);
    return { applied, rejected, ...(await pull(req.tenantId, b.cursor)), accountId: req.tenantId, userId: req.userId, role: req.role, ...(await accountInfo(req.tenantId)), serverTime: new Date() };
  });
}
