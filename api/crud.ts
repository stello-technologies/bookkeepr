// Create / read / delete for parties, items and entries. Delete only sets a `deleted` tag.
// There is no update: to fix a mistake, delete the entry and add a correct one.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Collection, type Document } from 'mongodb';
import { z } from 'zod';
import { parties, items, entries, live, words, view, fail, oid, ENTRY_TYPES } from './db';
import { balances, stockByItem, round } from '../api/reports';

const PAGE_SIZE = 100;

// ---- validation -------------------------------------------------------------
const kobo = z.number().int().safe().min(0); // whole kobo, never negative
const qty = z.number().positive().finite(); // can be fractional; the item's unit says what it measures
const note = z.string().max(500).default('');

const partyBody = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).default('') });
const itemBody = z.object({ name: z.string().trim().min(1).max(100), unit: z.string().trim().min(1).max(20), priceKobo: kobo });

// An invoice (sale, purchase or opening stock) carries one or more product lines.
// The server works out each line's total = round(qty x unitPriceKobo) and the invoice total = their sum.
const line = z.object({ itemId: oid, qty, unitPriceKobo: kobo });
const lines = z.array(line).min(1).max(50);
const entryBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sale'), lines, note, partyId: oid.optional(), paidKobo: kobo.optional() }),
  z.object({ type: z.literal('purchase'), lines, note, partyId: oid.optional(), paidKobo: kobo.optional() }),
  z.object({ type: z.literal('opening_stock'), lines, note }), // stock you already had; counts for stock and cost only
  z.object({ type: z.literal('expense'), totalKobo: kobo.min(1), note }),
  z.object({ type: z.literal('payment_in'), partyId: oid, totalKobo: kobo.min(1), note }),
  z.object({ type: z.literal('payment_out'), partyId: oid, totalKobo: kobo.min(1), note }),
]);

const idParam = z.object({ id: oid });
const listQuery = z.object({ q: z.string().max(100).optional(), cursor: oid.optional() });
const entryQuery = listQuery.extend({
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

async function softDelete(coll: Collection<any>, tenantId: string, id: string) {
  const r = await coll.updateOne(live(tenantId, { _id: new ObjectId(id) }), { $set: { deleted: true, deletedAt: new Date() } });
  if (!r.matchedCount) fail(404, 'not_found');
  return { id, deleted: true };
}

async function createEntry(tenantId: string, body: z.infer<typeof entryBody>) {
  const e: Document = { tenantId, type: body.type, note: body.note, deleted: false };
  let partyName = '', itemName = '';

  if ('partyId' in body && body.partyId) {
    const party = await parties().findOne(live(tenantId, { _id: new ObjectId(body.partyId) }));
    if (!party) fail(404, 'party_not_found');
    e.partyId = party._id;
    partyName = party.name;
  }

  if ('lines' in body) {
    const wanted = [...new Set(body.lines.map((l) => l.itemId))];
    const found = await items().find(live(tenantId, { _id: { $in: wanted.map((i) => new ObjectId(i)) } })).toArray();
    const byId = new Map(found.map((i) => [String(i._id), i]));
    if (wanted.some((i) => !byId.has(i))) fail(404, 'item_not_found');
    if (body.type === 'sale') { // what is wanted, per item, across all lines, must be on the shelf
      const want = new Map<string, number>();
      for (const l of body.lines) want.set(l.itemId, (want.get(l.itemId) ?? 0) + l.qty);
      const stock = await stockByItem(tenantId);
      for (const [id, q] of want) {
        const have = stock.get(id) ?? 0;
        if (round(q) > have) fail(409, 'insufficient_stock', `only ${have} ${byId.get(id)!.unit} of ${byId.get(id)!.name} in stock`);
      }
    }
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

  e.date = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    e.invoiceNo = 'INV-' + randomBytes(5).toString('hex').toUpperCase();
    e.search = words(e.invoiceNo, e.type, partyName, itemName, e.note);
    try {
      await entries().insertOne(e as any); // adds _id to e
      return view(e);
    } catch (err: any) {
      if (err.code !== 11000) throw err; // 11000 = invoice number already used, try another
    }
  }
  return fail(500, 'invoice_no_failed', 'could not allocate an invoice number');
}

// ---- routes -----------------------------------------------------------------
export function crudRoutes(app: FastifyInstance) {
  // parties (each returned with what they owe you / what you owe them)
  app.get('/api/parties', async (req) => {
    const { q, cursor } = listQuery.parse(req.query);
    const { docs, next } = await page(parties(), live(req.tenantId, {}, q), cursor);
    const { byParty } = await balances(req.tenantId);
    const none = { owesYouKobo: 0, youOweKobo: 0 };
    return { data: docs.map((d) => ({ ...view(d), ...(byParty.get(String(d._id)) ?? none) })), next };
  });
  app.post('/api/parties', async (req, reply) => {
    const b = partyBody.parse(req.body);
    const doc = { _id: new ObjectId(), tenantId: req.tenantId, ...b, search: words(b.name, b.phone), deleted: false, createdAt: new Date() };
    await parties().insertOne(doc);
    return reply.code(201).send(view(doc));
  });
  app.delete('/api/parties/:id', async (req) => softDelete(parties(), req.tenantId, idParam.parse(req.params).id));

  // items (each returned with computed stock)
  app.get('/api/items', async (req) => {
    const { q, cursor } = listQuery.parse(req.query);
    const { docs, next } = await page(items(), live(req.tenantId, {}, q), cursor);
    const stock = await stockByItem(req.tenantId);
    return { data: docs.map((d) => ({ ...view(d), stock: stock.get(String(d._id)) ?? 0 })), next };
  });
  app.post('/api/items', async (req, reply) => {
    const b = itemBody.parse(req.body);
    const doc = { _id: new ObjectId(), tenantId: req.tenantId, ...b, search: words(b.name), deleted: false, createdAt: new Date() };
    await items().insertOne(doc);
    return reply.code(201).send(view(doc));
  });
  app.delete('/api/items/:id', async (req) => softDelete(items(), req.tenantId, idParam.parse(req.params).id));

  // entries (the ledger)
  app.get('/api/entries', async (req) => {
    const { q, cursor, type, partyId, itemId, from, to } = entryQuery.parse(req.query);
    const filter: Document = {};
    if (type) filter.type = { $in: type };
    if (partyId) filter.partyId = new ObjectId(partyId);
    if (itemId) filter['lines.itemId'] = new ObjectId(itemId);
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
    const { docs, next } = await page(entries(), live(req.tenantId, filter, q), cursor);
    return { data: docs.map(view), next };
  });
  app.post('/api/entries', async (req, reply) => {
    const created = await createEntry(req.tenantId, entryBody.parse(req.body));
    return reply.code(201).send(created); // includes id and invoiceNo
  });
  app.delete('/api/entries/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await entries().findOne(live(req.tenantId, { _id: new ObjectId(id) }));
    if (!e) fail(404, 'not_found');
    // Removing stock that has already been sold would leave negative stock.
    if ((e.type === 'purchase' || e.type === 'opening_stock') && e.lines) {
      const stock = await stockByItem(req.tenantId);
      const taking = new Map<string, number>();
      for (const l of e.lines) taking.set(String(l.itemId), (taking.get(String(l.itemId)) ?? 0) + l.qty);
      for (const [itemId, q] of taking) if (round((stock.get(itemId) ?? 0) - q) < 0) fail(409, 'would_make_stock_negative', 'some of this stock has already been sold');
    }
    return softDelete(entries(), req.tenantId, id);
  });
}
