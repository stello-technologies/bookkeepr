'use strict';
/* The books on the phone: the same rules and reports as the server, answering the same requests from local records.
   Nothing here touches the page, so Node can run it too: the tests compare its numbers with the server's. */
(function () {
  const DAY = 86_400_000;
  const PAGE = 100;
  const MAX_FUTURE = DAY; // a phone clock may run a little fast, but an entry cannot be for tomorrow
  const TYPES = ['sale', 'purchase', 'expense', 'payment_in', 'payment_out', 'opening_stock'];
  const LINE_TYPES = ['sale', 'purchase', 'opening_stock'];
  const PARTY_TYPES = ['sale', 'purchase', 'payment_in', 'payment_out'];
  const STOCK_TYPES = ['opening_stock', 'purchase', 'sale'];
  const WINDOWS = { day: 1, week: 7, month: 30 }; // rolling: the last 24h / 7d / 30d
  const KINDS = ['parties', 'items', 'entries'];
  const ACTION = { parties: 'remove_party', items: 'remove_item', entries: 'delete_entry' };
  const HEX24 = /^[a-f0-9]{24}$/i;

  const round = (n) => Math.round(n * 1e6) / 1e6; // tidy float quantities
  const words = (...parts) => [...new Set(parts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const fail = (status, code, message = code) => { throw Object.assign(new Error(message), { status, code }); };
  const bad = (message = 'invalid input') => fail(400, 'validation', message);
  const isKobo = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0; // whole kobo, never negative
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const iso = (ms) => new Date(ms).toISOString();
  const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD in Lagos

  // Like the server's ids: 4 bytes of time, 5 random bytes fixed for this phone, then a counter.
  // So ids made on one phone sort in the order they were made, even within the same second.
  const phoneBytes = crypto.getRandomValues(new Uint8Array(5));
  let counter = crypto.getRandomValues(new Uint8Array(3)).reduce((n, b) => n * 256 + b, 0);
  function newId(ms = Date.now()) {
    counter = (counter + 1) % 0x1000000;
    return Math.floor(ms / 1000).toString(16).padStart(8, '0') + hex(phoneBytes) + counter.toString(16).padStart(6, '0');
  }

  /** What one entry does to a party's balances: [customer owes you, you owe supplier]. */
  function effect(type, total, paid) {
    switch (type) {
      case 'sale': return [total - paid, 0];
      case 'payment_in': return [-total, 0];
      case 'purchase': return [0, total - paid];
      case 'payment_out': return [0, -total];
      default: return [0, 0];
    }
  }

  function create(store) {
    const mem = { parties: new Map(), items: new Map(), entries: new Map() };
    let session = { userId: '', role: 'staff', accountId: '', name: '', members: [], cursor: 0, offset: 0, deviceId: '', rejected: [] };
    const handlers = { local: [], remote: [] };
    let searchCache = new Map();

    const now = () => Date.now() + session.offset; // the server's clock, as best this phone knows it
    const emit = (name) => handlers[name].forEach((f) => { try { f(); } catch (e) { console.error(e); } });
    const view = (r) => { const { pending, pendingDelete, pendingUpdate, ...rest } = r; return rest; };
    const dateMs = (e) => Date.parse(e.date);
    const live = (r) => !r.deleted;
    const idDesc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

    // ---- permissions: the same rulebook as the server ----------------------------------
    const can = (action, rec) => session.role === 'boss' || (action === 'delete_entry' && !!rec && rec.createdBy === session.userId);
    const need = (action, rec) => { if (!can(action, rec)) fail(403, 'not_allowed', 'only the boss can do that'); };

    // ---- search: each typed word must be the start of a stored word ----------------------
    function wordsOf(kind, r) {
      const key = kind + r.id;
      let w = searchCache.get(key);
      if (!w) {
        if (kind === 'parties') w = words(r.name, r.phone);
        else if (kind === 'items') w = words(r.name);
        else {
          const p = r.partyId && mem.parties.get(r.partyId);
          const names = (r.lines || []).map((l) => (mem.items.get(l.itemId) || {}).name || '').join(' ');
          w = words(r.invoiceNo, r.type, p ? p.name : '', names, r.note);
        }
        searchCache.set(key, w);
      }
      return w;
    }
    const matches = (kind, r, typed) => typed.every((t) => wordsOf(kind, r).some((w) => w.startsWith(t)));

    // ---- reports (every number is worked out from entries, on request) -----------------
    function balances() {
      const all = { owesYouKobo: 0, youOweKobo: 0 };
      const byParty = new Map();
      for (const e of mem.entries.values()) {
        if (e.deleted || !['sale', 'payment_in', 'purchase', 'payment_out'].includes(e.type)) continue;
        const [owes, owed] = effect(e.type, e.totalKobo, e.paidKobo);
        all.owesYouKobo += owes;
        all.youOweKobo += owed;
        if (!e.partyId) continue;
        const b = byParty.get(e.partyId) || { owesYouKobo: 0, youOweKobo: 0 };
        b.owesYouKobo += owes;
        b.youOweKobo += owed;
        byParty.set(e.partyId, b);
      }
      return { all, byParty };
    }

    /** Quantity in / out per item id, for entries whose date passes `inRange`. */
    function moves(inRange, itemId) {
      const byItem = new Map();
      for (const e of mem.entries.values()) {
        if (e.deleted || !STOCK_TYPES.includes(e.type) || !inRange(dateMs(e))) continue;
        for (const l of e.lines || []) {
          if (itemId && l.itemId !== itemId) continue;
          const m = byItem.get(l.itemId) || { in: 0, out: 0 };
          if (e.type === 'sale') m.out += l.qty; else m.in += l.qty;
          byItem.set(l.itemId, m);
        }
      }
      return byItem;
    }
    const stockByItem = () => new Map([...moves(() => true)].map(([id, m]) => [id, round(m.in - m.out)]));

    function summary(win) {
      if (!WINDOWS[win]) bad();
      const from = now() - WINDOWS[win] * DAY;
      const totals = {};
      const sold = new Map();
      const bought = new Map();
      for (const e of mem.entries.values()) {
        if (e.deleted) continue;
        if (dateMs(e) >= from) {
          totals[e.type] = (totals[e.type] || 0) + e.totalKobo;
          if (e.type === 'sale') for (const l of e.lines || []) sold.set(l.itemId, (sold.get(l.itemId) || 0) + l.qty);
        }
        if (e.type === 'purchase' || e.type === 'opening_stock') {
          for (const l of e.lines || []) {
            const b = bought.get(l.itemId) || { cost: 0, qty: 0 };
            b.cost += l.totalKobo;
            b.qty += l.qty;
            bought.set(l.itemId, b);
          }
        }
      }
      // Cost of goods sold = qty sold x average cost of that item (all purchases + opening stock).
      let cogs = 0;
      for (const [id, qty] of sold) { const b = bought.get(id); cogs += qty * (b && b.qty ? b.cost / b.qty : 0); }
      cogs = Math.round(cogs);
      const sales = totals.sale || 0, expenses = totals.expense || 0;
      const { all } = balances();
      const out = {
        window: win, from: iso(from), to: iso(now()),
        salesKobo: sales, purchasesKobo: totals.purchase || 0, expensesKobo: expenses,
        cogsKobo: cogs, profitKobo: sales - cogs - expenses,
        owedToYouKobo: all.owesYouKobo, youOweKobo: all.youOweKobo, // all-time, not just this window
      };
      if (session.role !== 'boss') { delete out.cogsKobo; delete out.profitKobo; } // only the boss sees profit
      return out;
    }

    function statement(q) {
      const kind = q.kind;
      if (!['sales', 'stock', 'party'].includes(kind)) bad();
      const from = Date.parse(q.from), to = Date.parse(q.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) bad();
      if (!(from < to)) fail(400, 'bad_range', 'from must be before to');
      if (to - from > 30 * DAY) fail(400, 'range_too_long', 'a statement covers at most 30 days');

      if (kind === 'sales') { // one row per day (Lagos time)
        const days = new Map();
        for (const s of [...mem.entries.values()].filter((e) => !e.deleted && e.type === 'sale' && dateMs(e) >= from && dateMs(e) < to)) {
          const day = dayOf(dateMs(s));
          const d = days.get(day) || { day, count: 0, totalKobo: 0, paidKobo: 0, outstandingKobo: 0 };
          d.count += 1; d.totalKobo += s.totalKobo; d.paidKobo += s.paidKobo; d.outstandingKobo += s.totalKobo - s.paidKobo;
          days.set(day, d);
        }
        return { kind, from: iso(from), to: iso(to), rows: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)) };
      }

      if (kind === 'stock') { // per item: before the period, what came in, what went out, what is left
        const itemId = q.itemId ? String(q.itemId).toLowerCase() : undefined;
        const list = [...mem.items.values()].filter((i) => live(i) && (!itemId || i.id === itemId)).sort((a, b) => a.name.localeCompare(b.name));
        const before = moves((t) => t < from, itemId);
        const during = moves((t) => t >= from && t < to, itemId);
        return {
          kind, from: iso(from), to: iso(to), rows: list.map((it) => {
            const b = before.get(it.id) || { in: 0, out: 0 }, d = during.get(it.id) || { in: 0, out: 0 };
            const opening = round(b.in - b.out);
            return { itemId: it.id, name: it.name, unit: it.unit, opening, in: round(d.in), out: round(d.out), closing: round(opening + d.in - d.out) };
          }),
        };
      }

      // party: entries in the period, balance brought forward, running balance
      if (!q.partyId) fail(400, 'party_required', 'partyId is required for a party statement');
      const party = mem.parties.get(String(q.partyId).toLowerCase());
      if (!party || party.deleted) fail(404, 'party_not_found');
      const history = [...mem.entries.values()].filter((e) => !e.deleted && e.partyId === party.id && dateMs(e) < to)
        .sort((a, b) => dateMs(a) - dateMs(b) || (a.id < b.id ? -1 : 1));
      let owes = 0, owed = 0, broughtForward = { owesYouKobo: 0, youOweKobo: 0 };
      const rows = [];
      for (const e of history) {
        const [o, w] = effect(e.type, e.totalKobo, e.paidKobo);
        owes += o; owed += w;
        if (dateMs(e) < from) broughtForward = { owesYouKobo: owes, youOweKobo: owed };
        else rows.push({ ...view(e), owesYouKobo: owes, youOweKobo: owed });
      }
      return { kind, party: { id: party.id, name: party.name }, from: iso(from), to: iso(to), broughtForward, rows, closing: { owesYouKobo: owes, youOweKobo: owed } };
    }

    // ---- lists ---------------------------------------------------------------------------
    function byIdPage(rows, cursor) { // newest id first; `next` is the cursor for the following page
      rows.sort(idDesc);
      if (cursor) rows = rows.filter((r) => r.id < String(cursor).toLowerCase());
      const out = rows.slice(0, PAGE);
      return { rows: out, next: rows.length > PAGE ? out[PAGE - 1].id : null };
    }
    function entryPage(rows, cursor) { // newest DATE first, so a backdated entry sits where its date says
      rows.sort((a, b) => dateMs(b) - dateMs(a) || idDesc(a, b));
      if (cursor) {
        const m = String(cursor).match(/^(\d+)_([a-f0-9]{24})$/i);
        if (!m) fail(400, 'bad_cursor');
        const d = Number(m[1]), id = m[2].toLowerCase();
        rows = rows.filter((e) => dateMs(e) < d || (dateMs(e) === d && e.id < id));
      }
      const out = rows.slice(0, PAGE), last = out[PAGE - 1];
      return { rows: out, next: rows.length > PAGE ? `${dateMs(last)}_${last.id}` : null };
    }
    const typedWords = (q) => (q ? words(q) : []);

    function listParties(q) {
      const typed = typedWords(q.q);
      const { rows, next } = byIdPage([...mem.parties.values()].filter((p) => live(p) && matches('parties', p, typed)), q.cursor);
      const { byParty } = balances();
      return { data: rows.map((p) => ({ ...view(p), ...(byParty.get(p.id) || { owesYouKobo: 0, youOweKobo: 0 }) })), next };
    }
    function listItems(q) {
      const typed = typedWords(q.q);
      const { rows, next } = byIdPage([...mem.items.values()].filter((i) => live(i) && matches('items', i, typed)), q.cursor);
      const stock = stockByItem();
      return { data: rows.map((i) => ({ ...view(i), stock: stock.get(i.id) || 0 })), next };
    }
    function listEntries(q) {
      const types = q.type ? String(q.type).split(',') : null;
      if (types && (!types.length || types.some((t) => !TYPES.includes(t)))) bad();
      const from = q.from ? Date.parse(q.from) : null, to = q.to ? Date.parse(q.to) : null;
      if ((q.from && !Number.isFinite(from)) || (q.to && !Number.isFinite(to))) bad();
      const typed = typedWords(q.q);
      const rows = [...mem.entries.values()].filter((e) => live(e)
        && (!types || types.includes(e.type))
        && (!q.partyId || e.partyId === String(q.partyId).toLowerCase())
        && (!q.itemId || (e.lines || []).some((l) => l.itemId === String(q.itemId).toLowerCase()))
        && (from === null || dateMs(e) >= from) && (to === null || dateMs(e) < to)
        && matches('entries', e, typed));
      const page = entryPage(rows, q.cursor);
      return { data: page.rows.map(view), next: page.next };
    }
    /** Everything that was deleted, newest deletion first, for the "Deleted" list that every member can see. */
    function listDeleted() {
      const out = [];
      for (const kind of KINDS) for (const r of mem[kind].values()) if (r.deleted) out.push({ kind, ...view(r) });
      out.sort((a, b) => Date.parse(b.deletedAt || 0) - Date.parse(a.deletedAt || 0));
      return { data: out.slice(0, 300) };
    }

    // ---- analytics: four answers worked out from the entries on this phone ------------------------------
    function analytics(q) {
      need('manage'); // boss only, like profit
      const win = q.window || 'month';
      if (!WINDOWS[win]) bad();
      const from = now() - WINDOWS[win] * DAY;
      const sales = [...mem.entries.values()].filter((e) => !e.deleted && e.type === 'sale' && dateMs(e) >= from);
      const biggest = (rows) => rows.sort((x, y) => y.kobo - x.kobo || String(x.name).localeCompare(String(y.name)))[0] || null;
      const gonePerson = (id) => !mem.parties.get(id) || mem.parties.get(id).deleted;
      const personName = (id) => (mem.parties.get(id) || {}).name || 'Removed person';

      // top product: the one that brought in the most money (money, because bags and litres cannot be added up)
      const byItem = new Map();
      for (const e of sales) for (const l of e.lines || []) { const b = byItem.get(l.itemId) || { qty: 0, kobo: 0 }; b.qty += l.qty; b.kobo += l.totalKobo; byItem.set(l.itemId, b); }
      const topProduct = biggest([...byItem].map(([id, b]) => { const it = mem.items.get(id); return { id, name: it ? it.name : 'Removed item', unit: it ? it.unit : '', qty: round(b.qty), kobo: b.kobo, gone: !it || it.deleted }; }));

      // best customer: who bought the most (walk-in sales have no customer)
      const byParty = new Map();
      for (const e of sales) if (e.partyId) { const b = byParty.get(e.partyId) || { kobo: 0, count: 0 }; b.kobo += e.totalKobo; b.count++; byParty.set(e.partyId, b); }
      const bestCustomer = biggest([...byParty].map(([id, b]) => ({ id, name: personName(id), kobo: b.kobo, count: b.count, gone: gonePerson(id) })));

      // average sale: the average value of one sale in the period, walk-ins included
      const total = sales.reduce((n, e) => n + e.totalKobo, 0);
      const avgSale = { kobo: sales.length ? Math.round(total / sales.length) : null, count: sales.length };

      // leading debts: who owes you the most right now (not limited to the period)
      const debts = [...balances().byParty].filter(([, b]) => b.owesYouKobo > 0)
        .map(([id, b]) => ({ id, name: personName(id), kobo: b.owesYouKobo, gone: gonePerson(id) }))
        .sort((x, y) => y.kobo - x.kobo || String(x.name).localeCompare(String(y.name))).slice(0, 5);

      return { window: win, topProduct, bestCustomer, avgSale, debts };
    }

    // ---- creating and deleting (saved on the phone at once; sent to the cloud when there is a connection) ----
    const stampOf = () => ({ deleted: false, createdBy: session.userId, deviceId: session.deviceId, receivedAt: iso(now()), pending: true });
    async function save(kind, rec) { mem[kind].set(rec.id, rec); searchCache = new Map(); await store.put(kind, rec); emit('local'); return view(rec); }

    async function addParty(b) {
      b = b || {};
      const name = typeof b.name === 'string' ? b.name.trim() : '', phone = b.phone === undefined ? '' : typeof b.phone === 'string' ? b.phone.trim() : null;
      if (!name || name.length > 100 || phone === null || phone.length > 30) bad();
      return save('parties', { id: newId(now()), name, phone, createdAt: iso(now()), ...stampOf() });
    }
    async function addItem(b) {
      b = b || {};
      const name = typeof b.name === 'string' ? b.name.trim() : '', unit = typeof b.unit === 'string' ? b.unit.trim() : '';
      if (!name || name.length > 100 || !unit || unit.length > 20 || !isKobo(b.priceKobo)) bad();
      return save('items', { id: newId(now()), name, unit, priceKobo: b.priceKobo, createdAt: iso(now()), ...stampOf() });
    }
    async function addEntry(b) {
      b = b && typeof b === 'object' ? b : {};
      if (!TYPES.includes(b.type)) bad();
      const note = b.note === undefined ? '' : b.note;
      if (typeof note !== 'string' || note.length > 500) bad();
      let date = now();
      if (b.date !== undefined) {
        const d = Date.parse(b.date);
        if (!Number.isFinite(d) || d < Date.parse('2000-01-01')) bad();
        if (d > now() + MAX_FUTURE) bad('date is in the future');
        date = d;
      }
      const e = { id: newId(now()), type: b.type, note, date: iso(date) };

      if (PARTY_TYPES.includes(b.type) && b.partyId !== undefined && b.partyId !== '') {
        if (typeof b.partyId !== 'string' || !HEX24.test(b.partyId)) bad();
        const p = mem.parties.get(b.partyId.toLowerCase());
        if (!p || p.deleted) fail(404, 'party_not_found');
        e.partyId = p.id;
      } else if (b.type === 'payment_in' || b.type === 'payment_out') bad(); // payments need a person

      if (LINE_TYPES.includes(b.type)) {
        if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 50) bad();
        e.lines = b.lines.map((l) => {
          if (!l || typeof l.itemId !== 'string' || !HEX24.test(l.itemId)) bad();
          if (typeof l.qty !== 'number' || !Number.isFinite(l.qty) || l.qty <= 0 || !isKobo(l.unitPriceKobo)) bad();
          const it = mem.items.get(l.itemId.toLowerCase());
          if (!it || it.deleted) fail(404, 'item_not_found');
          // No stock check: shops sell before they record stock, and record stock after the fact. Short stock shows as negative.
          return { itemId: it.id, qty: l.qty, unitPriceKobo: l.unitPriceKobo, totalKobo: Math.round(l.qty * l.unitPriceKobo) };
        });
        e.totalKobo = e.lines.reduce((sum, l) => sum + l.totalKobo, 0);
      } else {
        if (!isKobo(b.totalKobo) || b.totalKobo < 1) bad();
        e.totalKobo = b.totalKobo;
      }
      if (!Number.isSafeInteger(e.totalKobo)) fail(400, 'total_too_large');

      // "Paid now" defaults to the full total; only sales and purchases can be part-paid.
      const paid = (b.type === 'sale' || b.type === 'purchase') && b.paidKobo !== undefined ? b.paidKobo : e.totalKobo;
      if (!isKobo(paid)) bad();
      if (paid > e.totalKobo) fail(400, 'paid_exceeds_total', 'paidKobo cannot be more than the total');
      e.paidKobo = paid;

      const taken = new Set([...mem.entries.values()].map((x) => x.invoiceNo));
      do { const r = new Uint8Array(5); crypto.getRandomValues(r); e.invoiceNo = 'INV-' + hex(r).toUpperCase(); } while (taken.has(e.invoiceNo));
      return save('entries', { ...e, ...stampOf() });
    }

    /** The boss changes an item's price. Saved on the phone at once, sent as an update; past entries keep their own prices. */
    async function updateItem(id, b) {
      b = b || {};
      const rec = HEX24.test(String(id)) ? mem.items.get(String(id).toLowerCase()) : null;
      if (!rec || rec.deleted) fail(404, 'not_found');
      need('manage', rec);
      if (!isKobo(b.priceKobo)) bad();
      if (rec.priceKobo === b.priceKobo) return view(rec);
      Object.assign(rec, { priceKobo: b.priceKobo, pendingUpdate: true }); // always flagged: it may be mid-send as a create with the old price
      return save('items', rec);
    }

    async function remove(kind, id, reason) {
      const rec = HEX24.test(id) ? mem[kind].get(id.toLowerCase()) : null;
      if (!rec) fail(404, 'not_found');
      need(ACTION[kind], rec);
      if (rec.deleted) fail(404, 'not_found');
      Object.assign(rec, { deleted: true, deletedAt: iso(now()), deletedBy: session.userId, deletedReason: String(reason || '').slice(0, 200), pendingDelete: true });
      await save(kind, rec);
      return { id: rec.id, deleted: true };
    }

    // ---- the same requests the server answers, so the screens do not change ------------------
    async function request(method, path, body) {
      const [p, qs = ''] = path.split('?');
      const q = Object.fromEntries(new URLSearchParams(qs));
      const seg = p.split('/').filter(Boolean); // ['api', 'entries', id?]
      if (seg[0] !== 'api') fail(404, 'not_found');
      const [, what, id] = seg;
      if (method === 'GET') {
        if (what === 'parties') return listParties(q);
        if (what === 'items') return listItems(q);
        if (what === 'entries') return listEntries(q);
        if (what === 'summary') return summary(q.window || 'month');
        if (what === 'statements') return statement(q);
        if (what === 'deleted') return listDeleted();
        if (what === 'analytics') return analytics(q);
      }
      if (method === 'POST') {
        if (what === 'parties') return addParty(body);
        if (what === 'items') return addItem(body);
        if (what === 'entries') return addEntry(body);
      }
      if (method === 'PATCH' && what === 'items' && id) return updateItem(id, body);
      if (method === 'DELETE' && id && KINDS.includes(what)) return remove(what, id, q.reason);
      return fail(404, 'not_found');
    }

    // ---- sync: what to send, and how to fold in what comes back ---------------------------------
    const wire = {
      parties: (r) => ({ id: r.id, name: r.name, phone: r.phone }),
      items: (r) => ({ id: r.id, name: r.name, unit: r.unit, priceKobo: r.priceKobo }),
      entries: (r) => ({
        id: r.id, type: r.type, note: r.note, date: r.date, invoiceNo: r.invoiceNo,
        ...(r.lines ? { lines: r.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitPriceKobo: l.unitPriceKobo })) } : { totalKobo: r.totalKobo }),
        ...(r.partyId ? { partyId: r.partyId } : {}),
        ...(r.type === 'sale' || r.type === 'purchase' ? { paidKobo: r.paidKobo } : {}),
      }),
    };
    function pending(limit = 500) {
      const body = { parties: [], items: [], entries: [], deletes: [], updates: [] };
      const sent = { creates: new Set(), deletes: new Set(), updates: new Map() }; // updates: id -> the price that was sent
      let n = 0;
      for (const kind of KINDS) {
        const recs = [...mem[kind].values()].filter((r) => r.pending || r.pendingDelete || r.pendingUpdate).sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1));
        for (const r of recs) {
          if (n >= limit) break;
          if (r.pending) { body[kind].push(wire[kind](r)); sent.creates.add(r.id); n++; }
          if (r.pendingUpdate && !r.deleted && n < limit) { body.updates.push({ id: r.id, priceKobo: r.priceKobo }); sent.updates.set(r.id, r.priceKobo); n++; }
          if (r.pendingDelete && n < limit) { body.deletes.push({ kind, id: r.id, reason: r.deletedReason || '' }); sent.deletes.add(r.id); n++; }
        }
      }
      return { body, sent };
    }
    const pendingCount = () => KINDS.reduce((n, k) => n + [...mem[k].values()].filter((r) => r.pending || r.pendingDelete || r.pendingUpdate).length, 0);

    /** Fold the server's answer in. Records the server has are its truth; a delete always wins. */
    async function applySync(res, sent, offset) {
      const refused = new Map(res.rejected.filter((r) => !r.kind).map((r) => [r.id, r.code]));
      const refusedUpdates = new Map(res.rejected.filter((r) => r.kind === 'update').map((r) => [r.id, r.code]));
      const touched = { parties: [], items: [], entries: [] };
      for (const kind of KINDS) {
        for (const r of [...mem[kind].values()]) {
          if (sent.creates.has(r.id) && r.pending) {
            if (refused.has(r.id)) { // the server refused it: take it off the books and remember why
              mem[kind].delete(r.id); await store.del(kind, r.id);
              session.rejected = [...(session.rejected || []), { kind, id: r.id, code: refused.get(r.id) }].slice(-50);
              continue;
            }
            r.pending = false; touched[kind].push(r);
          }
          if (sent.updates && sent.updates.has(r.id) && r.pendingUpdate) {
            if (refusedUpdates.has(r.id)) session.rejected = [...(session.rejected || []), { kind, id: r.id, code: refusedUpdates.get(r.id) }].slice(-50); // not allowed or item gone: stop resending
            // edited again while this was on its way: keep it pending, it goes in the next round
            if (refusedUpdates.has(r.id) || r.priceKobo === sent.updates.get(r.id)) r.pendingUpdate = false;
            touched[kind].push(r);
          }
          if (sent.deletes.has(r.id) && r.pendingDelete) {
            if (refused.has(r.id) && !sent.creates.has(r.id)) { // e.g. not allowed: put it back
              Object.assign(r, { deleted: false, pendingDelete: false }); delete r.deletedAt; delete r.deletedBy; delete r.deletedReason;
            } else r.pendingDelete = false;
            touched[kind].push(r);
          }
        }
      }
      for (const kind of KINDS) {
        for (const s of res.changes[kind]) {
          const local = mem[kind].get(s.id);
          let next = { ...s };
          if (local && local.pendingDelete && !s.deleted) { // our delete has not reached the server yet: keep it
            next = { ...s, deleted: true, deletedAt: local.deletedAt, deletedBy: local.deletedBy, deletedReason: local.deletedReason, pendingDelete: true };
          }
          if (local && local.pendingUpdate && !s.deleted) next = { ...next, priceKobo: local.priceKobo, pendingUpdate: true }; // our price edit has not reached the server yet: keep it
          mem[kind].set(s.id, next);
          touched[kind].push(next);
        }
        const unique = [...new Map(touched[kind].map((r) => [r.id, r])).values()];
        if (unique.length) await store.putMany(kind, unique);
      }
      searchCache = new Map();
      session = { ...session, userId: res.userId || session.userId, role: res.role, accountId: res.accountId || session.accountId, name: res.name, members: res.members, cursor: Math.max(session.cursor, res.cursor), offset: Number.isFinite(offset) ? offset : session.offset };
      await store.setMeta('session', session);
      if (res.changes.parties.length + res.changes.items.length + res.changes.entries.length) emit('remote');
    }

    async function load() {
      for (const kind of KINDS) for (const r of await store.all(kind)) mem[kind].set(r.id, r);
      const m = await store.getMeta('session');
      if (m) session = { ...session, ...m };
    }
    async function setSession(patch) { session = { ...session, ...patch }; await store.setMeta('session', session); }
    async function wipe() { KINDS.forEach((k) => mem[k].clear()); searchCache = new Map(); await store.clear(); session = { ...session, role: 'staff', cursor: 0, members: [], name: '' }; }

    return {
      load, request, now, can, wipe, pending, pendingCount, applySync, setSession,
      session: () => ({ ...session }),
      on: (name, fn) => handlers[name].push(fn),
    };
  }

  globalThis.Engine = { create, newId, words };
})();
