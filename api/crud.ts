// Create / read / delete for parties, items and entries. Delete only sets a `deleted` tag and records who did it.
// There is no update: to fix a mistake, delete the entry and add a correct one.
// The create and delete functions are shared by these routes and by sync, so both obey the same rules.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Collection, type Document } from 'mongodb';
import { z } from 'zod';
import { parties, items, entries, live, words, view, fail, oid, nextSeq, ENTRY_TYPES } from './db';
import { balances, stockByItem } from './reports';
import { need, who, type Who } from './accounts';

const PAGE_SIZE = 100;
const MAX_FUTURE_MS = 86_400_000; // a phone clock may run a little fast, but an entry cannot be for tomorrow

// ---- validation -------------------------------------------------------------
const kobo = z.number().int().safe().min(0); // whole kobo, never negative
const qty = z.number().positive().finite(); // can be fractional; the item's unit says what it measures
const note = z.string().max(500).default('');

// `id`, `date` and `invoiceNo` are optional: a phone that recorded something offline brings its own; otherwise the server makes them.
const date = z.coerce.date().min(new Date('2000-01-01')).refine((d) => d.getTime() <= Date.now() + MAX_FUTURE_MS, 'date is in the future').optional();
const invoiceNo = z.string().regex(/^INV-[0-9A-F]{10}$/).optional();
const common = { id: oid.optional(), date, invoiceNo, note };

export const partyBody = z.object({ id: oid.optional(), name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).default('') });
export const itemBody = z.object({ id: oid.optional(), name: z.string().trim().min(1).max(100), unit: z.string().trim().min(1).max(20), priceKobo: kobo });
export const priceBody = z.object({ id: oid.optional(), priceKobo: kobo }); // boss changes an item's price

// An invoice (sale, purchase or opening stock) carries one or more product lines.
// The server works out each line's total = round(qty x unitPriceKobo) and the invoice total = their sum.
const line = z.object({ itemId: oid, qty, unitPriceKobo: kobo });
const lines = z.array(line).min(1).max(50);
export const entryBody = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('sale'), lines, partyId: oid.optional(), paidKobo: kobo.optional() }),
  z.object({ ...common, type: z.literal('purchase'), lines, partyId: oid.optional(), paidKobo: kobo.optional() }),
  z.object({ ...common, type: z.literal('opening_stock'), lines }), // stock you already had; counts for stock and cost only
  z.object({ ...common, type: z.literal('expense'), totalKobo: kobo.min(1) }),
  z.object({ ...common, type: z.literal('payment_in'), partyId: oid, totalKobo: kobo.min(1) }),
  z.object({ ...common, type: z.literal('payment_out'), partyId: oid, totalKobo: kobo.min(1) }),
]);

const idParam = z.object({ id: oid });
const reasonQuery = z.object({ reason: z.string().trim().max(200).default('') });
const listQuery = z.object({ q: z.string().max(100).optional(), cursor: oid.optional() });
const entryQuery = listQuery.extend({
  cursor: z.string().max(60).optional(), // entries are listed newest DATE first, so their cursor is "date_id"
  // one type, or several separated by commas: ?type=payment_in,payment_out
  type: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(ENTRY_TYPES)).min(1)).optional(),
  partyId: oid.optional(),
  itemId: oid.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ---- helpers ----------------------------------------------------------------
/** Newest first; `next` is the cursor for the following page (null on the last page). */
async function page(coll: Collection<any>, filter: Document, cursor?: string) {
  if (cursor) filter._id = { $lt: new ObjectId(cursor) };
  const docs = await coll.find(filter).sort({ _id: -1 }).limit(PAGE_SIZE + 1).toArray();
  return { docs: docs.slice(0, PAGE_SIZE), next: docs.length > PAGE_SIZE ? String(docs[PAGE_SIZE - 1]._id) : null };
}

/** Entries newest DATE first (so a backdated entry sits where its date says), ties broken by id. */
async function entryPage(filter: Document, cursor?: string) {
  if (cursor) {
    const m = cursor.match(/^(\d+)_([a-f0-9]{24})$/i);
    if (!m) fail(400, 'bad_cursor');
    const d = new Date(Number(m[1]));
    filter.$or = [{ date: { $lt: d } }, { date: d, _id: { $lt: new ObjectId(m[2]) } }];
  }
  const docs = await entries().find(filter).sort({ date: -1, _id: -1 }).limit(PAGE_SIZE + 1).toArray();
  const last = docs[PAGE_SIZE - 1];
  return { docs: docs.slice(0, PAGE_SIZE), next: docs.length > PAGE_SIZE ? `${last.date.getTime()}_${last._id}` : null };
}

/** The same id again from the same business is a retry: hand back what is already there. Another business's id is refused. */
async function already(coll: Collection<any>, tenantId: string, id?: string) {
  if (!id) return null;
  const old = await coll.findOne({ _id: new ObjectId(id) });
  if (old && old.tenantId !== tenantId) fail(409, 'id_taken');
  return old;
}

/** Insert; if the same id got in a moment ago (two retries at once), that first one wins. Any other clash is rethrown. */
async function place(coll: Collection<any>, doc: Document) {
  try { await coll.insertOne(doc); return doc; }
  catch (err: any) {
    if (err.code !== 11000) throw err;
    const old = await already(coll, doc.tenantId, String(doc._id));
    if (old) return old;
    throw err;
  }
}

/** Who made it, when the server got it, and its change number. Set by the server, never taken from the request. */
const stamp = async (w: Who) => ({ seq: await nextSeq(w.tenantId), createdBy: w.userId, deviceId: w.deviceId, receivedAt: new Date() });
/** `keepRemoved`: sync may point at a person or item another device has since removed; the sale still happened. */
const scope = (tenantId: string, extra: Document, keepRemoved?: boolean) => (keepRemoved ? { ...extra, tenantId } : live(tenantId, extra));

export async function createParty(w: Who, b: z.infer<typeof partyBody>) {
  const old = await already(parties(), w.tenantId, b.id);
  if (old) return view(old);
  const doc = { _id: new ObjectId(b.id), tenantId: w.tenantId, name: b.name, phone: b.phone, search: words(b.name, b.phone), deleted: false, createdAt: new Date(), ...(await stamp(w)) };
  return view(await place(parties(), doc));
}

export async function createItem(w: Who, b: z.infer<typeof itemBody>) {
  const old = await already(items(), w.tenantId, b.id);
  if (old) return view(old);
  const doc = { _id: new ObjectId(b.id), tenantId: w.tenantId, name: b.name, unit: b.unit, priceKobo: b.priceKobo, search: words(b.name), deleted: false, createdAt: new Date(), ...(await stamp(w)) };
  return view(await place(items(), doc));
}

/** The boss changes an item's price. Nothing is deleted or rewritten: past entry lines keep the price they were recorded at,
 *  and the new `seq` makes every phone pull the item again. If two edits clash, the one the server saw last wins. */
export async function updateItem(w: Who, id: string, priceKobo: number) {
  need(w, 'manage');
  const coll = items() as Collection<any>;
  const rec = await coll.findOne({ _id: new ObjectId(id), tenantId: w.tenantId });
  if (!rec || rec.deleted) fail(404, 'not_found');
  if (rec.priceKobo === priceKobo) return view(rec); // same price: no change, so no phone has to re-download it
  const set = { priceKobo, priceUpdatedAt: new Date(), priceUpdatedBy: w.userId, seq: await nextSeq(w.tenantId) };
  const r = await coll.updateOne({ _id: rec._id, tenantId: w.tenantId, deleted: { $ne: true } }, { $set: set });
  if (!r.matchedCount) fail(404, 'not_found'); // removed a moment ago
  return view({ ...rec, ...set });
}

export async function createEntry(w: Who, body: z.infer<typeof entryBody>, o: { keepRemoved?: boolean } = {}) {
  const old = await already(entries(), w.tenantId, body.id);
  if (old) return view(old);
  const e: Document = { _id: new ObjectId(body.id), tenantId: w.tenantId, type: body.type, note: body.note, deleted: false };
  let partyName = '', itemName = '';

  if ('partyId' in body && body.partyId) {
    const party = await parties().findOne(scope(w.tenantId, { _id: new ObjectId(body.partyId) }, o.keepRemoved));
    if (!party) fail(404, 'party_not_found');
    e.partyId = party._id;
    partyName = party.name;
  }

  if ('lines' in body) {
    const wanted = [...new Set(body.lines.map((l) => l.itemId))];
    const found = await items().find(scope(w.tenantId, { _id: { $in: wanted.map((i) => new ObjectId(i)) } }, o.keepRemoved)).toArray();
    const byId = new Map(found.map((i) => [String(i._id), i]));
    if (wanted.some((i) => !byId.has(i))) fail(404, 'item_not_found');
    // No stock check: shops sell before they record stock, and record stock after the fact. Short stock shows as a negative number.
    e.lines = body.lines.map((l) => ({ itemId: new ObjectId(l.itemId), qty: l.qty, unitPriceKobo: l.unitPriceKobo, totalKobo: Math.round(l.qty * l.unitPriceKobo) }));
    e.totalKobo = e.lines.reduce((sum: number, l: { totalKobo: number }) => sum + l.totalKobo, 0);
    itemName = [...byId.values()].map((i) => i.name).join(' ');
  } else {
    e.totalKobo = body.totalKobo;
  }
  if (!Number.isSafeInteger(e.totalKobo)) fail(400, 'total_too_large');

  // "Paid now" defaults to the full total. A sale with no party and paid < total is allowed,
  // but that unpaid amount can't be chased: it shows in the owed-to-you total, not on any person.
  e.paidKobo = 'paidKobo' in body && body.paidKobo !== undefined ? body.paidKobo : e.totalKobo;
  if (e.paidKobo > e.totalKobo) fail(400, 'paid_exceeds_total', 'paidKobo cannot be more than the total');

  e.date = body.date ?? new Date();
  Object.assign(e, await stamp(w));
  for (let attempt = 0; attempt < 5; attempt++) {
    // A phone's own invoice number is kept unless it clashes with another entry's; then the server gives a fresh one.
    e.invoiceNo = attempt === 0 && body.invoiceNo ? body.invoiceNo : 'INV-' + randomBytes(5).toString('hex').toUpperCase();
    e.search = words(e.invoiceNo, e.type, partyName, itemName, e.note);
    try {
      return view(await place(entries(), e));
    } catch (err: any) {
      if (err.code !== 11000) throw err; // 11000 = invoice number already used, try another
    }
  }
  return fail(500, 'invoice_no_failed', 'could not allocate an invoice number');
}

const COLLECTIONS = { parties, items, entries };
const ACTION = { parties: 'remove_party', items: 'remove_item', entries: 'delete_entry' } as const;
export type Kind = keyof typeof COLLECTIONS;

/** Mark a record deleted. The FIRST delete wins: who and when are never overwritten. */
export async function removeRecord(w: Who, kind: Kind, id: string, reason = ''): Promise<'removed' | 'already'> {
  const coll = COLLECTIONS[kind]() as Collection<any>;
  const rec = await coll.findOne({ _id: new ObjectId(id), tenantId: w.tenantId });
  if (!rec) fail(404, 'not_found');
  need(w, ACTION[kind], rec);
  if (rec.deleted) return 'already';
  const r = await coll.updateOne(
    { _id: rec._id, tenantId: w.tenantId, deleted: { $ne: true } },
    { $set: { deleted: true, deletedAt: new Date(), deletedBy: w.userId, deletedReason: reason, seq: await nextSeq(w.tenantId) } });
  return r.matchedCount ? 'removed' : 'already';
}

// ---- routes -----------------------------------------------------------------
export function crudRoutes(app: FastifyInstance) {
  const remove = (kind: Kind) => async (req: any) => {
    const { id } = idParam.parse(req.params);
    const { reason } = reasonQuery.parse(req.query);
    if ((await removeRecord(who(req), kind, id, reason)) === 'already') fail(404, 'not_found');
    return { id, deleted: true };
  };

  // parties (each returned with what they owe you / what you owe them)
  app.get('/api/parties', async (req) => {
    const { q, cursor } = listQuery.parse(req.query);
    const { docs, next } = await page(parties(), live(req.tenantId, {}, q), cursor);
    const { byParty } = await balances(req.tenantId);
    const none = { owesYouKobo: 0, youOweKobo: 0 };
    return { data: docs.map((d) => ({ ...view(d), ...(byParty.get(String(d._id)) ?? none) })), next };
  });
  app.post('/api/parties', async (req, reply) => reply.code(201).send(await createParty(who(req), partyBody.parse(req.body))));
  app.delete('/api/parties/:id', remove('parties'));

  // items (each returned with computed stock)
  app.get('/api/items', async (req) => {
    const { q, cursor } = listQuery.parse(req.query);
    const { docs, next } = await page(items(), live(req.tenantId, {}, q), cursor);
    const stock = await stockByItem(req.tenantId);
    return { data: docs.map((d) => ({ ...view(d), stock: stock.get(String(d._id)) ?? 0 })), next };
  });
  app.post('/api/items', async (req, reply) => reply.code(201).send(await createItem(who(req), itemBody.parse(req.body))));
  app.patch('/api/items/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { priceKobo } = priceBody.parse(req.body);
    return updateItem(who(req), id, priceKobo);
  });
  app.delete('/api/items/:id', remove('items'));

  // entries (the ledger)
  app.get('/api/entries', async (req) => {
    const { q, cursor, type, partyId, itemId, from, to } = entryQuery.parse(req.query);
    const filter: Document = {};
    if (type) filter.type = { $in: type };
    if (partyId) filter.partyId = new ObjectId(partyId);
    if (itemId) filter['lines.itemId'] = new ObjectId(itemId);
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
    const { docs, next } = await entryPage(live(req.tenantId, filter, q), cursor);
    return { data: docs.map(view), next };
  });
  app.post('/api/entries', async (req, reply) => reply.code(201).send(await createEntry(who(req), entryBody.parse(req.body))));
  app.delete('/api/entries/:id', remove('entries'));
}
