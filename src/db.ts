// Mongo connection, indexes, and the small helpers every other file shares.
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { z } from 'zod';

export const ENTRY_TYPES = ['sale', 'purchase', 'expense', 'payment_in', 'payment_out', 'opening_stock'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

interface Base { _id: ObjectId; tenantId: string; search: string[]; deleted: boolean; deletedAt?: Date }
export interface Party extends Base { name: string; phone: string; createdAt: Date }
export interface Item extends Base { name: string; unit: string; priceKobo: number; createdAt: Date }
export interface Entry extends Base {
  date: Date; // set by the server when the entry is saved
  type: EntryType;
  invoiceNo: string;
  partyId?: ObjectId;
  itemId?: ObjectId;
  qty?: number;
  unitPriceKobo?: number;
  totalKobo: number;
  paidKobo: number;
  note: string;
}

let client: MongoClient;
const db = () => client.db(); // database name comes from the connection string
export const parties = () => db().collection<Party>('parties');
export const items = () => db().collection<Item>('items');
export const entries = () => db().collection<Entry>('entries');

export async function connect(uri: string) {
  client = new MongoClient(uri);
  await client.connect();
  await parties().createIndex({ tenantId: 1, search: 1 });
  await items().createIndex({ tenantId: 1, search: 1 });
  await entries().createIndexes([
    { key: { tenantId: 1, invoiceNo: 1 }, unique: true },
    { key: { tenantId: 1, date: -1 } },
    { key: { tenantId: 1, search: 1 } },
    { key: { tenantId: 1, partyId: 1 } },
    { key: { tenantId: 1, itemId: 1 } },
    { key: { tenantId: 1, type: 1 } },
  ]);
}
export const close = () => client.close();

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
 * THE query helper. Every read and write filter goes through here, so every query
 * is scoped to one tenant and never sees deleted records.
 * `q` = typed search text; each typed word must be the start of a stored word
 * (an index range scan, not a regex).
 */
export function live(tenantId: string, extra: Document = {}, q?: string): Document {
  const filter: Document = { ...extra, tenantId, deleted: { $ne: true } };
  const typed = q ? words(q) : [];
  if (typed.length) filter.$and = typed.map((w) => ({ search: { $elemMatch: { $gte: w, $lt: w + '\uffff' } } }));
  return filter;
}

/** Shape of a record in API responses: id instead of _id, no internal fields. */
export function view(doc: Document) {
  const { _id, tenantId, search, deleted, deletedAt, ...rest } = doc;
  return { id: String(_id), ...rest };
}

export const oid = z.string().regex(/^[a-f0-9]{24}$/i, 'invalid id');
