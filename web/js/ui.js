'use strict';
/* Shared UI pieces: toast, empty state, the panel (bottom sheet / side column), and the entry row used by Home and Entries. */

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 3000);
}
const empty = (title, text) => `<div class="empty" data-testid="empty"><b>${esc(title)}</b>${esc(text)}</div>`;
const main = (html) => { $('#main').innerHTML = html; };
const loading = () => main('<div class="view"><p class="muted" data-testid="loading">Loading…</p></div>');
const openPanel = (html) => { const p = $('#panel'); p.innerHTML = html; p.hidden = false; $('#dim').hidden = false; p.scrollTop = 0; };
function closePanel() { $('#panel').hidden = true; $('#dim').hidden = true; $('#panel').innerHTML = ''; F = null; }
const panelHtml = (title, body, close = 'Cancel') => `<div class="grab"></div><div class="head"><b>${esc(title)}</b><button data-act="close" data-testid="panel-close">${close}</button></div>${body}`;
const fail = (e) => (e.status === 401 ? 'Your session ended. Please sign in again.' : e.message || 'Something went wrong');


// ---------- entry rows ----------

// ---------- entry rows ----------
/** What an entry is called in lists: its first item (and "+ n more"), or the kind of payment, or the expense note.
 *  Every category has its own fallback: an entry with no item lines must never be called "Expense" unless it is one. */
function entryTitle(e) {
  if (e.lines && e.lines.length) {
    const first = e.lines[0], it = item(first.itemId);
    return `${it ? it.name : 'Removed item'} × ${num(first.qty)}${e.lines.length > 1 ? ` +${e.lines.length - 1} more` : ''}`;
  }
  const t = TYPE[e.type];
  if (e.type === 'payment_in') return 'Payment received';
  if (e.type === 'payment_out') return 'Payment made';
  if (e.type === 'expense') return e.note || 'Expense';
  return t ? t.label : 'Entry'; // a sale, purchase or stock entry without lines is still called what it is
}

/** The invoice number's copy mark. A span, not a button, because it sits inside a clickable row. */
function copyMark(no, size = 13) {
  return `<span class="copy" role="button" tabindex="0" data-act="copy" data-copy="${esc(no)}" data-size="${size}" aria-label="Copy invoice number ${esc(no)}" title="Copy invoice number" data-testid="copy-invoice">${svg('copy', size, 2)}</span>`;
}
const invoiceMark = (no, q) => `<span class="inv"><span class="no">${hl(no, q)}</span>${copyMark(no)}</span>`; // .no keeps highlighted pieces inline

/** One entry as a row. o.balance = a line shown under the amount instead of "to collect / to pay"; o.testid overrides the test id. */
function rowHtml(e, q = '', o = {}) {
  const t = TYPE[e.type];
  const p = e.partyId && party(e.partyId);
  const who = e.partyId ? (p ? p.name : 'Removed person') : e.type === 'sale' ? 'Walk-in' : '';
  const credit = e.type === 'sale' || e.type === 'purchase';
  const owed = credit ? e.totalKobo - e.paidKobo : 0;
  const status = credit ? (owed > 0 ? (e.paidKobo === 0 ? 'on credit' : 'part paid') : 'paid') : '';
  const text = [who, e.type === 'opening_stock' && 'Opening stock', e.type === 'expense' && 'Expense', status, !e.lines && e.type !== 'expense' && e.note].filter(Boolean).join(' · ');
  // owed on a sale is money to collect from the customer; owed on a purchase is money you still have to pay
  const owing = e.type === 'sale' ? ['collect', 'to collect'] : ['pay', 'to pay'];
  const small = o.balance ? `<small class="n">${esc(o.balance)}</small>` : owed > 0 ? `<small class="${owing[0]}">${money(owed)} ${owing[1]}</small>` : '';
  return `<button class="er" data-act="entry" data-id="${esc(e.id)}" data-testid="${o.testid || 'entry-row'}">
    <span class="ic k-${t.key}">${svg(t.icon, 18)}</span>
    <span class="c1">${dm(e.date)}</span>
    <span class="c2"><span class="tag k-${t.key}">${t.label}</span></span>
    <span class="t"><b>${hl(entryTitle(e), q)}</b>${text ? `<small class="who">${hl(text, q)}</small>` : ''}<small class="invl">${invoiceMark(e.invoiceNo, q)}</small><small class="d">${invoiceMark(e.invoiceNo, q)}</small></span>
    <span class="c4">${hl(who || '—', q)}</span>
    <span class="amt c5 ${t.sign === '+' ? 'pos' : ''}">${t.sign}${money(e.totalKobo)}${small}</span>
    <span class="c6 ${owed > 0 ? owing[0] : ''}">${owed > 0 ? money(owed) : '—'}</span>
  </button>`;
}
