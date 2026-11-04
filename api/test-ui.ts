// UI tests: a real browser (Chromium) against the real backend and database.
// Run with: npm run test:ui   (needs TEST_MONGODB_URI, and once: npx playwright install chromium)
// Auth0 is replaced by a tiny stub that hands the page a token signed with a local key.
// Set SCREENSHOTS=some/folder to also save a picture of each main screen.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT } from 'jose';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { buildApp } from './server';
import { connect, close } from './db';

// Globals that exist inside the web page (used in page.evaluate); declared so TypeScript knows their names.
declare const drawInvoice: (entry: unknown) => Promise<HTMLCanvasElement>;
declare const S: { rows: Map<string, unknown> };
declare const entryTitle: (entry: unknown) => string;
declare const Syn: { run(): Promise<void> };
declare const refreshLists: () => Promise<void>;
declare const route: () => void;

const uri = process.env.TEST_MONGODB_URI;
if (!uri) throw new Error('Set TEST_MONGODB_URI (a throwaway database) to run the tests');
process.env.AUTH0_DOMAIN = 'test.example.com';
process.env.AUTH0_AUDIENCE = 'bookkeeper-test';
process.env.AUTH0_CLIENT_ID = 'test-client';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const keys = await generateKeyPair('RS256');
const app = buildApp(async () => keys.publicKey);
let browser: Browser;
let base = '';

before(async () => {
  await connect(uri);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: (process.env.CHROME_ARGS || '').split(' ').filter(Boolean) });
});
after(async () => { await browser?.close(); await app.close(); await close(); });

// ---- helpers ---------------------------------------------------------------------------
const AUTH0_STUB = `window.auth0 = { createAuth0Client: async () => ({
  isAuthenticated: async () => sessionStorage.getItem('signed-in') === '1',
  handleRedirectCallback: async () => {},
  loginWithRedirect: async () => { sessionStorage.setItem('signed-in', '1'); location.reload(); },
  getTokenSilently: async () => window.__TOKEN,
  getUser: async () => ({ name: 'Mama Ngozi Stores', email: 'ngozi@example.com' }),
  logout: async () => { sessionStorage.setItem('signed-in', '0'); location.reload(); },
}) };`;

const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1360, height: 800 } };

async function openApp(size: keyof typeof SIZES, o: { signedIn?: boolean; tenant?: string; invite?: string; sw?: boolean } = {}) {
  const tenant = o.tenant ?? `auth0|${randomUUID()}`;
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(tenant)
    .setIssuer('https://test.example.com/').setAudience('bookkeeper-test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  const context = await browser.newContext({ viewport: SIZES[size], isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: o.sw ? 'allow' : 'block' }); // the offline shell is only switched on in the tests that are about it
  await context.route('**/auth0-spa-js*', (r) => r.fulfill({ contentType: 'application/javascript', body: AUTH0_STUB }));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.addInitScript('window.__name = (f) => f;'); // tsx adds this helper to functions; the browser needs it for page.evaluate
  await context.addInitScript(`window.__TOKEN = ${JSON.stringify(token)}; if (sessionStorage.getItem('signed-in') === null) sessionStorage.setItem('signed-in', '${o.signedIn === false ? 0 : 1}');`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message)); // any uncaught error in the page fails the test
  await page.goto(o.invite ? `${base}/?invite=${o.invite}` : base);
  const call = async (method: string, path: string, body?: object) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    assert.ok(r.ok, `${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  return { page, errors, call, tenant, context };
}

async function until(check: () => Promise<boolean>, what: string, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)); }
  assert.fail(`timed out waiting for: ${what}`);
}
const id = (page: Page, testid: string) => page.getByTestId(testid);
const text = async (l: Locator) => (await l.innerText()).replace(/\s+/g, ' ').trim();
const shows = (l: Locator, expected: string | RegExp, what: string) =>
  until(async () => { const t = (await l.count()) ? await text(l.first()) : ''; return typeof expected === 'string' ? t === expected : expected.test(t); }, `${what} to show ${expected}`);
const count = (l: Locator, n: number, what: string) => until(async () => (await l.count()) === n, `${what} to be ${n}`);
const shot = async (page: Page, name: string) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png` }); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The page reads the phone's own copy of the books. After changing things on the server, reload and sync so the page has them. */
async function pull(page: Page) {
  await page.reload();
  await page.waitForFunction(() => typeof Syn !== 'undefined');
  await page.evaluate(async () => { await Syn.run(); await refreshLists(); route(); });
  await id(page, 'hello').waitFor();
}
const syncNow = (page: Page) => page.evaluate(async () => { await Syn.run(); });

/** A small shop: stock, two customers, a supplier, and a few entries. Amounts are in kobo. */
async function seed(call: (m: string, p: string, b?: object) => Promise<any>) {
  const rice = await call('POST', '/api/items', { name: 'Rice 50kg', unit: 'bag', priceKobo: 5_000_000 });
  const ngozi = await call('POST', '/api/parties', { name: 'Mama Ngozi', phone: '0803 555 0142' });
  const chidi = await call('POST', '/api/parties', { name: 'Chidi Obi' });
  const depot = await call('POST', '/api/parties', { name: 'Depot Ltd' });
  await call('POST', '/api/entries', { type: 'opening_stock', lines: [{ itemId: rice.id, qty: 24, unitPriceKobo: 4_000_000 }] });
  const sale = await call('POST', '/api/entries', { type: 'sale', partyId: ngozi.id, lines: [{ itemId: rice.id, qty: 2, unitPriceKobo: 5_000_000 }], paidKobo: 4_000_000 }); // ₦100,000, ₦60,000 owed
  await call('POST', '/api/entries', { type: 'payment_in', partyId: chidi.id, totalKobo: 2_000_000 });
  await call('POST', '/api/entries', { type: 'expense', totalKobo: 1_250_000, note: 'Generator fuel' });
  await call('POST', '/api/entries', { type: 'purchase', partyId: depot.id, lines: [{ itemId: rice.id, qty: 10, unitPriceKobo: 4_500_000 }], paidKobo: 2_500_000 });
  await call('POST', '/api/entries', { type: 'payment_out', partyId: depot.id, totalKobo: 1_000_000 });
  return { rice, ngozi, chidi, depot, sale };
}

// ---- tests -----------------------------------------------------------------------------
test('sign in, see the app, sign out', async () => {
  const { page, errors } = await openApp('phone', { signedIn: false });
  await id(page, 'login').waitFor();
  assert.equal(await id(page, 'tab-home').count(), 0, 'no app navigation before signing in');
  await shot(page, '00-login');
  await id(page, 'login').click();
  await id(page, 'hello').waitFor();
  assert.ok(await id(page, 'tab-home').isVisible());
  await id(page, 'avatar').click();
  assert.match(await text(id(page, 'whoami')), /Mama Ngozi Stores/);
  await id(page, 'signout').click();
  await id(page, 'login').waitFor();
  assert.deepEqual(errors, []);
});

test('dark mode is optional, readable on form controls, and remembered', async () => {
  const { page, errors } = await openApp('phone');
  await id(page, 'hello').waitFor();
  await id(page, 'theme-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await text(id(page, 'theme-toggle')), 'Light mode');
  await id(page, 'theme-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await id(page, 'theme-toggle').click();
  await id(page, 'add-tab').click();
  const appearance = await id(page, 'f-item-0').evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    text: getComputedStyle(el).color,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    page: getComputedStyle(document.body).backgroundColor,
  }));
  assert.notEqual(appearance.background, 'rgb(255, 255, 255)', 'form select is not left white in dark mode');
  assert.notEqual(appearance.text, 'rgb(255, 255, 255)', 'select text remains readable');
  assert.equal(appearance.page, 'rgb(13, 24, 17)', 'dark mode uses a deep green-tinted page background');
  assert.equal(appearance.scheme, 'dark', 'native select options use dark colors');
  await page.reload();
  await id(page, 'hello').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.deepEqual(errors, []);
});

test('a new business sees friendly empty states', async () => {
  const { page, errors } = await openApp('phone');
  await id(page, 'profit').waitFor();
  assert.equal(await text(id(page, 'profit')), '₦0');
  assert.equal(await text(id(page, 'owed')), '₦0');
  assert.match(await text(id(page, 'empty')), /No entries yet/);
  for (const [tab, msg] of [['entries', /No entries yet/], ['people', /No people yet/], ['inventory', /inventory is empty/i]] as const) {
    await id(page, `tab-${tab}`).click();
    await shows(id(page, 'empty'), msg, `${tab} empty state`);
  }
  assert.deepEqual(errors, []);
});

test('phone: stock in, sell on credit, take a payment, correct a mistake', async () => {
  const { page, call, errors } = await openApp('phone');
  await id(page, 'hello').waitFor();

  // add an item and a person
  await id(page, 'tab-inventory').click();
  await id(page, 'new-item').click();
  await id(page, 'ni-name').fill('Rice 50kg');
  await id(page, 'ni-unit').fill('bag');
  await id(page, 'ni-price').fill('50000');
  await id(page, 'save-item').click();
  await shows(id(page, 'item-row'), /Rice 50kg ₦50,000 per bag Out/, 'new item (no stock yet)');
  await id(page, 'tab-people').click();
  await id(page, 'new-person').click();
  await id(page, 'np-name').fill('Mama Ngozi');
  await id(page, 'np-phone').fill('0803 555 0142');
  await id(page, 'save-person').click();
  await shows(id(page, 'person-row'), /Mama Ngozi 0803 555 0142 Settled/, 'new person');

  // stock they already had
  await id(page, 'add-tab').click();
  await id(page, 'type-purchase').click();
  await id(page, 'f-kind').selectOption('opening_stock');
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('24');
  await id(page, 'f-price-0').fill('40000');
  assert.equal(await text(id(page, 'total')), '₦960,000');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved · INV-[0-9A-F]{10}$/, 'toast with the invoice number');
  await id(page, 'tab-inventory').click();
  await shows(id(page, 'stock-chip'), '24 bags', 'stock after opening stock');

  // a sale where part is paid
  await id(page, 'add-tab').click();
  await id(page, 'f-party').selectOption({ label: 'Mama Ngozi' });
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  assert.equal(await id(page, 'f-price-0').inputValue(), '50,000', 'price is filled in from the item');
  await id(page, 'f-qty-0').fill('2');
  assert.equal(await text(id(page, 'total')), '₦100,000');
  assert.equal(await id(page, 'f-paid').inputValue(), '100,000', '"paid now" starts at the total');
  await id(page, 'f-paid').fill('40000');
  assert.equal(await text(id(page, 'owe')), 'Mama Ngozi will owe ₦60,000');
  await shot(page, '03-add-sale');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved/, 'sale saved');

  // Home: profit = 100,000 sales - 2 bags x 40,000 cost
  await id(page, 'tab-home').click();
  await shows(id(page, 'sales'), '₦100,000', 'sales');
  await shows(id(page, 'profit'), '₦20,000', 'profit');
  await shows(id(page, 'owed'), '₦60,000', 'owed to you');
  await shot(page, '01-home');
  await shows(id(page, 'entry-row').first(), /Rice 50kg × 2 Mama Ngozi · part paid INV-[0-9A-F]{10} \+₦100,000 ₦60,000 to collect/, 'recent sale row');

  // the person page and a payment
  await id(page, 'tab-people').click();
  await id(page, 'person-row').click();
  await shows(id(page, 'person-balance'), '₦60,000', 'person balance');
  await id(page, 'record-payment').click();
  assert.match((await id(page, 'type-payment_in').getAttribute('class')) ?? '', /\bon\b/, 'Money in is preselected for someone who owes you');
  await id(page, 'f-amount').fill('25000');
  assert.equal(await text(id(page, 'owe')), 'Mama Ngozi owes you ₦60,000. ₦35,000 left after this.');
  await id(page, 'save').click();
  await shows(id(page, 'person-balance'), '₦35,000', 'balance after the payment');
  await count(id(page, 'statement-row'), 2, 'statement rows');
  await shot(page, '04-person');

  // selling more than the shelf holds is allowed: shops sell first and record stock later. The form says so, and does not block.
  await id(page, 'add-tab').click();
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('23');
  assert.equal(await text(id(page, 'f-err')), '');
  assert.ok(await id(page, 'save').isEnabled(), 'a sale is never refused for low stock');
  assert.match(await page.locator('#f-stock-0').innerText(), /In stock: 22 bags. Not enough/);
  await id(page, 'panel-close').click();

  // delete the payment: the balance goes back
  await id(page, 'tab-entries').click();
  await shows(id(page, 'entry-row').first(), /Payment received/, 'newest entry');
  await id(page, 'entry-row').first().click();
  assert.match(await text(id(page, 'detail')), /Invoice INV-[0-9A-F]{10}/);
  await id(page, 'delete-entry').click();
  await id(page, 'confirm-delete').click();
  await shows(id(page, 'toast'), 'Entry deleted', 'delete toast');
  await id(page, 'tab-people').click();
  await shows(id(page, 'person-row'), /Owes you ₦60,000/, 'balance after deleting the payment');
  await syncNow(page); // everything done on the phone reaches the cloud: opening stock + the sale (the payment was deleted)
  assert.equal((await call('GET', '/api/entries')).data.length, 2);
  assert.deepEqual(errors, []);
});

test('search finds words, highlights them, and the chips and dates filter', async () => {
  const { page, call, errors } = await openApp('phone');
  const { sale } = await seed(call);
  await pull(page);
  await id(page, 'tab-entries').click();
  const rows = id(page, 'entry-row');
  await count(rows, 6, 'all entries');
  await shot(page, '02-entries');

  await id(page, 'q').fill('ngozi');
  await count(rows, 1, 'entries for "ngozi"');
  assert.equal(await page.locator('#elist mark').first().innerText(), 'Ngozi');
  await id(page, 'q').fill('mama ngo');
  await count(rows, 1, 'all typed words must match');
  await id(page, 'q').fill('gener');
  await shows(rows.first(), /Generator fuel/, 'search by note');
  await id(page, 'q').fill('zzz');
  await shows(id(page, 'empty'), /Nothing found/, 'no match');
  assert.match((await id(page, 'q').getAttribute('placeholder')) ?? '', /invoice no/i, 'the search box says invoices can be searched');
  await id(page, 'q').fill(sale.invoiceNo);
  await count(rows, 1, 'the invoice number, in full');
  await id(page, 'q').fill(sale.invoiceNo.toLowerCase().slice(0, 8));
  await count(rows, 1, 'the first few characters of the invoice number');
  assert.match(await text(rows.first()), new RegExp(sale.invoiceNo), 'the row shows its invoice number');
  await id(page, 'q').fill('');

  await id(page, 'chip-sales').click();
  await count(rows, 1, 'sales');
  await id(page, 'chip-bought').click();
  await count(rows, 2, 'stock entries');
  await id(page, 'chip-expenses').click();
  await count(rows, 1, 'expenses');
  await id(page, 'chip-payments').click();
  await count(rows, 2, 'payments (money in and money out)');
  await id(page, 'chip-all').click();
  await count(rows, 6, 'all again');

  await id(page, 'range').selectOption('today');
  await count(rows, 6, 'today');
  await id(page, 'range').selectOption('7');
  await count(rows, 6, 'last 7 days');
  assert.deepEqual(errors, []);
});

test('the form only asks for what each type needs and checks the numbers', async () => {
  const { page, call, errors } = await openApp('phone');
  const { ngozi } = await seed(call);
  await pull(page);
  await id(page, 'add-tab').click();
  const save = id(page, 'save');
  assert.ok(await save.isDisabled(), 'nothing filled in yet');

  // sale: fractional quantity, total worked out the same way the server does it
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('2.5');
  await id(page, 'f-price-0').fill('1333.33');
  assert.equal(await text(id(page, 'total')), '₦3,333.33'); // 2.5 x 133,333 kobo = 333,332.5 -> rounds up
  await id(page, 'f-paid').fill('4000');
  assert.equal(await text(id(page, 'f-err')), "Paid can't be more than the total");
  assert.ok(await save.isDisabled());
  await id(page, 'f-paid').fill('3333.33');
  assert.ok(await save.isEnabled());
  await id(page, 'f-note').fill('wedding');

  // the note survives a change of type; payments need a person; expenses need only an amount
  await id(page, 'type-payment_in').click();
  assert.equal(await id(page, 'f-note').inputValue(), 'wedding');
  assert.equal(await id(page, 'f-qty-0').count(), 0, 'no quantity for a payment');
  await id(page, 'f-amount').fill('100');
  assert.ok(await save.isDisabled(), 'a payment needs a person');
  await id(page, 'f-party').selectOption(ngozi.id);
  assert.ok(await save.isEnabled());
  await id(page, 'f-amount').fill('0');
  assert.ok(await save.isDisabled(), 'zero is not a payment');
  await id(page, 'type-expense').click();
  assert.equal(await id(page, 'f-party').count(), 0, 'no person for an expense');
  await id(page, 'f-amount').fill('12500');
  assert.ok(await save.isEnabled());
  await id(page, 'f-note').fill('Diesel');
  await save.click();
  await shows(id(page, 'toast'), /^Saved/, 'expense saved');
  await shows(id(page, 'entry-row').first(), /Diesel Expense INV-[0-9A-F]{10} −₦12,500/, 'new expense row on Home');

  // saving a fractional sale: the server's total matches what the form promised
  await id(page, 'add-tab').click();
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('2.5');
  await id(page, 'f-price-0').fill('1333.33');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved/, 'fractional sale saved');
  await id(page, 'entry-row').first().click();
  assert.match(await text(id(page, 'detail')), /Total ₦3,333\.33/);
  assert.deepEqual(errors, []);
});

test('a sale for more than the stock is accepted, and the item and Home say it is short', async () => {
  const { page, call, errors } = await openApp('phone');
  await seed(call); // 24 + 10 - 2 = 32 bags
  await pull(page);
  await id(page, 'add-tab').click();
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('40');
  assert.ok(await id(page, 'save').isEnabled());
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved/, 'the sale of 40 bags is saved');
  await shows(id(page, 'short-note'), /1 item\(s\) are short/, 'Home says something is short');
  await id(page, 'tab-inventory').click();
  await shows(id(page, 'stock-chip'), 'Short 8', 'the item shows how short it is');
  await id(page, 'add-tab').click(); // fixing it: record the stock that was bought, dated yesterday
  await id(page, 'type-purchase').click();
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('10');
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  await id(page, 'f-date').fill(yesterday);
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved/, 'the late purchase is saved');
  await id(page, 'tab-inventory').click();
  await shows(id(page, 'stock-chip'), '2 left', 'no longer short');
  assert.deepEqual(errors, []);
});

test('phone layout: bottom tabs, bottom sheet, big tap targets, no sideways scroll', async () => {
  const { page, call, errors } = await openApp('phone');
  await seed(call);
  await pull(page);
  assert.ok(await id(page, 'tab-home').isVisible());
  assert.ok(!(await id(page, 'nav-home').isVisible()), 'no sidebar on a phone');
  const icon = (await id(page, 'entry-row').first().locator('.ic').boundingBox())!;
  assert.ok(icon.width <= 40 && icon.height <= 40, 'row icons stay small (a form-field class once stretched them)');
  for (const t of ['tab-home', 'tab-entries', 'tab-people', 'tab-inventory']) assert.ok(((await id(page, t).boundingBox())?.height ?? 0) >= 48, `${t} is at least 48px tall`);
  await id(page, 'add-tab').click();
  const panel = (await page.locator('#panel').boundingBox())!;
  assert.ok(panel.y > 40 && Math.abs(panel.y + panel.height - 844) <= 1, 'the form is a sheet from the bottom');
  assert.ok(await page.locator('#dim').isVisible(), 'the page behind is dimmed');
  for (const t of ['save', 'f-qty-0', 'f-price-0']) assert.ok(((await id(page, t).boundingBox())?.height ?? 0) >= 48, `${t} is at least 48px tall`);
  await id(page, 'panel-close').click();
  assert.ok(await page.locator('#panel').isHidden());
  for (const t of ['entries', 'people', 'inventory']) { await id(page, `tab-${t}`).click(); await page.waitForTimeout(150); assert.ok(await noOverflow(page), `${t} fits the screen width`); }
  assert.deepEqual(errors, []);
});

test('desktop layout: sidebar, table, stat strip and a side panel', async () => {
  const { page, call, errors } = await openApp('desktop');
  await seed(call);
  await pull(page);
  await id(page, 'nav-entries').waitFor();
  assert.ok(await id(page, 'nav-entries').isVisible());
  assert.ok(!(await id(page, 'tab-home').isVisible()), 'no bottom tabs on desktop');
  await id(page, 'nav-entries').click();
  await count(id(page, 'entry-row'), 6, 'table rows');
  assert.ok(await page.locator('.tr.hd').isVisible(), 'table header');
  await count(page.locator('.st'), 4, 'stat cards');
  const first = id(page, 'entry-row').filter({ hasText: 'Mama Ngozi' }); // the sale
  assert.match(await text(first.locator('.c2')), /Sale/);
  assert.match(await text(first.locator('.c4')), /Mama Ngozi/);
  assert.match(await text(first.locator('.c6')), /₦60,000/);
  assert.match(await text(first.locator('small.d')), /^INV-[0-9A-F]{10}$/, 'the invoice number shows under the detail');
  assert.ok(await first.locator('small.d .copy').isVisible(), 'with its copy mark beside it');
  assert.equal(await first.locator('.amt').evaluate((el) => getComputedStyle(el).textAlign), 'right', 'money is right aligned');
  assert.match(await first.locator('.amt').evaluate((el) => getComputedStyle(el).fontVariantNumeric), /tabular-nums/);
  for (const tag of await page.locator('.tbl .tag').all()) assert.ok(((await tag.boundingBox())?.height ?? 99) <= 30, 'type tags are small pills');
  await shot(page, '10-desktop-entries');

  await id(page, 'add-side').click();
  const panel = (await page.locator('#panel').boundingBox())!;
  const table = (await page.locator('.tbl').boundingBox())!;
  assert.ok(panel.x > 900 && panel.width >= 330, 'the form is a column on the right');
  assert.ok(table.x + table.width <= panel.x + 1, 'the table is still visible beside it');
  assert.ok(!(await page.locator('#dim').isVisible()), 'nothing is dimmed');
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('1');
  await shot(page, '11-desktop-add');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved/, 'sale saved on desktop');
  await count(id(page, 'entry-row'), 7, 'table rows after saving');
  assert.ok(await page.locator('#panel').isHidden());
  assert.ok(await noOverflow(page));
  await id(page, 'nav-people').click();
  await count(id(page, 'person-row'), 3, 'people');
  assert.deepEqual(errors, []);
});

test('items: stock, low and out markers, search and remove', async () => {
  const { page, call, errors } = await openApp('phone');
  const mk = (name: string, unit: string, qty: number) => call('POST', '/api/items', { name, unit, priceKobo: 150_000 }).then((it) => qty ? call('POST', '/api/entries', { type: 'opening_stock', lines: [{ itemId: it.id, qty, unitPriceKobo: 100_000 }] }) : null);
  await mk('Salt 5kg', 'pack', 86); await mk('Palm oil 5L', 'jerrycan', 3); await mk('Spaghetti carton', 'carton', 0);
  await pull(page);
  await id(page, 'tab-inventory').click();
  await count(id(page, 'item-row'), 3, 'items');
  assert.match(await text(id(page, 'tab-inventory')), /Inventory/);
  assert.equal(await text(page.locator('#main h1')), 'Inventory');
  await id(page, 'tab-home').click();
  await page.evaluate(() => { location.hash = '#/items'; }); // an old bookmark still lands in the right place
  await shows(page.locator('#main h1'), 'Inventory', 'old #/items link');
  assert.match((await id(page, 'tab-inventory').getAttribute('class')) ?? '', /\bon\b/);
  await count(id(page, 'item-row'), 3, 'items again');
  const chip = (name: string) => text(id(page, 'item-row').filter({ hasText: name }).getByTestId('stock-chip'));
  assert.equal(await chip('Salt'), '86 packs');
  assert.equal(await chip('Palm'), '3 left');
  assert.equal(await chip('Spaghetti'), 'Out');
  assert.match((await id(page, 'item-row').filter({ hasText: 'Palm' }).getByTestId('stock-chip').getAttribute('class')) ?? '', /low/);
  await shot(page, '05-items');
  await id(page, 'iq').fill('sal');
  await count(id(page, 'item-row'), 1, 'search "sal"');
  await id(page, 'item-row').click();
  await id(page, 'remove-item').click();
  await id(page, 'confirm-yes').click();
  await shows(id(page, 'toast'), 'Item removed', 'remove toast');
  await id(page, 'iq').fill('');
  await count(id(page, 'item-row'), 2, 'items after removing one');
  assert.deepEqual(errors, []);
});

test('people: balances, search, statement, remove', async () => {
  const { page, call, errors } = await openApp('phone');
  await seed(call);
  await pull(page);
  await id(page, 'tab-people').click();
  await count(id(page, 'person-row'), 3, 'people');
  const bal = (name: string) => text(id(page, 'person-row').filter({ hasText: name }));
  assert.match(await bal('Ngozi'), /Owes you ₦60,000/);
  assert.match(await bal('Depot'), /You owe ₦415,000/); // bought ₦450,000, paid ₦25,000, then paid ₦10,000
  assert.match(await bal('Chidi'), /Settled/); // paid ahead: a credit, not a debt
  await id(page, 'pq').fill('ngo');
  await count(id(page, 'person-row'), 1, 'search "ngo"');
  await id(page, 'person-row').click();
  assert.equal(await text(id(page, 'person-name')), 'Mama Ngozi');
  assert.ok(await id(page, 'reminder').isVisible(), 'a reminder link for someone who owes you');
  assert.match((await id(page, 'reminder').getAttribute('href')) ?? '', /^https:\/\/wa\.me\/2348035550142\?text=/);
  await id(page, 'remove-person').click();
  await id(page, 'confirm-yes').click();
  await id(page, 'pq').waitFor();
  assert.equal(new URL(page.url()).hash, '#/people');
  await id(page, 'pq').fill('');
  await count(id(page, 'person-row'), 2, 'people after removing one');
  await syncNow(page);
  const owed = await call('GET', '/api/summary?window=month');
  assert.equal(owed.owedToYouKobo, 4_000_000, 'what Ngozi owed (₦60,000, less Chidi\'s ₦20,000 advance) still counts');
  assert.deepEqual(errors, []);
});

test('each business only sees its own data', async () => {
  const a = await openApp('phone');
  await seed(a.call);
  const b = await openApp('phone');
  await id(b.page, 'tab-people').click();
  await shows(id(b.page, 'empty'), /No people yet/, "business B's people");
  await id(b.page, 'tab-entries').click();
  await shows(id(b.page, 'empty'), /No entries yet/, "business B's entries");
  await pull(a.page);
  await id(a.page, 'tab-people').click();
  await count(id(a.page, 'person-row'), 3, "business A's people");
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('one invoice, several items: build it, see it, and stock follows', async () => {
  const { page, call, errors } = await openApp('phone');
  const rice = await call('POST', '/api/items', { name: 'Rice 50kg', unit: 'bag', priceKobo: 5_000_000 });
  const oil = await call('POST', '/api/items', { name: 'Palm oil 5L', unit: 'jerrycan', priceKobo: 1_500_000 });
  await call('POST', '/api/parties', { name: 'Ada' });
  await call('POST', '/api/entries', { type: 'opening_stock', lines: [{ itemId: rice.id, qty: 20, unitPriceKobo: 4_000_000 }, { itemId: oil.id, qty: 10, unitPriceKobo: 1_000_000 }] });
  await pull(page);

  await id(page, 'add-tab').click();
  await id(page, 'f-party').selectOption({ label: 'Ada' });
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('2');
  assert.equal(await text(id(page, 'f-lt-0')), '₦100,000');
  await id(page, 'add-line').click();
  await id(page, 'f-item-1').selectOption({ label: 'Palm oil 5L' });
  await id(page, 'f-qty-1').fill('3');
  assert.equal(await text(id(page, 'f-lt-1')), '₦45,000');
  assert.equal(await text(id(page, 'total')), '₦145,000');
  await id(page, 'add-line').click(); // a blank third line blocks saving until it is filled or removed
  assert.ok(await id(page, 'save').isDisabled());
  await id(page, 'remove-line-2').click();
  assert.ok(await id(page, 'save').isEnabled());
  assert.equal(await id(page, 'f-item-1').inputValue(), oil.id, 'removing a line keeps the others');
  assert.equal(await id(page, 'f-paid').inputValue(), '145,000');
  await id(page, 'f-paid').fill('100000');
  assert.equal(await text(id(page, 'owe')), 'Ada will owe ₦45,000');
  await shot(page, '06-add-two-items');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved · INV-/, 'saved');

  await id(page, 'tab-entries').click(); // ONE row for the whole invoice
  const rows = id(page, 'entry-row');
  await count(rows, 2, 'opening stock + the invoice');
  await shows(rows.first(), /Rice 50kg × 2 \+1 more Ada · part paid/, 'one row with "+1 more"');
  await rows.first().click();
  const detail = await text(id(page, 'detail'));
  assert.match(detail, /Rice 50kg 2 × ₦50,000 = ₦100,000/);
  assert.match(detail, /Palm oil 5L 3 × ₦15,000 = ₦45,000/);
  assert.match(detail, /Total ₦145,000/);
  assert.match(detail, /Still to collect ₦45,000/);
  await shot(page, '07-invoice-detail');

  await id(page, 'panel-close').click(); // stock followed for both items
  await id(page, 'tab-inventory').click();
  await count(id(page, 'item-row'), 2, 'items');
  assert.equal(await text(id(page, 'item-row').filter({ hasText: 'Rice' }).getByTestId('stock-chip')), '18 bags');
  assert.equal(await text(id(page, 'item-row').filter({ hasText: 'Palm' }).getByTestId('stock-chip')), '7 jerrycans');

  await id(page, 'add-tab').click(); // the same item on two lines is added up before checking stock
  await id(page, 'f-item-0').selectOption({ label: 'Palm oil 5L' });
  await id(page, 'f-qty-0').fill('4');
  await id(page, 'add-line').click();
  await id(page, 'f-item-1').selectOption({ label: 'Palm oil 5L' });
  await id(page, 'f-qty-1').fill('4');
  assert.equal(await text(id(page, 'f-err')), '', 'not an error: the sale is allowed');
  assert.match(await page.locator('#f-stock-1').innerText(), /Not enough/, 'but the form says the two lines together are more than the stock');
  assert.ok(await id(page, 'save').isEnabled());
  assert.deepEqual(errors, []);
});

test('an invoice can be saved as an image', async () => {
  const { page, call, errors } = await openApp('phone');
  const { sale } = await seed(call); // one line, ₦60,000 still owed
  await pull(page);
  await id(page, 'tab-entries').click();
  await id(page, 'entry-row').filter({ hasText: sale.invoiceNo }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), id(page, 'export-invoice').click()]);
  assert.equal(download.suggestedFilename(), `${sale.invoiceNo}.png`);
  if (process.env.SCREENSHOTS) await download.saveAs(`${process.env.SCREENSHOTS}/08-invoice.png`);
  const bytes = readFileSync((await download.path())!);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'a real PNG');
  assert.equal(bytes.readUInt32BE(16), 760 * 2, 'width (drawn twice as big for sharpness)');
  assert.equal(bytes.readUInt32BE(20), (268 + 46 + 170 + 70) * 2, 'height grows with the number of lines');
  await shows(id(page, 'toast'), `Saved ${sale.invoiceNo}.png`, 'toast');

  // look at the pixels: green header band, white page, dark text in the item row, red "balance due"
  const px = await page.evaluate(async (entryId) => {
    const c = await drawInvoice(S.rows.get(entryId));
    const g = c.getContext('2d')!;
    const at = (x: number, y: number) => [...g.getImageData(x * 2, y * 2, 1, 1).data];
    const count = (y: number, h: number, test: (r: number, gr: number, b: number) => boolean) => { const d = g.getImageData(0, y * 2, c.width, h * 2).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++; return n; };
    return { header: at(10, 10), page: at(10, 500), itemInk: count(268, 46, (r) => r < 100), redInk: count(300, 200, (r, gr, b) => r > 150 && gr < 70 && b < 70) };
  }, sale.id);
  assert.deepEqual(px.header, [11, 107, 79, 255]);
  assert.deepEqual(px.page, [255, 255, 255, 255]);
  assert.ok(px.itemInk > 200, 'the item row has text in it');
  assert.ok(px.redInk > 100, 'the balance due is drawn in red');
  assert.equal(await id(page, 'share-invoice').count(), 0, 'no Share button where the browser cannot share files');
  await id(page, 'panel-close').click();
  await id(page, 'entry-row').filter({ hasText: 'Generator fuel' }).click();
  assert.equal(await id(page, 'export-invoice').count(), 0, 'an expense has no invoice to save');
  assert.deepEqual(errors, []);
});

test('every category has its own mark, and a sale is never called an expense', async () => {
  const { page, call, errors } = await openApp('phone');
  await seed(call);
  await pull(page);
  await id(page, 'tab-entries').click();
  const rows = id(page, 'entry-row');
  await count(rows, 6, 'entries');

  // what each category must look like: icon colour set, sign, and the words under the amount
  const expected: [string, string, string, RegExp | null][] = [
    ['Rice 50kg × 2', 'k-sale', '+', /₦60,000 to collect/], // a sale: money coming in, still to collect
    ['Rice 50kg × 10', 'k-bought', '−', /₦425,000 to pay/], // a purchase: money going out, still to PAY (not "collect")
    ['Generator fuel', 'k-expense', '−', null],
    ['Payment received', 'k-in', '+', null],
    ['Payment made', 'k-out', '−', null],
    ['Rice 50kg × 24', 'k-stock', '', null], // opening stock: no money moved, no sign
  ];
  const icons = new Set<string>();
  for (const [title, kind, sign, words] of expected) {
    const row = rows.filter({ hasText: title }).first();
    assert.match((await row.locator('.ic').getAttribute('class')) ?? '', new RegExp(`\\b${kind}\\b`), `${title} uses ${kind}`);
    const first = await row.locator('.amt').evaluate((el) => el.firstChild?.textContent?.[0] ?? '');
    assert.equal(first === '+' || first === '−' ? first : '', sign, `${title} is marked "${sign}"`);
    if (words) assert.match(await text(row.locator('.amt')), words);
    else assert.equal(await row.locator('.amt small').count(), 0, `${title} has no owed line`);
    icons.add(await row.locator('.ic svg').innerHTML());
  }
  assert.equal(icons.size, 6, 'six categories, six different icons');
  assert.ok(!/Expense/.test(await text(rows.filter({ hasText: 'Rice 50kg × 2' }).first())), 'the sale is not labelled an expense');

  // money to collect is red, money still to pay is amber, never the same
  const color = (sel: string) => rows.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(await color('.amt small.collect'), await color('.amt small.pay'));
  assert.equal(await color('.amt small.collect'), 'rgb(180, 35, 24)');

  // an entry with no item lines (saved before invoices had lines) is still called what it is
  const titles = await page.evaluate(() => (['sale', 'purchase', 'opening_stock', 'expense', 'payment_in', 'payment_out'] as const).map((type) => entryTitle({ type, note: '' })));
  assert.deepEqual(titles, ['Sale', 'Bought', 'Opening stock', 'Expense', 'Payment received', 'Payment made']);
  assert.deepEqual(errors, []);
});

test('the invoice number has a copy mark that copies it', async () => {
  const { page, call, errors } = await openApp('phone');
  const { sale } = await seed(call);
  await pull(page);
  await id(page, 'tab-entries').click();
  const row = id(page, 'entry-row').filter({ hasText: sale.invoiceNo });
  await row.waitFor();

  // in the list: copies WITHOUT opening the entry
  await row.locator('[data-testid=copy-invoice]:visible').click();
  await shows(id(page, 'toast'), `Copied ${sale.invoiceNo}`, 'copy toast');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sale.invoiceNo);
  assert.ok(await page.locator('#panel').isHidden(), 'copying did not open the entry');
  assert.ok((await row.locator('.copy').first().getAttribute('class'))?.includes('done'), 'the mark turns into a tick');

  // beside the number in the detail panel
  await row.click();
  await id(page, 'detail').locator('[data-testid=copy-invoice]').click();
  await shows(id(page, 'toast'), `Copied ${sale.invoiceNo}`, 'copy toast in detail');
  const size = (await id(page, 'detail').locator('[data-testid=copy-invoice]').boundingBox())!;
  assert.ok(size.width >= 30, 'a bigger mark in the detail panel');

  // keyboard: Enter on the focused mark, and still no entry opened from the list
  await id(page, 'panel-close').click();
  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await row.locator('[data-testid=copy-invoice]:visible').focus();
  await page.keyboard.press('Enter');
  await shows(id(page, 'toast'), `Copied ${sale.invoiceNo}`, 'copy by keyboard');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sale.invoiceNo);

  // where the browser refuses the clipboard (plain http), the older way is used
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) }, configurable: true }); document.execCommand = () => true; });
  await row.locator('[data-testid=copy-invoice]:visible').click();
  await shows(id(page, 'toast'), `Copied ${sale.invoiceNo}`, 'copy fallback');
  assert.deepEqual(errors, []);
});

// ---- the phone works on its own, and phones and roles stay in step -----------------------------------
test('offline: a sale recorded with no connection waits, then reaches the cloud when the connection is back', async () => {
  const { page, call, context, errors } = await openApp('phone');
  const rice = await call('POST', '/api/items', { name: 'Rice 50kg', unit: 'bag', priceKobo: 5_000_000 });
  await call('POST', '/api/entries', { type: 'opening_stock', lines: [{ itemId: rice.id, qty: 10, unitPriceKobo: 4_000_000 }] });
  await pull(page);
  await context.setOffline(true);
  await id(page, 'add-tab').click();
  await id(page, 'f-item-0').selectOption({ label: 'Rice 50kg' });
  await id(page, 'f-qty-0').fill('3');
  await id(page, 'save').click();
  await shows(id(page, 'toast'), /^Saved · INV-/, 'saved with no connection');
  await syncNow(page); // tries, and quietly gives up
  assert.equal(await id(page, 'sync').count(), 0, 'sync status is not shown in the UI');
  assert.equal((await call('GET', '/api/entries')).data.length, 1, 'the cloud has not seen the sale yet');
  await context.setOffline(false);
  await syncNow(page);
  assert.equal((await call('GET', '/api/entries')).data.length, 2);
  assert.deepEqual(errors, []);
});

test('two phones on one business stay in step, and a deletion shows to everyone with who and why', async () => {
  const a = await openApp('phone');
  const { sale } = await seed(a.call);
  const b = await openApp('phone', { tenant: a.tenant }); // a second phone, same login
  await pull(a.page);
  await id(a.page, 'tab-entries').click();
  await id(a.page, 'entry-row').filter({ hasText: sale.invoiceNo }).click();
  await id(a.page, 'delete-entry').click();
  await id(a.page, 'd-reason').fill('wrong price');
  await id(a.page, 'confirm-delete').click();
  await shows(id(a.page, 'toast'), 'Entry deleted', 'deleted on the first phone');
  await syncNow(a.page);
  await pull(b.page);
  await id(b.page, 'tab-entries').click();
  await count(id(b.page, 'entry-row'), 5, 'the second phone no longer has the sale');
  await id(b.page, 'chip-deleted').click();
  await shows(page_list(b.page), /Rice 50kg × 2.*Deleted by Boss.*wrong price/, 'the deletion log, on the other phone');
  assert.deepEqual([...a.errors, ...b.errors], []);
});
const page_list = (page: Page) => page.locator('#elist');

test('staff: no profit anywhere, every kind of entry allowed, but not the boss\'s entries, people or items', async () => {
  const boss = await openApp('phone');
  const { sale } = await seed(boss.call);
  const { code } = await boss.call('POST', '/api/invites');
  const staff = await openApp('phone', { invite: code }); // opens the boss's invite link
  const p = staff.page;
  await id(p, 'hello').waitFor();
  await shows(id(p, 'sales'), '₦100,000', 'sales are shown');
  assert.equal(await id(p, 'profit').count(), 0, 'staff never see profit');
  await id(p, 'tab-entries').click();
  await count(id(p, 'entry-row'), 6, 'the same books as the boss');
  await id(p, 'entry-row').filter({ hasText: sale.invoiceNo }).click();
  assert.equal(await id(p, 'delete-entry').count(), 0, 'no delete on the boss\'s entry');
  assert.match(await text(id(p, 'no-delete')), /Only the boss/);
  assert.match(await text(id(p, 'detail')), /Recorded by Boss/);
  await id(p, 'panel-close').click();

  await id(p, 'add-tab').click(); // staff record an expense, and may delete what they recorded
  await id(p, 'type-expense').click();
  await id(p, 'f-amount').fill('500');
  await id(p, 'f-note').fill('Airtime');
  await id(p, 'save').click();
  await shows(id(p, 'toast'), /^Saved/, 'staff expense saved');
  await id(p, 'entry-row').filter({ hasText: 'Airtime' }).click();
  await id(p, 'delete-entry').click();
  await id(p, 'confirm-delete').click();
  await shows(id(p, 'toast'), 'Entry deleted', 'staff deleted their own entry');

  await id(p, 'tab-people').click();
  await id(p, 'person-row').first().click();
  await id(p, 'person-name').waitFor();
  assert.equal(await id(p, 'remove-person').count(), 0, 'only the boss removes people');
  await id(p, 'tab-inventory').click();
  await id(p, 'item-row').first().click();
  assert.equal(await id(p, 'remove-item').count(), 0, 'only the boss removes items');
  await id(p, 'panel-close').click();
  await id(p, 'tab-home').click();
  await id(p, 'avatar').click();
  await count(id(p, 'member-row'), 2, 'the boss and this staff member');
  assert.equal(await id(p, 'invite').count(), 0, 'only the boss invites');
  await syncNow(p);
  assert.equal((await boss.call('GET', '/api/entries')).data.length, 6, 'the boss sees the same books after sync');
  assert.deepEqual([...boss.errors, ...staff.errors], []);
});

test('a removed member\'s phone clears itself the next time it connects', async () => {
  const boss = await openApp('phone');
  const { code } = await boss.call('POST', '/api/invites');
  const staff = await openApp('phone', { invite: code });
  await id(staff.page, 'hello').waitFor();
  await boss.call('DELETE', `/api/members/${encodeURIComponent(staff.tenant)}`);
  await syncNow(staff.page);
  await id(staff.page, 'revoked').waitFor();
  const left = await staff.page.evaluate(async () => ({ dbs: (await indexedDB.databases()).map((d) => d.name ?? ''), user: localStorage.getItem('bk-user') }));
  assert.ok(!left.dbs.some((n) => n.startsWith('bk-')), 'the books are gone from the phone');
  assert.equal(left.user, null);
});

test('the app opens again with no connection at all, with the books still there', async () => {
  const { page, call, context, errors } = await openApp('phone', { sw: true });
  await call('POST', '/api/items', { name: 'Rice 50kg', unit: 'bag', priceKobo: 5_000_000 });
  await pull(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
  await context.setOffline(true);
  await page.reload();
  await id(page, 'hello').waitFor();
  await id(page, 'tab-inventory').click();
  await shows(id(page, 'item-row'), /Rice 50kg/, 'the item is still there');
  assert.deepEqual(errors, []);
});