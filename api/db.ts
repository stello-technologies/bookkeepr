// Mongo connection, indexes, and the small helpers every other file shares.
import { MongoClient, ObjectId, type Collection, type Document } from 'mongodb';
import { z } from 'zod';

export const ENTRY_TYPES = ['sale', 'purchase', 'expense', 'payment_in', 'payment_out', 'opening_stock'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// Every record carries: who made it, which change number it has (`seq`), and, once deleted, who deleted it and why.
// Deleted records are kept forever (as tombstones) so every device and member can see them.
interface Base {
  _id: ObjectId; tenantId: string; search: string[];
  seq: number; createdBy: string; deviceId?: string; receivedAt: Date;
  deleted: boolean; deletedAt?: Date; deletedBy?: string; deletedReason?: string;
}
export interface Party extends Base { name: string; phone: string; createdAt: Date }
export interface Item extends Base { name: string; unit: string; priceKobo: number; createdAt: Date }
/** One product on an invoice. totalKobo = round(qty x unitPriceKobo). */
export interface EntryLine { itemId: ObjectId; qty: number; unitPriceKobo: number; totalKobo: number }
export interface Entry extends Base {
  date: Date; // the day the entry is for: today, or earlier when it is recorded in retrospect
  type: EntryType;
  invoiceNo: string;
  partyId?: ObjectId;
  lines?: EntryLine[]; // sale, purchase and opening_stock carry one or more lines
  totalKobo: number; // the sum of the lines (or the amount, for expenses and payments)
  paidKobo: number;
  note: string;
}
/** One business. Its id is the boss's login id, so records saved before accounts existed still belong to it. */
export interface Member { sub: string; role: 'boss' | 'staff'; name: string; removed?: boolean }
export interface Account { _id: string; name: string; members: Member[]; counter: number }
export interface Invite { _id: string; accountId: string; expiresAt: Date; usedBy?: string }

let client: MongoClient;
const db = () => client.db(); // database name comes from the connection string
export const parties = () => db().collection<Party>('parties');
export const items = () => db().collection<Item>('items');
export const entries = () => db().collection<Entry>('entries');
export const accounts = () => db().collection<Account>('accounts');
export const invites = () => db().collection<Invite>('invites');

export async function connect(uri: string) {
  client = new MongoClient(uri);
  await client.connect();
  await accounts().createIndex({ 'members.sub': 1 });
  await parties().createIndexes([{ key: { tenantId: 1, search: 1 } }, { key: { tenantId: 1, seq: 1 } }]);
  await items().createIndexes([{ key: { tenantId: 1, search: 1 } }, { key: { tenantId: 1, seq: 1 } }]);
  await migrateLegacyEntries();
  await entries().createIndexes([
    { key: { tenantId: 1, invoiceNo: 1 }, unique: true },
    { key: { tenantId: 1, date: -1 } },
    { key: { tenantId: 1, seq: 1 } },
    { key: { tenantId: 1, search: 1 } },
    { key: { tenantId: 1, partyId: 1 } },
    { key: { tenantId: 1, 'lines.itemId': 1 } },
    { key: { tenantId: 1, type: 1 } },
  ]);
  await backfillSeq();
}
export const close = () => client.close();

/** Create the business for this login if it has none yet (safe to call twice, even at the same moment). */
export async function ensureAccount(sub: string, bossName = 'Boss') {
  try {
    await accounts().updateOne({ _id: sub }, { $setOnInsert: { name: 'My business', members: [{ sub, role: 'boss', name: bossName }], counter: 0 } }, { upsert: true });
  } catch (err: any) { if (err.code !== 11000) throw err; } // someone else created it a moment ago: fine
}

/** The next change number for a business. Devices ask "what changed after number N?". */
export async function nextSeq(tenantId: string): Promise<number> {
  const a = await accounts().findOneAndUpdate({ _id: tenantId }, { $inc: { counter: 1 } }, { returnDocument: 'after' });
  if (!a) throw new Error(`no account for ${tenantId}`);
  return a.counter;
}

/**
 * Records saved before accounts and change numbers existed get a number, and their business as the maker.
 * Safe to run any number of times. Returns how many records it numbered.
 */
export async function backfillSeq(): Promise<number> {
  let n = 0;
  for (const coll of [parties(), items(), entries()] as Collection<any>[]) {
    const old = await coll.find({ seq: { $exists: false } }).sort({ _id: 1 }).toArray();
    for (const d of old) {
      await ensureAccount(d.tenantId);
      await coll.updateOne({ _id: d._id }, { $set: { seq: await nextSeq(d.tenantId), createdBy: d.tenantId, receivedAt: d.createdAt ?? d.date ?? new Date() } });
      n++;
    }
  }
  if (n) console.log(`Numbered ${n} older record${n === 1 ? '' : 's'} for syncing.`);
  return n;
}

/**
 * Entries saved before invoices had item lines kept ONE item on the entry itself (itemId, qty, unitPriceKobo).
 * Move that into `lines` so they show up, and count towards stock and profit, like every other invoice.
 * Safe to run any number of times. Returns how many entries it repaired.
 */
export async function migrateLegacyEntries(): Promise<number> {
  const old = (await entries().find({ itemId: { $exists: true }, lines: { $exists: false } } as Document).toArray()) as any[];
  for (const e of old) {
    await entries().updateOne({ _id: e._id }, {
      $set: { lines: [{ itemId: e.itemId, qty: e.qty, unitPriceKobo: e.unitPriceKobo, totalKobo: e.totalKobo }] },
      $unset: { itemId: '', qty: '', unitPriceKobo: '' },
    } as Document);
  }
  if (old.length) console.log(`Repaired ${old.length} older entr${old.length === 1 ? 'y' : 'ies'} (moved the item onto an item line).`);
  return old.length;
}

/** Throw an error the HTTP layer turns into { error, code } with this status. */
export function fail(status: number, code: string, message = code): never {
  throw Object.assign(new Error(message), { statusCode: status, code });
}

/** Lowercase searchable words: "Amaka Obi, INV-AB12" -> ["amaka","obi","inv","ab12"]. */
export function words(...parts: (string | undefined)[]): string[] {
  const all = parts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...new Set(all)];
}

/**
 * THE query helper for everyday reads and writes: scoped to one business, and never sees deleted records.
 * (Only sync and the deleted-records log look at deleted records, and they still filter by tenantId.)
 * `q` = typed search text; each typed word must be the start of a stored word
 * (an index range scan, not a regex).
 */
export function live(tenantId: string, extra: Document = {}, q?: string): Document {
  const filter: Document = { ...extra, tenantId, deleted: { $ne: true } };
  const typed = q ? words(q) : [];
  if (typed.length) filter.$and = typed.map((w) => ({ search: { $elemMatch: { $gte: w, $lt: w + '\uffff' } } }));
  return filter;
}

/** Shape of a record in API responses: id instead of _id, no internal search words. Deleted ones say so. */
export function view(doc: Document) {
  const { _id, tenantId, search, deleted, ...rest } = doc;
  return { id: String(_id), ...rest, ...(deleted ? { deleted: true } : {}) };
}

export const oid = z.string().regex(/^[a-f0-9]{24}$/i, 'invalid id');
