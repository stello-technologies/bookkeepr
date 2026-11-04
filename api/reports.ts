// Every number comes from entries, computed on request. Nothing is cached.
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Document } from 'mongodb';
import { z } from 'zod';
import { entries, items, parties, live, fail, oid, view } from './db';
import type { Role } from './accounts';

const DAY = 86_400_000;
export const round = (n: number) => Math.round(n * 1e6) / 1e6; // tidy float quantities

/**
 * What one entry does to a party's balances: [customer owes you, you owe supplier].
 *   customer owes you = sum sale (total - paid) - sum payment_in
 *   you owe supplier  = sum purchase (total - paid) - sum payment_out
 * Works on single entries and on sums of entries of the same type.
 */
function effect(type: string, total: number, paid: number): [number, number] {
  switch (type) {
    case 'sale': return [total - paid, 0];
    case 'payment_in': return [-total, 0];
    case 'purchase': return [0, total - paid];
    case 'payment_out': return [0, -total];
    default: return [0, 0];
  }
}

// Stock moves: opening_stock and purchase bring stock in, sale takes it out.
const STOCK_TYPES = ['opening_stock', 'purchase', 'sale'];

/** Quantity in / out per item id, for entries matching `dates` (e.g. { date: { $lt: x } }). */
async function moves(tenantId: string, dates: Document = {}, itemId?: ObjectId) {
  // Filter by type BEFORE unwinding the lines, then total each item's quantity.
  const total = async (types: string[]) => {
    const rows = await entries().aggregate([
      { $match: live(tenantId, { type: { $in: types }, ...(itemId ? { 'lines.itemId': itemId } : {}), ...dates }) },
      { $unwind: '$lines' }, // one row per product line
      ...(itemId ? [{ $match: { 'lines.itemId': itemId } }] : []),
      { $group: { _id: '$lines.itemId', qty: { $sum: '$lines.qty' } } },
    ]).toArray();
    return new Map<string, number>(rows.map((r) => [String(r._id), r.qty]));
  };
  const [bringIn, takeOut] = await Promise.all([total(['opening_stock', 'purchase']), total(['sale'])]);
  const byItem = new Map<string, { in: number; out: number }>();
  for (const [id, qty] of bringIn) byItem.set(id, { in: qty, out: 0 });
  for (const [id, qty] of takeOut) byItem.set(id, { in: byItem.get(id)?.in ?? 0, out: qty });
  return byItem;
}

/** Stock on hand per item id = opening stock + purchases - sales (all items, or just one). */
export async function stockByItem(tenantId: string, itemId?: ObjectId) {
  const byItem = await moves(tenantId, {}, itemId);
  return new Map<string, number>([...byItem].map(([id, m]) => [id, round(m.in - m.out)]));
}

/** All-time balances: per party, and the grand totals (including sales with no party). */
export async function balances(tenantId: string) {
  const rows = await entries().aggregate([
    { $match: live(tenantId, { type: { $in: ['sale', 'payment_in', 'purchase', 'payment_out'] } }) },
    { $group: { _id: { party: '$partyId', type: '$type' }, total: { $sum: '$totalKobo' }, paid: { $sum: '$paidKobo' } } },
  ]).toArray();
  const all = { owesYouKobo: 0, youOweKobo: 0 };
  const byParty = new Map<string, { owesYouKobo: number; youOweKobo: number }>();
  for (const r of rows) {
    const [owes, owed] = effect(r._id.type, r.total, r.paid);
    all.owesYouKobo += owes;
    all.youOweKobo += owed;
    if (!r._id.party) continue;
    const b = byParty.get(String(r._id.party)) ?? { owesYouKobo: 0, youOweKobo: 0 };
    b.owesYouKobo += owes;
    b.youOweKobo += owed;
    byParty.set(String(r._id.party), b);
  }
  return { all, byParty };
}

const WINDOWS = { day: 1, week: 7, month: 30 }; // rolling: the last 24h / 7d / 30d

/**
 * Profit = sales - cost of goods sold - expenses.
 * Cost of goods sold = qty sold x average cost of that item
 * (average cost = all purchases + opening stock cost / their qty).
 */
async function summary(tenantId: string, win: keyof typeof WINDOWS, role: Role) {
  const from = new Date(Date.now() - WINDOWS[win] * DAY);
  const inWindow = { date: { $gte: from } };

  const totals = await entries().aggregate([
    { $match: live(tenantId, inWindow) },
    { $group: { _id: '$type', total: { $sum: '$totalKobo' } } },
  ]).toArray();
  const sum = (type: string) => totals.find((t) => t._id === type)?.total ?? 0;

  const sold = await entries().aggregate([
    { $match: live(tenantId, { type: 'sale', ...inWindow }) },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.itemId', qty: { $sum: '$lines.qty' } } },
  ]).toArray();
  const bought = await entries().aggregate([
    { $match: live(tenantId, { type: { $in: ['purchase', 'opening_stock'] } }) },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.itemId', cost: { $sum: '$lines.totalKobo' }, qty: { $sum: '$lines.qty' } } },
  ]).toArray();
  const avgCost = new Map(bought.map((b) => [String(b._id), b.qty ? b.cost / b.qty : 0]));
  const cogs = Math.round(sold.reduce((s, r) => s + r.qty * (avgCost.get(String(r._id)) ?? 0), 0));

  const { all } = await balances(tenantId);
  const sales = sum('sale');
  const expenses = sum('expense');
  const out = {
    window: win, from, to: new Date(),
    salesKobo: sales,
    purchasesKobo: sum('purchase'),
    expensesKobo: expenses,
    cogsKobo: cogs,
    profitKobo: sales - cogs - expenses,
    owedToYouKobo: all.owesYouKobo, // all-time, not just this window
    youOweKobo: all.youOweKobo,
  };
  // Only the boss sees profit. Staff get everything else.
  if (role !== 'boss') { delete (out as Partial<typeof out>).cogsKobo; delete (out as Partial<typeof out>).profitKobo; }
  return out;
}

const statementQuery = z.object({
  kind: z.enum(['sales', 'stock', 'party']),
  from: z.coerce.date(), // inclusive
  to: z.coerce.date(), // exclusive
  partyId: oid.optional(),
  itemId: oid.optional(),
});

async function statement(tenantId: string, q: z.infer<typeof statementQuery>) {
  const { kind, from, to } = q;
  if (!(from < to)) fail(400, 'bad_range', 'from must be before to');
  if (to.getTime() - from.getTime() > 30 * DAY) fail(400, 'range_too_long', 'a statement covers at most 30 days');

  // One row per day (Lagos time) of sales. At most 30 days of sales, so grouping here is cheap.
  if (kind === 'sales') {
    const sales = await entries().find(live(tenantId, { type: 'sale', date: { $gte: from, $lt: to } }))
      .project({ date: 1, totalKobo: 1, paidKobo: 1 }).sort({ date: 1, _id: 1 }).toArray();
    const days = new Map<string, { day: string; count: number; totalKobo: number; paidKobo: number; outstandingKobo: number }>();
    for (const s of sales) {
      const day = s.date.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
      const d = days.get(day) ?? { day, count: 0, totalKobo: 0, paidKobo: 0, outstandingKobo: 0 };
      d.count += 1;
      d.totalKobo += s.totalKobo;
      d.paidKobo += s.paidKobo;
      d.outstandingKobo += s.totalKobo - s.paidKobo;
      days.set(day, d);
    }
    return { kind, from, to, rows: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)) };
  }

  // Per item: stock before the period, what came in, what went out, what is left.
  if (kind === 'stock') {
    const itemId = q.itemId ? new ObjectId(q.itemId) : undefined;
    const list = await items().find(live(tenantId, itemId ? { _id: itemId } : {})).sort({ name: 1 }).toArray();
    const before = await moves(tenantId, { date: { $lt: from } }, itemId);
    const during = await moves(tenantId, { date: { $gte: from, $lt: to } }, itemId);
    return {
      kind, from, to, rows: list.map((it) => {
        const id = String(it._id);
        const b = before.get(id) ?? { in: 0, out: 0 };
        const d = during.get(id) ?? { in: 0, out: 0 };
        const opening = round(b.in - b.out);
        return { itemId: id, name: it.name, unit: it.unit, opening, in: round(d.in), out: round(d.out), closing: round(opening + d.in - d.out) };
      })
    };
  }

  // Party: entries in the period, balance brought forward, running balance.
  if (!q.partyId) fail(400, 'party_required', 'partyId is required for a party statement');
  const party = await parties().findOne(live(tenantId, { _id: new ObjectId(q.partyId) }));
  if (!party) fail(404, 'party_not_found');
  const history = await entries().find(live(tenantId, { partyId: party._id, date: { $lt: to } })).sort({ date: 1, _id: 1 }).toArray();
  let owes = 0, owed = 0;
  let broughtForward = { owesYouKobo: 0, youOweKobo: 0 };
  const rows = [];
  for (const e of history) {
    const [o, w] = effect(e.type, e.totalKobo, e.paidKobo);
    owes += o;
    owed += w;
    if (e.date < from) broughtForward = { owesYouKobo: owes, youOweKobo: owed };
    else rows.push({ ...view(e), owesYouKobo: owes, youOweKobo: owed });
  }
  return { kind, party: { id: String(party._id), name: party.name }, from, to, broughtForward, rows, closing: { owesYouKobo: owes, youOweKobo: owed } };
}

export function reportRoutes(app: FastifyInstance) {
  app.get('/api/summary', async (req) => {
    const { window: win } = z.object({ window: z.enum(['day', 'week', 'month']).default('month') }).parse(req.query);
    return summary(req.tenantId, win, req.role);
  });
  app.get('/api/statements', async (req) => statement(req.tenantId, statementQuery.parse(req.query)));
}
