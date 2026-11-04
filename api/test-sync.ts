// Sync, roles and members: the rules that must never break.   Run with: npm test   (needs TEST_MONGODB_URI)
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import { buildApp } from './server';
import { connect, close, accounts, invites, parties, items, entries as entryCollection, backfillSeq } from './db';

const uri = process.env.TEST_MONGODB_URI;
if (!uri) throw new Error('Set TEST_MONGODB_URI (a throwaway database) to run the tests');
process.env.AUTH0_DOMAIN = 'test.example.com';
process.env.AUTH0_AUDIENCE = 'bookkeeper-test';
process.env.AUTH0_CLIENT_ID = 'test-client';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const keys = await generateKeyPair('RS256');
const app = buildApp(async () => keys.publicKey);
before(() => connect(uri));
after(async () => { await app.close(); await close(); });

// ---- helpers: every test uses brand-new logins, so tests never collide ------------
const login = () => `auth0|${randomUUID()}`;
const id = () => new ObjectId().toHexString();
const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const sign = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub)
  .setIssuer('https://test.example.com/').setAudience('bookkeeper-test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);

async function call(sub: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${await sign(sub)}` } });
  return { status: res.statusCode, body: res.json() as any };
}
async function ok(sub: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const r = await call(sub, method, url, payload);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** One sync call, the way a phone makes it. */
const sync = (sub: string, device: string, push: object = {}, cursor = 0) => ok(sub, 'POST', '/api/sync', { deviceId: device, cursor, push });
const A = 'device-aaaaaaaa', B = 'device-bbbbbbbb';
const L = (itemId: string, qty: number, unitPriceKobo: number) => [{ itemId, qty, unitPriceKobo }];
const rice = () => ({ id: id(), name: 'Rice', unit: 'kg', priceKobo: 100_000 });
const expense = (extra: object = {}) => ({ id: id(), type: 'expense', totalKobo: 500, ...extra });

async function staffOf(boss: string) {
  const staff = login();
  const { code } = await ok(boss, 'POST', '/api/invites');
  await ok(staff, 'POST', '/api/invites/accept', { code, name: 'Staff' });
  return staff;
}

// ---- merging ------------------------------------------------------------------
test('sync is safe to repeat: the same record sent twice, or from two devices, exists once', async () => {
  const t = login(), item = rice(), stockIn = { id: id(), type: 'opening_stock', lines: L(item.id, 10, 50) };
  const sale = { id: id(), type: 'sale', invoiceNo: 'INV-0123456789', lines: L(item.id, 4, 700) };
  const push = { items: [item], entries: [stockIn, sale] };
  await sync(t, A, push);
  await sync(t, A, push); // a retry after a bad network
  await sync(t, B, push); // another phone that recorded the same thing
  const entries = (await ok(t, 'GET', '/api/entries')).data;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e: any) => e.type === 'sale').invoiceNo, 'INV-0123456789', 'the phone\'s own invoice number is kept');
  assert.equal((await ok(t, 'GET', '/api/items')).data[0].stock, 6, 'stock counted once');
  assert.equal((await ok(t, 'GET', '/api/summary?window=day')).salesKobo, 2800, 'the sale counted once');
});

test('a delete on one device reaches the other with its content, who and why; the first delete wins', async () => {
  const t = login(), item = rice(), sale = { id: id(), type: 'sale', note: 'bag of rice', lines: L(item.id, 2, 700) };
  const first = await sync(t, A, { items: [item], entries: [sale] });
  const cursor = first.cursor;
  await sync(t, A, { deletes: [{ kind: 'entries', id: sale.id, reason: 'wrong price' }] });
  await sync(t, B, { deletes: [{ kind: 'entries', id: sale.id, reason: 'something else' }] }); // second delete changes nothing
  const next = await sync(t, B, {}, cursor);
  const gone = next.changes.entries.find((e: any) => e.id === sale.id);
  assert.equal(gone.deleted, true);
  assert.equal(gone.deletedBy, t);
  assert.equal(gone.deletedReason, 'wrong price');
  assert.equal(gone.lines.length, 1, 'the deleted record keeps its content, so the log can show what was removed');
  assert.equal((await ok(t, 'GET', '/api/summary?window=day')).salesKobo, 0, 'deleted entries are in no total');
  assert.equal((await ok(t, 'GET', '/api/entries')).data.length, 0);
});

test('a change that commits late is still delivered (change numbers can arrive out of order)', async () => {
  const t = login();
  const seen = await sync(t, A, { entries: [expense(), expense(), expense()] });
  const late = { _id: new ObjectId(), tenantId: t, type: 'expense', note: '', totalKobo: 900, paidKobo: 900, date: new Date(), deleted: false, search: [], invoiceNo: 'INV-AAAAAAAAAA', createdBy: t, receivedAt: new Date(), seq: seen.cursor - 1 };
  await entryCollection().insertOne(late as any); // number reserved before the others, saved after them
  const next = await sync(t, A, {}, seen.cursor);
  assert.ok(next.changes.entries.some((e: any) => e.id === String(late._id)), 'the late record is delivered');
  assert.ok(next.cursor >= seen.cursor, 'the cursor never goes backwards');
});

test('more than a page is delivered completely, and the cursor only moves forward', async () => {
  const t = login();
  const batch = () => Array.from({ length: 300 }, (_, i) => ({ id: id(), name: `Person ${i}` }));
  await sync(t, A, { parties: batch() });
  await sync(t, A, { parties: batch() });
  const got = new Set<string>();
  let cursor = 0, more = true, rounds = 0;
  while (more && rounds++ < 10) {
    const r = await sync(t, B, {}, cursor);
    assert.ok(r.cursor >= cursor);
    r.changes.parties.forEach((p: any) => got.add(p.id));
    cursor = r.cursor; more = r.more;
  }
  assert.equal(got.size, 600);
});

// ---- entries ---------------------------------------------------------------------
test('retrospective entries: dated in the past, listed by date, counted in their own period; a future date is refused without blocking the rest', async () => {
  const t = login(), item = rice();
  const today = id(), old = id(); // the old entry gets the LARGER id, so only a date sort puts it second
  const r = await sync(t, A, { items: [item], entries: [
    { id: today, type: 'sale', lines: L(item.id, 1, 1000) },
    { id: old, type: 'sale', date: ago(40), lines: L(item.id, 1, 3000) },
    expense({ date: new Date(Date.now() + 2 * day).toISOString() }), // tomorrow+: not allowed
  ] });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].code, 'validation');
  assert.equal(r.applied, 3, 'the item and both good sales were saved');
  assert.deepEqual((await ok(t, 'GET', '/api/entries')).data.map((e: any) => e.id), [today, old]);
  assert.equal((await ok(t, 'GET', '/api/summary?window=month')).salesKobo, 1000, 'the old sale is outside the last 30 days');
  const st = await ok(t, 'GET', `/api/statements?kind=sales&from=${ago(41)}&to=${ago(39)}`);
  assert.deepEqual(st.rows.map((x: any) => x.totalKobo), [3000], 'but it is in the statement for its own days');
});

test('a sale is never refused: no stock, or an item another device has since removed', async () => {
  const t = login(), item = rice();
  await sync(t, A, { items: [item] });
  await ok(t, 'DELETE', `/api/items/${item.id}`); // removed on another device
  const r = await sync(t, A, { entries: [{ id: id(), type: 'sale', lines: L(item.id, 5, 100) }] }); // recorded earlier, offline
  assert.deepEqual(r.rejected, []);
  assert.equal((await ok(t, 'GET', '/api/summary?window=day')).salesKobo, 500, 'the money still counts');
  const open = await ok(t, 'POST', '/api/items', { name: 'Oil', unit: 'l', priceKobo: 100 });
  await ok(t, 'POST', '/api/entries', { type: 'sale', lines: L(open.id, 3, 100) }); // nothing in stock at all
  assert.equal((await ok(t, 'GET', '/api/items')).data[0].stock, -3, 'short stock shows as negative');
});

test('invoice numbers: two entries claiming the same number both save, with different numbers', async () => {
  const t = login(), same = 'INV-ABCDEF0123';
  const r = await sync(t, A, { entries: [expense({ invoiceNo: same }), expense({ invoiceNo: same })] });
  assert.deepEqual(r.rejected, []);
  const nos = (await ok(t, 'GET', '/api/entries')).data.map((e: any) => e.invoiceNo);
  assert.equal(new Set(nos).size, 2);
  assert.ok(nos.includes(same));
});

test('a device cannot take another business\'s id or forge who made a record', async () => {
  const x = login(), y = login(), pid = id();
  await sync(x, A, { parties: [{ id: pid, name: 'Amaka' }] });
  const r = await sync(y, A, { parties: [{ id: pid, name: 'Hijacked' }] });
  assert.deepEqual(r.rejected, [{ id: pid, code: 'id_taken' }]);
  assert.equal(r.changes.parties.length, 0, 'the other business\'s data never appears');
  assert.equal((await ok(x, 'GET', '/api/parties')).data[0].name, 'Amaka', 'and was not changed');

  const forged = id();
  const out = await sync(y, A, { parties: [{ id: forged, name: 'Bola', createdBy: 'someone-else', deletedBy: 'someone-else', seq: 1 }] });
  const mine = out.changes.parties.find((p: any) => p.id === forged);
  assert.equal(mine.createdBy, y, 'the maker comes from the token');
  assert.equal(mine.deletedBy, undefined);
});

test('a sync call is limited in size, and needs a device id', async () => {
  const t = login();
  const tooMany = await call(t, 'POST', '/api/sync', { deviceId: A, push: { parties: Array.from({ length: 501 }, () => ({ id: id(), name: 'x' })) } });
  assert.equal(tooMany.status, 400);
  assert.equal((await call(t, 'POST', '/api/sync', { push: {} })).status, 400);
});

// ---- roles ---------------------------------------------------------------------
test('staff can record everything, but never see profit', async () => {
  const boss = login(), staff = await staffOf(boss);
  const item = await ok(staff, 'POST', '/api/items', { name: 'Rice', unit: 'kg', priceKobo: 1000 });
  const supplier = await ok(staff, 'POST', '/api/parties', { name: 'Supplier' });
  const post = (b: object) => ok(staff, 'POST', '/api/entries', b);
  await post({ type: 'opening_stock', lines: L(item.id, 10, 400) });
  await post({ type: 'purchase', partyId: supplier.id, lines: L(item.id, 10, 400) });
  await post({ type: 'expense', totalKobo: 500 });
  await post({ type: 'payment_out', partyId: supplier.id, totalKobo: 100 });
  await post({ type: 'sale', lines: L(item.id, 2, 1000) });

  const s = await ok(staff, 'GET', '/api/summary?window=day');
  assert.equal(s.salesKobo, 2000);
  assert.equal(s.expensesKobo, 500);
  assert.ok(!('profitKobo' in s) && !('cogsKobo' in s), 'staff get no profit and no cost of goods');
  const b = await ok(boss, 'GET', '/api/summary?window=day');
  assert.equal(b.profitKobo, 2000 - 2 * 400 - 500, 'the boss sees the same books, with profit');
  assert.equal((await ok(boss, 'GET', '/api/entries')).data.length, 5, 'one shared set of books');
});

test('staff delete only their own entries; only the boss removes people and items, invites, renames or revokes', async () => {
  const boss = login(), staff = await staffOf(boss);
  const bossEntry = await ok(boss, 'POST', '/api/entries', { type: 'expense', totalKobo: 100 });
  const mine = await ok(staff, 'POST', '/api/entries', { type: 'expense', totalKobo: 200 });
  const person = await ok(boss, 'POST', '/api/parties', { name: 'Ada' });
  const thing = await ok(boss, 'POST', '/api/items', { name: 'Oil', unit: 'l', priceKobo: 1 });

  const refused = await call(staff, 'DELETE', `/api/entries/${bossEntry.id}`);
  assert.deepEqual([refused.status, refused.body.code], [403, 'not_allowed']);
  const viaSync = await sync(staff, A, { deletes: [{ kind: 'entries', id: bossEntry.id }, { kind: 'entries', id: mine.id }] });
  assert.deepEqual(viaSync.rejected, [{ id: bossEntry.id, code: 'not_allowed' }], 'the same rule over sync, and the rest of the batch still applies');
  assert.equal((await ok(boss, 'GET', '/api/entries')).data.length, 1, 'the boss\'s entry is still there, the staff member\'s own is gone');

  for (const [method, url, body] of [
    ['DELETE', `/api/parties/${person.id}`], ['DELETE', `/api/items/${thing.id}`],
    ['POST', '/api/invites', {}], ['POST', '/api/account', { name: 'Mine now' }], ['DELETE', `/api/members/${encodeURIComponent(boss)}`],
  ] as const) {
    assert.equal((await call(staff, method, url, body)).status, 403, `${method} ${url}`);
  }
  assert.equal((await ok(boss, 'POST', '/api/account', { name: 'Mama Put' })).name, 'Mama Put');
  assert.equal((await ok(staff, 'GET', '/api/me')).name, 'Mama Put', 'staff see the business name, not their own');
  const forged = await sync(staff, A, { parties: [{ id: id(), name: 'x', role: 'boss' }] });
  assert.equal(forged.role, 'staff', 'a device cannot claim a role');
});

// ---- members -------------------------------------------------------------------
test('invites are single-use and expire; a login that already has books cannot join', async () => {
  const boss = login();
  const { code } = await ok(boss, 'POST', '/api/invites');
  const first = login(), second = login();
  await ok(first, 'POST', '/api/invites/accept', { code });
  assert.equal((await call(second, 'POST', '/api/invites/accept', { code })).body.code, 'invite_invalid', 'used once');

  const stale = `expired-${randomUUID()}`;
  await invites().insertOne({ _id: stale, accountId: boss, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await call(second, 'POST', '/api/invites/accept', { code: stale })).body.code, 'invite_invalid', 'expired');

  const busy = login();
  await ok(busy, 'POST', '/api/parties', { name: 'My own customer' });
  const fresh = (await ok(boss, 'POST', '/api/invites')).code;
  assert.equal((await call(busy, 'POST', '/api/invites/accept', { code: fresh })).body.code, 'account_in_use', 'their books are never swallowed');
  assert.equal((await ok(first, 'GET', '/api/me')).accountId, boss, 'the staff member works inside the boss\'s business');
});

test('a business has at most 256 members, and a refused join does not use up the invite', async () => {
  const boss = login(), { code } = await ok(boss, 'POST', '/api/invites');
  const members = (n: number) => Array.from({ length: n }, (_, i) => ({ sub: i ? `filler-${i}-${boss}` : boss, role: i ? ('staff' as const) : ('boss' as const), name: 'x' }));
  await accounts().updateOne({ _id: boss }, { $set: { members: members(256) } });
  const newcomer = login();
  const full = await call(newcomer, 'POST', '/api/invites/accept', { code });
  assert.deepEqual([full.status, full.body.code], [409, 'member_limit']);
  await accounts().updateOne({ _id: boss }, { $set: { members: members(255) } });
  await ok(newcomer, 'POST', '/api/invites/accept', { code }); // same code still works
  assert.equal((await ok(boss, 'GET', '/api/me')).members.length, 256);
});

test('a removed member is refused on their next call, keeps their name in history, and the boss cannot be removed', async () => {
  const boss = login(), staff = await staffOf(boss);
  const entry = await ok(staff, 'POST', '/api/entries', { type: 'expense', totalKobo: 100 });
  await ok(boss, 'DELETE', `/api/members/${encodeURIComponent(staff)}`);
  const refused = await call(staff, 'GET', '/api/entries');
  assert.deepEqual([refused.status, refused.body.code], [403, 'revoked']);
  assert.equal((await call(staff, 'POST', '/api/sync', { deviceId: A })).body.code, 'revoked');
  const me = await ok(boss, 'GET', '/api/me');
  assert.deepEqual(me.members.find((m: any) => m.id === staff), { id: staff, name: 'Staff', role: 'staff', removed: true });
  assert.equal((await ok(boss, 'GET', '/api/entries')).data[0].createdBy, staff, 'what they recorded stays, with their name');
  assert.equal((await call(boss, 'DELETE', `/api/members/${encodeURIComponent(boss)}`)).body.code, 'cannot_remove_boss');
  assert.ok(entry.id);
});

// ---- existing data -------------------------------------------------------------
test('records saved before accounts existed are numbered once, belong to their owner, and sync', async () => {
  const t = login();
  const doc = (extra: object) => ({ _id: new ObjectId(), tenantId: t, search: ['old'], deleted: false, createdAt: new Date(), ...extra });
  const [p, i] = [doc({ name: 'Old customer', phone: '' }), doc({ name: 'Old item', unit: 'kg', priceKobo: 1 })];
  await parties().insertOne(p as any);
  await items().insertOne(i as any);
  assert.ok((await backfillSeq()) >= 2);
  const seqs = async () => (await sync(t, A)).changes;
  const before = await seqs();
  await backfillSeq(); // running it again changes nothing
  assert.deepEqual(await seqs(), before);
  assert.deepEqual([before.parties.length, before.items.length], [1, 1]);
  assert.equal(before.parties[0].createdBy, t);
  const me = await ok(t, 'GET', '/api/me');
  assert.deepEqual([me.role, me.accountId], ['boss', t], 'the old business is now an account owned by its login');
});
