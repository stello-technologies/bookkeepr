'use strict';
/* The add-entry form: one form, with only the fields each entry type needs.
   Sales, purchases and opening stock are invoices with one or more item lines. */

let F = null; // the entry being filled in
const FORMS = {
  sale: { chip: 'Sale', party: 'Customer (optional)', lines: true, paid: true, price: 'Price each (₦)', save: 'Save sale' },
  purchase: { chip: 'Bought', party: 'Supplier (optional)', lines: true, paid: true, price: 'Cost each (₦)', save: 'Save purchase' },
  expense: { chip: 'Expense', amount: 'Amount (₦)', note: 'What was it for?', save: 'Save expense' },
  payment_in: { chip: 'Money in', party: 'Customer', need: true, amount: 'Amount received (₦)', save: 'Save payment' },
  payment_out: { chip: 'Money out', party: 'Supplier', need: true, amount: 'Amount paid (₦)', save: 'Save payment' },
  opening_stock: { chip: 'Opening stock', lines: true, price: 'Cost each (₦)', save: 'Save stock', hint: 'Stock you already have on the shelf. It counts for stock and cost, not as a purchase.' },
};
const blankLine = () => ({ itemId: '', qty: '', price: '' });
const newForm = (type = 'sale', keep = {}) => ({ type, partyId: '', lines: [blankLine()], paid: '', paidTouched: false, amount: '', note: '', busy: false, pendingLine: 0, ...keep });

function openForm(preset = {}) {
  F = newForm(preset.type || 'sale', preset);
  renderForm();
}

function renderForm() {
  const c = FORMS[F.type];
  const field = (id, label, val, ph = '', mode = 'decimal') => `<div class="f"><label for="${id}">${label}</label><input class="in" id="${id}" data-testid="${id}" inputmode="${mode}" autocomplete="off" placeholder="${ph}" value="${esc(val)}"></div>`;
  const options = (list, val) => list.map((o) => `<option value="${esc(o.id)}" ${o.id === val ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const partySelect = () => `<div class="f"><label for="f-party">${c.party}</label><div class="selrow"><select class="in" id="f-party" data-testid="f-party"><option value="">${c.need ? 'Choose…' : 'Walk-in / none'}</option>${options(S.parties, F.partyId)}</select><button type="button" class="mini" data-act="new-person-in-form" data-testid="f-party-new">+ New</button></div></div>`;
  const lineHtml = (l, i) => `<div class="line" data-testid="line-${i}">
    <div class="f"><label for="f-item-${i}">${F.lines.length > 1 ? `Item ${i + 1}` : 'Item'}</label>
      <div class="selrow"><select class="in" id="f-item-${i}" data-testid="f-item-${i}"><option value="">Choose…</option>${options(S.items, l.itemId)}</select>
      <button type="button" class="mini" data-act="new-item-in-form" data-line="${i}" data-testid="f-item-${i}-new">+ New</button></div>
      <div class="hint" id="f-stock-${i}"></div></div>
    <div class="pair">${field(`f-qty-${i}`, 'Quantity', l.qty, '0')}${field(`f-price-${i}`, c.price, l.price, '0')}</div>
    <div class="lt"><span>Line total <b id="f-lt-${i}" data-testid="f-lt-${i}">₦0</b></span>${F.lines.length > 1 ? `<button type="button" class="link danger" data-act="remove-line" data-line="${i}" data-testid="remove-line-${i}">Remove</button>` : ''}</div></div>`;
  openPanel(panelHtml('New entry', `
    <div class="seg" role="group" aria-label="Entry type">${Object.entries(FORMS).map(([k, v]) => `<button class="chip ${k === F.type ? 'on' : ''}" data-act="type" data-type="${k}" data-testid="type-${k}">${v.chip}</button>`).join('')}</div>
    ${c.hint ? `<p class="hint" style="margin:-6px 0 12px">${esc(c.hint)}</p>` : ''}
    ${c.party ? partySelect() : ''}
    ${c.lines ? `${F.lines.map(lineHtml).join('')}<button type="button" class="addline" data-act="add-line" data-testid="add-line">+ Add another item</button>
      <div class="total"><span>Total</span><b id="f-total" data-testid="total">₦0</b></div>` : ''}
    ${c.amount ? field('f-amount', c.amount, F.amount, '0') : ''}
    ${c.paid ? `<div class="pair">${field('f-paid', 'Paid now (₦)', F.paid, '0')}<div class="f"><label>Date</label><div class="in ro" data-testid="f-date">Today</div></div></div>` : ''}
    <div class="owe" id="f-owe" data-testid="owe"></div>
    ${field('f-note', c.note || 'Note (optional)', F.note, 'Add a note', 'text')}
    <div class="err" id="f-err" role="alert" data-testid="f-err"></div>
    <button class="save" id="f-save" data-act="save-entry" data-testid="save" disabled>${c.save}</button>`));
  derive();
}

/** Re-work totals, the "will owe" line, the error and the Save button from what has been typed. Does not touch the inputs' focus. */
function derive() {
  const c = FORMS[F.type];
  const lineTotals = F.lines.map((l) => { const q = parseQty(l.qty), u = parseMoney(l.price); return Number.isFinite(q) && Number.isFinite(u) ? Math.round(q * u) : NaN; });
  const total = c.lines ? (lineTotals.every(Number.isFinite) ? lineTotals.reduce((a, b) => a + b, 0) : NaN) : parseMoney(F.amount);
  if (c.paid && !F.paidTouched) { F.paid = Number.isFinite(total) ? inputMoney(total) : ''; if ($('#f-paid')) $('#f-paid').value = F.paid; }
  const paid = c.paid ? parseMoney(F.paid) : total;
  const p = party(F.partyId);
  let err = '', owe = '', oweRed = false, ready = true;

  if (c.need && !F.partyId) ready = false;
  if (c.lines && F.lines.some((l) => !l.itemId)) ready = false;
  if (!Number.isFinite(total) || (!c.lines && total <= 0)) ready = false;
  if (c.paid && !Number.isFinite(paid)) ready = false;
  if (Number.isFinite(total) && total > Number.MAX_SAFE_INTEGER / 2) { err = 'That amount is too large'; ready = false; }
  if (c.paid && Number.isFinite(paid) && Number.isFinite(total) && paid > total) { err = "Paid can't be more than the total"; ready = false; }
  if (F.type === 'sale') { // what is wanted, per item, across every line, must be on the shelf
    const want = new Map();
    F.lines.forEach((l) => { const q = parseQty(l.qty); if (l.itemId && Number.isFinite(q)) want.set(l.itemId, (want.get(l.itemId) || 0) + q); });
    for (const [id, q] of want) { const it = item(id); if (it && q > it.stock) { err = `Only ${num(it.stock)} ${plural(it.unit, it.stock)} of ${it.name} in stock`; ready = false; break; } }
  }

  if (c.paid && Number.isFinite(total) && Number.isFinite(paid) && paid < total) {
    const left = money(total - paid);
    oweRed = true;
    owe = F.type === 'sale' ? (p ? `${p.name} will owe ${left}` : `${left} unpaid. Pick a customer so you can follow it up`) : (p ? `You will owe ${p.name} ${left}` : `${left} unpaid. Pick a supplier to keep track of it`);
  }
  if (c.need && p && Number.isFinite(total) && total > 0) {
    const had = F.type === 'payment_in' ? p.owesYouKobo : p.youOweKobo;
    owe = F.type === 'payment_in' ? `${p.name} owes you ${money(had)}. ` : `You owe ${p.name} ${money(had)}. `;
    owe += total > had ? `The extra ${money(total - had)} is kept as a credit.` : `${money(had - total)} left after this.`;
  }
  F.lines.forEach((l, i) => {
    const it = item(l.itemId);
    if ($(`#f-stock-${i}`)) $(`#f-stock-${i}`).textContent = it ? `In stock: ${num(it.stock)} ${plural(it.unit, it.stock)}` : '';
    if ($(`#f-lt-${i}`)) $(`#f-lt-${i}`).textContent = Number.isFinite(lineTotals[i]) ? money(lineTotals[i]) : '₦0';
  });
  if ($('#f-total')) $('#f-total').textContent = Number.isFinite(total) ? money(total) : '₦0';
  const o = $('#f-owe'); if (o) { o.textContent = owe; o.classList.toggle('red', oweRed); }
  const e = $('#f-err'); if (e) e.textContent = err;
  const b = $('#f-save'); if (b) b.disabled = !ready || F.busy;
  return { total, paid, ready };
}

function formBody() {
  const c = FORMS[F.type];
  const { total, paid } = derive();
  const body = { type: F.type, note: F.note.trim() };
  if (c.lines) body.lines = F.lines.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty), unitPriceKobo: parseMoney(l.price) }));
  else body.totalKobo = total;
  if (c.party && F.partyId) body.partyId = F.partyId;
  if (c.paid) body.paidKobo = paid;
  return body;
}

async function saveEntry() {
  if (F.busy) return;
  F.busy = true; derive();
  try {
    const saved = await api('POST', '/api/entries', formBody());
    await refreshLists();
    closePanel();
    toast(`Saved · ${saved.invoiceNo}`);
    route();
  } catch (e) { F.busy = false; derive(); $('#f-err').textContent = fail(e); }
}
