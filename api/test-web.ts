// The phone side: the browser engine and sync client (web/js), run in Node against the real server.
// The engine and the server must give the same numbers; phones must converge; offline work must survive.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../api/server';
import { connect, close } from '../api/db';

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

// ---- load the browser files the way a page would -------------------------------------------
const ctx: any = vm.createContext({ console, crypto: globalThis.crypto, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval });
for (const f of ['store', 'engine', 'sync']) vm.runInContext(readFileSync(new URL(`../web/js/${f}.js`, import.meta.url), 'utf8'), ctx, { filename: `${f}.js` });
const plain = (x: any) => JSON.parse(JSON.stringify(x)); // values from the page's world: copy them before comparing
const DAY = 86_400_000;

const login = () => `auth0|${randomUUID()}`;
const sign = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer('https://test.example.com/')
  .setAudience('bookkeeper-test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
async function cloud(sub: string, method: string, url: string, payload?: object) {
  const r = await app.inject({ method: method as any, url, payload, headers: { authorization: `Bearer ${await sign(sub)}` } });
  assert.ok(r.statusCode < 300, `${method} ${url} -> ${r.statusCode} ${r.body}`);
  return r.json() as any;
}

/** A phone: its own empty storage, the real engine, and a sync client that talks to the server. */
async function phone(sub: string, device = `d-${randomUUID().slice(0, 12)}`) {
  const online = { on: true };
  const eng = ctx.Engine.create(ctx.Store.memory());
  await eng.load();
  await eng.setSession({ userId: sub, deviceId: device });
  const status: string[] = [];
  const sync = ctx.Sync.create({
    eng, deviceId: device, isOnline: () => online.on, getToken: () => sign(sub), onStatus: (s: any) => status.push(s.state),
    fetchFn: async (url: string, init: any) => {
      const r = await app.inject({ method: init.method, url, payload: init.body, headers: init.headers });
      return { status: r.statusCode, ok: r.statusCode < 300, json: async () => r.json() };
    },
  });
  await sync.run(); // the first sync learns the role, like the app does on first start
  const api = async (m: string, p: string, b?: object) => plain(await eng.request(m, p, b));
  return { eng, sync, online, status, api };
}

// ---- the same operations on the phone and on the server ---------------------------------------
type Side = { post(p: string, b: object): Promise<any>; del(p: string): Promise<any>; get(p: string): Promise<any> };
const onPhone = (p: Awaited<ReturnType<typeof phone>>): Side => ({ post: (a, b) => p.api('POST', a, b), del: (a) => p.api('DELETE', a), get: (a) => p.api('GET', a) });
const onServer = (sub: string): Side => ({ post: (a, b) => cloud(sub, 'POST', a, b), del: (a) => cloud(sub, 'DELETE', a), get: (a) => cloud(sub, 'GET', a) });

const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Plan once, play on both sides: names, quantities, prices, backdated days and deletes. */
function plan(seed: number, n: number) {
  const r = rng(seed), pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const ops: any[] = [];
  for (let i = 0; i < n; i++) {
    const type = pick(['sale', 'sale', 'sale', 'purchase', 'opening_stock', 'expense', 'payment_in', 'payment_out', 'delete']);
    const lines = [...Array(1 + Math.floor(r() * 3))].map(() => ({ item: Math.floor(r() * 3), qty: pick([1, 2, 3, 5, 0.5, 2.5, 12]), price: 100 * (1 + Math.floor(r() * 50)) }));
    ops.push({ type, lines, party: r() < 0.7 ? Math.floor(r() * 3) : null, partial: r() < 0.4, daysAgo: r() < 0.3 ? Math.floor(r() * 25) : 0, amount: 100 * (1 + Math.floor(r() * 400)), nth: Math.floor(r() * 1000) });
  }
  return ops;
}
async function play(side: Side, ops: any[], base: number) {
  const items: string[] = [], parties: string[] = [], made: string[] = [], gone = new Set<number>();
  for (const [i, n] of ['Rice', 'Oil', 'Beans'].entries()) items.push((await side.post('/api/items', { name: n, unit: 'kg', priceKobo: 1000 * (i + 1) })).id);
  for (const n of ['Ada', 'Bola', 'Chidi']) parties.push((await side.post('/api/parties', { name: n })).id);
  for (const o of ops) {
    if (o.type === 'delete') {
      if (!made.length) continue;
      const idx = o.nth % made.length;
      if (gone.has(idx)) continue;
      gone.add(idx); await side.del(`/api/entries/${made[idx]}`); continue;
    }
    const body: any = { type: o.type, ...(o.daysAgo ? { date: new Date(base - o.daysAgo * DAY).toISOString() } : {}) };
    if (['sale', 'purchase', 'opening_stock'].includes(o.type)) {
      body.lines = o.lines.map((l: any) => ({ itemId: items[l.item], qty: l.qty, unitPriceKobo: l.price }));
      if (o.type !== 'opening_stock' && o.party !== null) body.partyId = parties[o.party];
      if (o.partial && o.type !== 'opening_stock') body.paidKobo = Math.floor(body.lines.reduce((s: number, l: any) => s + Math.round(l.qty * l.unitPriceKobo), 0) / 2);
    } else {
      body.totalKobo = o.amount;
      if (o.type.startsWith('payment')) body.partyId = parties[o.party ?? 0];
    }
    made.push((await side.post('/api/entries', body)).id);
  }
}
/** Everything a person reads off the screens, in a form that does not depend on ids. */
async function books(side: Side, base: number) {
  const names = new Map<string, string>();
  const parties = (await side.get('/api/parties')).data;
  parties.forEach((p: any) => names.set(p.id, p.name));
  const sum = async (w: string) => { const s = await side.get(`/api/summary?window=${w}`); return { sales: s.salesKobo, bought: s.purchasesKobo, exp: s.expensesKobo, cogs: s.cogsKobo, profit: s.profitKobo, owed: s.owedToYouKobo, owe: s.youOweKobo }; };
  const range = `from=${new Date(base - 29 * DAY).toISOString()}&to=${new Date(base + 3_600_000).toISOString()}`;
  const stock = (await side.get(`/api/statements?kind=stock&${range}`)).rows.map((r: any) => ({ n: r.name, o: r.opening, i: r.in, u: r.out, c: r.closing }));
  const sales = (await side.get(`/api/statements?kind=sales&${range}`)).rows;
  const per: any = {};
  for (const p of parties) {
    const st = await side.get(`/api/statements?kind=party&partyId=${p.id}&${range}`);
    per[p.name] = { bf: st.broughtForward, closing: st.closing, rows: st.rows.map((r: any) => [r.type, r.totalKobo, r.paidKobo, r.owesYouKobo, r.youOweKobo]) };
  }
  return plain({
    day: await sum('day'), week: await sum('week'), month: await sum('month'),
    parties: parties.map((p: any) => [p.name, p.owesYouKobo, p.youOweKobo]).sort(),
    items: (await side.get('/api/items')).data.map((i: any) => [i.name, i.stock]).sort(),
    stock, sales, per,
    entries: (await side.get('/api/entries')).data.map((e: any) => [e.type, e.totalKobo, e.paidKobo]).sort(),
  });
}

// ---- tests ------------------------------------------------------------------------------------
for (const [seed, n] of [[1, 40], [7, 80], [42, 120]]) {
  test(`the phone and the cloud give the same numbers (random run ${seed}, ${n} operations)`, async () => {
    const sub = login(), base = Date.now(), ops = plan(seed, n);
    const p = await phone(login());
    await play(onPhone(p), ops, base);
    await play(onServer(sub), ops, base);
    assert.deepEqual(await books(onPhone(p), base), await books(onServer(sub), base));
  });
}

test('what a phone records offline reaches the cloud later, once, and the phone shows its status', async () => {
  const sub = login(), a = await phone(sub);
  const item = await a.api('POST', '/api/items', { name: 'Rice', unit: 'kg', priceKobo: 1000 });
  a.online.on = false;
  await a.api('POST', '/api/entries', { type: 'sale', lines: [{ itemId: item.id, qty: 3, unitPriceKobo: 1000 }] }); // no stock at all: still recorded
  await a.sync.run();
  assert.equal(a.eng.pendingCount(), 2, 'the item and the sale are waiting');
  assert.equal(a.status.at(-1), 'offline');
  assert.equal((await cloud(sub, 'GET', '/api/entries')).data.length, 0);
  a.online.on = true;
  await a.sync.run(); await a.sync.run(); // a second run changes nothing
  assert.equal(a.eng.pendingCount(), 0);
  assert.equal(a.status.at(-1), 'synced');
  assert.equal((await cloud(sub, 'GET', '/api/entries')).data.length, 1);
  assert.equal((await cloud(sub, 'GET', '/api/items')).data[0].stock, -3, 'short stock, shown as negative');
});

test('two phones on one business converge, and a delete shows to everyone with who and why', async () => {
  const sub = login(), a = await phone(sub), b = await phone(sub);
  const item = await a.api('POST', '/api/items', { name: 'Rice', unit: 'kg', priceKobo: 1000 });
  const sale = await a.api('POST', '/api/entries', { type: 'sale', lines: [{ itemId: item.id, qty: 2, unitPriceKobo: 1000 }] });
  await a.sync.run(); await b.sync.run();
  assert.equal((await b.api('GET', '/api/entries')).data.length, 1);
  const other = await b.api('POST', '/api/entries', { type: 'expense', totalKobo: 300 }); // B records while A deletes
  await a.api('DELETE', `/api/entries/${sale.id}?reason=wrong%20price`);
  await a.sync.run(); await b.sync.run(); await a.sync.run();
  for (const p of [a, b]) {
    assert.deepEqual((await p.api('GET', '/api/entries')).data.map((e: any) => e.id), [other.id]);
    const gone = (await p.api('GET', '/api/deleted')).data[0];
    assert.deepEqual([gone.id, gone.deletedBy, gone.deletedReason, gone.lines.length], [sale.id, sub, 'wrong price', 1]);
    assert.equal((await p.api('GET', '/api/summary?window=day')).salesKobo, 0);
  }
});

test('staff phone: no profit, deletes only its own entries, and the rules are checked before anything is saved', async () => {
  const boss = login(), bp = await phone(boss), staffSub = login();
  const { code } = await cloud(boss, 'POST', '/api/invites');
  await cloud(staffSub, 'POST', '/api/invites/accept', { code, name: 'Staff' });
  const sp = await phone(staffSub);
  const bossEntry = await bp.api('POST', '/api/entries', { type: 'expense', totalKobo: 500 });
  await bp.sync.run(); await sp.sync.run();
  assert.equal(sp.eng.session().role, 'staff');
  const s = await sp.api('GET', '/api/summary?window=day');
  assert.ok(!('profitKobo' in s) && !('cogsKobo' in s));
  assert.ok('profitKobo' in (await bp.api('GET', '/api/summary?window=day')));
  await assert.rejects(sp.api('DELETE', `/api/entries/${bossEntry.id}`), (e: any) => e.status === 403 && e.code === 'not_allowed');
  await assert.rejects(sp.api('POST', '/api/entries', { type: 'sale', lines: [{ itemId: 'x', qty: 1, unitPriceKobo: 1 }] }), (e: any) => e.code === 'validation');
  await assert.rejects(sp.api('POST', '/api/entries', { type: 'expense', totalKobo: 5, date: new Date(Date.now() + 3 * DAY).toISOString() }), (e: any) => e.code === 'validation');
  const mine = await sp.api('POST', '/api/entries', { type: 'purchase', lines: [], totalKobo: 1 }).catch((e: any) => e.code);
  assert.equal(mine, 'validation');
  const own = await sp.api('POST', '/api/entries', { type: 'expense', totalKobo: 200 });
  await sp.api('DELETE', `/api/entries/${own.id}`);
  await sp.sync.run(); await bp.sync.run();
  const gone = (await bp.api('GET', '/api/deleted')).data[0];
  assert.deepEqual([gone.id, gone.deletedBy], [own.id, staffSub]);
});

test('a phone whose member was removed is told so, and its sync reports it', async () => {
  const boss = login(), staffSub = login();
  const { code } = await cloud(boss, 'POST', '/api/invites');
  await cloud(staffSub, 'POST', '/api/invites/accept', { code });
  const sp = await phone(staffSub);
  let removed = 0;
  const sync = ctx.Sync.create({
    eng: sp.eng, deviceId: 'd-removedphone', isOnline: () => true, getToken: () => sign(staffSub), onRevoked: () => removed++,
    fetchFn: async (url: string, init: any) => { const r = await app.inject({ method: init.method, url, payload: init.body, headers: init.headers }); return { status: r.statusCode, ok: r.statusCode < 300, json: async () => r.json() }; }
  });
  await cloud(boss, 'DELETE', `/api/members/${encodeURIComponent(staffSub)}`);
  await sync.run();
  assert.equal(removed, 1);
});
