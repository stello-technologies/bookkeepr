// Run with: npm test   (needs TEST_MONGODB_URI pointing at a throwaway database)
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { buildApp } from './server';
import { ObjectId } from 'mongodb';
import { connect, close, entries, migrateLegacyEntries } from './db';

const uri = process.env.TEST_MONGODB_URI;
if (!uri) throw new Error('Set TEST_MONGODB_URI (a throwaway database) to run the tests');
process.env.AUTH0_DOMAIN = 'test.example.com';
process.env.AUTH0_AUDIENCE = 'bookkeeper-test';
process.env.AUTH0_CLIENT_ID = 'test-client';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const keys = await generateKeyPair('RS256');
const strangerKeys = await generateKeyPair('RS256');
const app = buildApp(async () => keys.publicKey);

before(() => connect(uri));
after(async () => { await app.close(); await close(); });

// ---- helpers: every test uses a brand-new tenant, so tests never collide ----------
const tenant = () => `auth0|${randomUUID()}`;
const sign = (sub: string, o: { key?: typeof keys.privateKey; aud?: string } = {}) =>
  new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub)
    .setIssuer('https://test.example.com/').setAudience(o.aud ?? 'bookkeeper-test')
    .setIssuedAt().setExpirationTime('1h').sign(o.key ?? keys.privateKey);

async function api(t: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${await sign(t)}` } });
  return { status: res.statusCode, body: res.json() as any };
}
async function ok(t: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const r = await api(t, method, url, payload);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** One product line for an invoice. */
const L = (itemId: string, qty: number, unitPriceKobo: number) => [{ itemId, qty, unitPriceKobo }];
const range = () => `from=${new Date(Date.now() - 3600e3).toISOString()}&to=${new Date(Date.now() + 60e3).toISOString()}`;
const rice = (t: string) => ok(t, 'POST', '/api/items', { name: 'Rice', unit: 'kg', priceKobo: 100_000 });
const person = (t: string, name: string) => ok(t, 'POST', '/api/parties', { name });

// ---- auth -----------------------------------------------------------------------
test('auth: /api needs a valid token, /health does not', async () => {
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/parties' })).statusCode, 401);
  for (const token of [
    await sign('x', { key: strangerKeys.privateKey }), // signed by someone else
    await sign('x', { aud: 'another-api' }), // meant for another API
    'garbage',
  ]) {
    const r = await app.inject({ url: '/api/parties', headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, 'unauthorized');
  }
});

// ---- rule 1 ---------------------------------------------------------------------
test('rule 1: one tenant can never read or write another tenant\'s data', async () => {
  const a = tenant(), b = tenant();
  const party = await ok(a, 'POST', '/api/parties', { name: 'Amaka', tenantId: b }); // tenantId in body is ignored
  const item = await rice(a);
  await ok(a, 'POST', '/api/entries', { type: 'opening_stock', lines: L(item.id, 5, 100) });

  for (const path of ['parties', 'items', 'entries']) assert.equal((await ok(b, 'GET', `/api/${path}`)).data.length, 0);
  assert.equal((await api(b, 'DELETE', `/api/parties/${party.id}`)).status, 404);
  assert.equal((await api(b, 'DELETE', `/api/items/${item.id}`)).status, 404);
  assert.equal((await api(b, 'POST', '/api/entries', { type: 'sale', lines: L(item.id, 1, 100) })).status, 404);
  assert.equal((await api(b, 'POST', '/api/entries', { type: 'payment_in', partyId: party.id, totalKobo: 100 })).status, 404);
  assert.equal((await api(b, 'GET', `/api/statements?kind=party&partyId=${party.id}&${range()}`)).status, 404);
  assert.equal((await ok(b, 'GET', '/api/summary')).salesKobo, 0);

  assert.equal((await ok(a, 'GET', '/api/parties')).data.length, 1); // still there for its owner
  assert.equal((await ok(a, 'GET', '/api/entries')).data.length, 1);
});

// ---- rule 2 ---------------------------------------------------------------------
test('rule 2: money is whole kobo, never negative, paid cannot exceed total', async () => {
  const t = tenant();
  const item = await rice(t);
  const person1 = await person(t, 'Ada');
  const sale = (over: object = {}) => ({ type: 'sale', lines: L(item.id, 1, 1000), ...over });
  await ok(t, 'POST', '/api/entries', { type: 'opening_stock', lines: L(item.id, 100, 10) });

  const bad: object[] = [
    sale({ lines: L(item.id, 1, -1) }), // negative
    sale({ lines: L(item.id, 1, 10.5) }), // not whole kobo
    sale({ lines: L(item.id, 0, 1000) }), sale({ lines: [] }), // nothing sold
    sale({ lines: L(item.id, -2, 1000) }),
    sale({ paidKobo: 1001 }), // paid more than total
    sale({ paidKobo: -5 }),
    { type: 'expense', totalKobo: 0 },
    { type: 'expense', totalKobo: 12.5 },
    { type: 'payment_in', totalKobo: 500 }, // payments need a person
    { type: 'payment_out', partyId: person1.id, totalKobo: -500 },
    { type: 'refund', totalKobo: 500 }, // unknown type
  ];
  for (const body of bad) assert.equal((await api(t, 'POST', '/api/entries', body)).status, 400, JSON.stringify(body));

  const full = await ok(t, 'POST', '/api/entries', sale());
  assert.equal(full.paidKobo, 1000, 'paid defaults to the total');
  const part = await ok(t, 'POST', '/api/entries', sale({ paidKobo: 0, partyId: person1.id }));
  assert.equal(part.paidKobo, 0);

  // Fractional quantity: the server works out the total (2.5 x 1333 = 3332.5 -> 3333) and ignores a client total.
  const frac = await ok(t, 'POST', '/api/entries', sale({ lines: L(item.id, 2.5, 1333), totalKobo: 1 }));
  assert.equal(frac.totalKobo, 3333);
  assert.ok(Number.isInteger(frac.totalKobo));
  assert.match(frac.invoiceNo, /^INV-[0-9A-F]{10}$/);
});

// ---- rule 3 ---------------------------------------------------------------------
test('rule 3: customer and supplier balances match the formulas', async () => {
  const t = tenant();
  const item = await rice(t);
  const supplier = await person(t, 'Mama Put Supplies');
  const customer = await person(t, 'Amaka Obi');
  const post = (b: object) => ok(t, 'POST', '/api/entries', b);

  await post({ type: 'purchase', partyId: supplier.id, lines: L(item.id, 100, 500), paidKobo: 20_000 }); // owe 30,000
  await post({ type: 'payment_out', partyId: supplier.id, totalKobo: 5_000 }); // owe 25,000
  await post({ type: 'sale', partyId: customer.id, lines: L(item.id, 10, 1000), paidKobo: 4_000 }); // owes 6,000
  await post({ type: 'payment_in', partyId: customer.id, totalKobo: 1_000 }); // owes 5,000

  const people = Object.fromEntries((await ok(t, 'GET', '/api/parties')).data.map((p: any) => [p.name, p]));
  assert.equal(people['Amaka Obi'].owesYouKobo, 5_000);
  assert.equal(people['Amaka Obi'].youOweKobo, 0);
  assert.equal(people['Mama Put Supplies'].youOweKobo, 25_000);
  assert.equal(people['Mama Put Supplies'].owesYouKobo, 0);

  const s = await ok(t, 'GET', '/api/summary?window=month');
  assert.equal(s.owedToYouKobo, 5_000);
  assert.equal(s.youOweKobo, 25_000);

  // Statement: running balance per row, nothing brought forward when everything is inside the period.
  const st = await ok(t, 'GET', `/api/statements?kind=party&partyId=${customer.id}&${range()}`);
  assert.equal(st.rows.length, 2);
  assert.deepEqual(st.rows.map((r: any) => r.owesYouKobo), [6_000, 5_000]);
  assert.equal(st.broughtForward.owesYouKobo, 0);
  assert.equal(st.closing.owesYouKobo, 5_000);

  // Same period, but starting after the entries: everything is "brought forward".
  const later = `from=${new Date(Date.now() + 1000).toISOString()}&to=${new Date(Date.now() + 3600e3).toISOString()}`;
  const st2 = await ok(t, 'GET', `/api/statements?kind=party&partyId=${customer.id}&${later}`);
  assert.equal(st2.rows.length, 0);
  assert.equal(st2.broughtForward.owesYouKobo, 5_000);
});

// ---- rule 4 ---------------------------------------------------------------------
test('rule 4: stock on hand = opening stock + purchases - sales, and nothing is ever refused for stock', async () => {
  const t = tenant();
  const item = await rice(t);
  const stock = async () => (await ok(t, 'GET', '/api/items')).data[0].stock;
  const post = (b: object) => api(t, 'POST', '/api/entries', b);
  const sell = (qty: number) => post({ type: 'sale', lines: L(item.id, qty, 100) });

  assert.equal(await stock(), 0);
  assert.equal((await sell(1)).status, 201, 'a sale is never refused for low stock');
  assert.equal(await stock(), -1, 'short stock shows as a negative number');
  const purchase = (await post({ type: 'purchase', lines: L(item.id, 100, 100) })).body;
  await post({ type: 'opening_stock', lines: L(item.id, 20.5, 100) });
  const sale = (await sell(30)).body;
  assert.equal(await stock(), 89.5);
  assert.equal((await sell(90.5)).status, 201);
  assert.equal(await stock(), -1);

  const st = await ok(t, 'GET', `/api/statements?kind=stock&${range()}`);
  assert.deepEqual(
    { opening: st.rows[0].opening, in: st.rows[0].in, out: st.rows[0].out, closing: st.rows[0].closing },
    { opening: 0, in: 120.5, out: 121.5, closing: -1 });

  // Deleting a sale puts stock back. Deleting a purchase is never refused either; the item just becomes short.
  await ok(t, 'DELETE', `/api/entries/${sale.id}`);
  assert.equal(await stock(), 29);
  await ok(t, 'DELETE', `/api/entries/${purchase.id}`);
  assert.equal(await stock(), -71);
});

// ---- rule 5 ---------------------------------------------------------------------
test('rule 5: profit matches the formula and deleted entries are in no total', async () => {
  const t = tenant();
  const item = await rice(t);
  const customer = await person(t, 'Amaka');
  const post = (b: object) => ok(t, 'POST', '/api/entries', b);

  await post({ type: 'purchase', lines: L(item.id, 10, 500) }); // 5,000; average cost 500
  const sale = await post({ type: 'sale', partyId: customer.id, lines: L(item.id, 4, 1200), paidKobo: 800 }); // 4,800; cost of goods 2,000
  const expense = await post({ type: 'expense', totalKobo: 300 });

  let s = await ok(t, 'GET', '/api/summary?window=day');
  assert.equal(s.salesKobo, 4_800);
  assert.equal(s.purchasesKobo, 5_000);
  assert.equal(s.expensesKobo, 300);
  assert.equal(s.cogsKobo, 2_000);
  assert.equal(s.profitKobo, 4_800 - 2_000 - 300);
  assert.equal(s.owedToYouKobo, 4_000);

  await ok(t, 'DELETE', `/api/entries/${sale.id}`);
  s = await ok(t, 'GET', '/api/summary?window=day');
  assert.equal(s.salesKobo, 0);
  assert.equal(s.cogsKobo, 0);
  assert.equal(s.profitKobo, -300);
  assert.equal(s.owedToYouKobo, 0);
  assert.equal((await ok(t, 'GET', '/api/parties')).data[0].owesYouKobo, 0);
  assert.equal((await ok(t, 'GET', '/api/items')).data[0].stock, 10);
  assert.equal((await ok(t, 'GET', '/api/entries?type=sale')).data.length, 0);
  assert.equal((await ok(t, 'GET', `/api/statements?kind=sales&${range()}`)).rows.length, 0);

  await ok(t, 'DELETE', `/api/entries/${expense.id}`);
  assert.equal((await ok(t, 'GET', '/api/summary?window=week')).profitKobo, 0);
  assert.equal((await api(t, 'DELETE', `/api/entries/${expense.id}`)).status, 404, 'already deleted');
});

// ---- the rest of the API -----------------------------------------------------------
test('deleting a party or item hides it; money it was involved in still counts', async () => {
  const t = tenant();
  const item = await rice(t);
  const customer = await person(t, 'Amaka');
  await ok(t, 'POST', '/api/entries', { type: 'opening_stock', lines: L(item.id, 10, 100) });
  await ok(t, 'POST', '/api/entries', { type: 'sale', partyId: customer.id, lines: L(item.id, 1, 1000), paidKobo: 0 });

  assert.deepEqual(await ok(t, 'DELETE', `/api/parties/${customer.id}`), { id: customer.id, deleted: true });
  await ok(t, 'DELETE', `/api/items/${item.id}`);
  assert.equal((await ok(t, 'GET', '/api/parties')).data.length, 0);
  assert.equal((await ok(t, 'GET', '/api/items')).data.length, 0);
  assert.equal((await api(t, 'DELETE', `/api/parties/${customer.id}`)).status, 404);
  assert.equal((await api(t, 'POST', '/api/entries', { type: 'payment_in', partyId: customer.id, totalKobo: 1 })).status, 404, 'cannot use a deleted party');
  assert.equal((await ok(t, 'GET', '/api/summary')).owedToYouKobo, 1_000);
});

test('search finds entries and people by word prefix, within the tenant', async () => {
  const t = tenant();
  const item = await ok(t, 'POST', '/api/items', { name: 'Basmati Rice', unit: 'kg', priceKobo: 100 });
  const amaka = await person(t, 'Amaka Obi');
  await person(t, 'Bola');
  await ok(t, 'POST', '/api/entries', { type: 'opening_stock', lines: L(item.id, 10, 100) });
  const sale = await ok(t, 'POST', '/api/entries', { type: 'sale', partyId: amaka.id, lines: L(item.id, 1, 100), note: 'Wedding order' });
  const q = (path: string, text: string) => ok(t, 'GET', `/api/${path}?q=${encodeURIComponent(text)}`).then((r) => r.data.length);

  assert.equal(await q('parties', 'ama'), 1);
  assert.equal(await q('parties', 'AMAKA ob'), 1);
  assert.equal(await q('parties', 'maka'), 0, 'prefix search only');
  assert.equal(await q('items', 'bas'), 1);
  assert.equal(await q('entries', 'wedd'), 1);
  assert.equal(await q('entries', 'amaka basmati'), 1, 'all words must match');
  assert.equal(await q('entries', 'amaka bola'), 0);
  assert.equal(await q('entries', sale.invoiceNo), 1);
  assert.equal(await q('entries', 'basmati'), 2);
});

test('lists page at 100 with a cursor', async () => {
  const t = tenant();
  for (let i = 0; i < 101; i++) await ok(t, 'POST', '/api/entries', { type: 'expense', totalKobo: 100 + i });
  const first = await ok(t, 'GET', '/api/entries');
  assert.equal(first.data.length, 100);
  assert.ok(first.next);
  const second = await ok(t, 'GET', `/api/entries?cursor=${first.next}`);
  assert.equal(second.data.length, 1);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.data, ...second.data].map((e: any) => e.invoiceNo)).size, 101, 'invoice numbers are unique');
});

test('sales statement groups by Lagos day and is capped at 30 days', async () => {
  const t = tenant();
  const item = await rice(t);
  await ok(t, 'POST', '/api/entries', { type: 'opening_stock', lines: L(item.id, 10, 100) });
  await ok(t, 'POST', '/api/entries', { type: 'sale', lines: L(item.id, 2, 1000), paidKobo: 500 });
  await ok(t, 'POST', '/api/entries', { type: 'sale', lines: L(item.id, 1, 1000) });

  const rows = (await ok(t, 'GET', `/api/statements?kind=sales&${range()}`)).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    day: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }),
    count: 2, totalKobo: 3000, paidKobo: 1500, outstandingKobo: 1500,
  });
  const tooLong = `from=${new Date(Date.now() - 31 * 86400e3).toISOString()}&to=${new Date().toISOString()}`;
  const r = await api(t, 'GET', `/api/statements?kind=sales&${tooLong}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'range_too_long');
  assert.equal((await api(t, 'GET', '/api/statements?kind=party&' + range())).status, 400, 'party statement needs partyId');
});

// ---- support for the web page -----------------------------------------------------------
test('/config.json is public and tells the browser how to sign in', async () => {
  const r = await app.inject({ url: '/config.json' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(r.json()).sort(), ['audience', 'clientId', 'domain']);
  assert.equal(r.json().audience, 'bookkeeper-test');
});

test('entries can be filtered by several types at once', async () => {
  const t = tenant();
  const person1 = await person(t, 'Ada');
  await ok(t, 'POST', '/api/entries', { type: 'expense', totalKobo: 100 });
  await ok(t, 'POST', '/api/entries', { type: 'payment_in', partyId: person1.id, totalKobo: 100 });
  await ok(t, 'POST', '/api/entries', { type: 'payment_out', partyId: person1.id, totalKobo: 100 });
  const types = async (q: string) => (await ok(t, 'GET', `/api/entries?type=${q}`)).data.map((e: any) => e.type).sort();
  assert.deepEqual(await types('payment_in,payment_out'), ['payment_in', 'payment_out']);
  assert.deepEqual(await types('expense'), ['expense']);
  assert.equal((await api(t, 'GET', '/api/entries?type=sale,nonsense')).status, 400);
});

test('the web page and its icons are served', async () => {
  const page = await app.inject({ url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<title>Bookkeeper<\/title>/);
  for (const [url, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/'], ['/apple-touch-icon.png', 'image/png'], ['/js/app.js', 'javascript'], ['/css/base.css', 'text/css']]) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, `${url} is served`);
    assert.ok(String(r.headers['content-type']).includes(type), `${url} has type ${type}, got ${r.headers['content-type']}`);
  }
  assert.equal((await app.inject({ url: '/api/parties' })).statusCode, 401, 'the API is still protected');
});

// ---- one invoice, several items --------------------------------------------------------
test('one invoice can carry several items', async () => {
  const t = tenant();
  const rice1 = await rice(t);
  const oil = await ok(t, 'POST', '/api/items', { name: 'Palm oil', unit: 'jerrycan', priceKobo: 500 });
  const ada = await person(t, 'Ada');
  await ok(t, 'POST', '/api/entries', { type: 'opening_stock', lines: [...L(rice1.id, 10, 400), ...L(oil.id, 5, 1000)] });

  // one sale, three lines (rice twice), one invoice number, one "paid" amount
  const sale = await ok(t, 'POST', '/api/entries', { type: 'sale', partyId: ada.id, paidKobo: 3000, lines: [...L(rice1.id, 4, 700), ...L(oil.id, 2, 1500), ...L(rice1.id, 1, 700)] });
  assert.match(sale.invoiceNo, /^INV-[0-9A-F]{10}$/);
  assert.deepEqual(sale.lines.map((l: any) => l.totalKobo), [2800, 3000, 700]);
  assert.equal(sale.totalKobo, 6500, 'the invoice total is the sum of its lines');
  assert.equal((await ok(t, 'GET', '/api/entries?type=sale')).data.length, 1, 'still one entry');

  const stock = async () => Object.fromEntries((await ok(t, 'GET', '/api/items')).data.map((i: any) => [i.name, i.stock]));
  assert.deepEqual(await stock(), { Rice: 5, 'Palm oil': 3 });

  // an invoice asking for more than the shelf holds is accepted (rice 3 + 3 against 5); the item shows short until stock is recorded
  const tooMuch = await ok(t, 'POST', '/api/entries', { type: 'sale', lines: [...L(rice1.id, 3, 700), ...L(oil.id, 1, 1500), ...L(rice1.id, 3, 700)] });
  assert.deepEqual(await stock(), { Rice: -1, 'Palm oil': 2 });
  await ok(t, 'DELETE', `/api/entries/${tooMuch.id}`);
  assert.deepEqual(await stock(), { Rice: 5, 'Palm oil': 3 });

  // money: ₦65 invoice, ₦30 paid -> ₦35 owed. Profit = sales - cost of goods (5 rice x 400 + 2 oil x 1000) = 6500 - 4000
  assert.equal((await ok(t, 'GET', '/api/parties')).data[0].owesYouKobo, 3500);
  const s = await ok(t, 'GET', '/api/summary?window=day');
  assert.deepEqual([s.salesKobo, s.cogsKobo, s.profitKobo], [6500, 4000, 2500]);

  // finding it: by any item on it, by invoice number, and by item filter
  const find = async (q: string) => (await ok(t, 'GET', `/api/entries?q=${encodeURIComponent(q)}`)).data.length;
  assert.equal(await find('palm'), 2, 'the opening stock and the sale both mention palm oil');
  assert.equal(await find(sale.invoiceNo), 1);
  assert.equal(await find(sale.invoiceNo.slice(0, 8)), 1, 'a few characters of the invoice number are enough');
  assert.equal((await ok(t, 'GET', `/api/entries?itemId=${oil.id}`)).data.length, 2);

  // stock that was already sold can be deleted (never refused); the items just show short. Deleting the sale evens it out.
  const opening = (await ok(t, 'GET', '/api/entries?type=opening_stock')).data[0];
  await ok(t, 'DELETE', `/api/entries/${opening.id}`);
  assert.deepEqual(await stock(), { Rice: -5, 'Palm oil': -2 });
  await ok(t, 'DELETE', `/api/entries/${sale.id}`);
  assert.deepEqual(await stock(), { Rice: 0, 'Palm oil': 0 });
  assert.equal((await ok(t, 'GET', '/api/summary?window=day')).profitKobo, 0);
});

// ---- older entries ---------------------------------------------------------------------
test('entries saved before item lines existed are repaired, so a sale is still a sale', async () => {
  const t = tenant();
  const item = await rice(t);
  const ada = await person(t, 'Ada');
  const old = { tenantId: t, deleted: false, date: new Date(), note: '', search: ['inv'], itemId: new ObjectId(item.id) };
  await entries().insertMany([
    { ...old, type: 'opening_stock', invoiceNo: 'INV-OLD0000001', qty: 10, unitPriceKobo: 400, totalKobo: 4000, paidKobo: 4000 },
    { ...old, type: 'sale', invoiceNo: 'INV-OLD0000002', partyId: new ObjectId(ada.id), qty: 4, unitPriceKobo: 700, totalKobo: 2800, paidKobo: 1000 },
  ] as any);

  assert.ok((await migrateLegacyEntries()) >= 2);
  const sale = (await ok(t, 'GET', '/api/entries?type=sale')).data[0];
  assert.deepEqual(sale.lines.map((l: any) => [l.itemId, l.qty, l.totalKobo]), [[item.id, 4, 2800]], 'the item moved onto a line');
  assert.equal(sale.itemId, undefined);
  assert.equal((await ok(t, 'GET', '/api/items')).data[0].stock, 6, 'stock counts the repaired entries');
  const s = await ok(t, 'GET', '/api/summary?window=month');
  assert.deepEqual([s.salesKobo, s.cogsKobo, s.profitKobo, s.owedToYouKobo], [2800, 1600, 1200, 1800]);
  assert.equal(await entries().countDocuments({ tenantId: t, lines: { $exists: false } } as any), 0, 'nothing left in the old shape');
  assert.equal(await migrateLegacyEntries(), 0, 'running it again changes nothing');
});
