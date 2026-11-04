'use strict';
/* Small panels: new person, new item, entry detail, confirmations, removing things. */

function openNewPerson(back) {
  openPanel(panelHtml('New person', `<div class="f"><label for="np-name">Name</label><input class="in" id="np-name" data-testid="np-name" autocomplete="off"></div>
    <div class="f"><label for="np-phone">Phone (optional)</label><input class="in" id="np-phone" data-testid="np-phone" inputmode="tel" autocomplete="off"></div>
    <div class="err" id="np-err" role="alert"></div><button class="save" data-act="save-person" data-back="${back ? 1 : ''}" data-testid="save-person">Save person</button>`));
}
function openNewItem(back, line = 0) {
  if (back && F) F.pendingLine = line; // which line of the form asked for a new item
  openPanel(panelHtml('New item', `<div class="f"><label for="ni-name">Name</label><input class="in" id="ni-name" data-testid="ni-name" autocomplete="off" placeholder="Rice 50kg"></div>
    <div class="pair"><div class="f"><label for="ni-unit">Sold by (unit)</label><input class="in" id="ni-unit" data-testid="ni-unit" autocomplete="off" placeholder="bag, kg, carton"></div>
    <div class="f"><label for="ni-price">Usual price (₦)</label><input class="in" id="ni-price" data-testid="ni-price" inputmode="decimal" autocomplete="off" placeholder="0"></div></div>
    <div class="err" id="ni-err" role="alert"></div><button class="save" data-act="save-item" data-back="${back ? 1 : ''}" data-testid="save-item">Save item</button>`));
}
async function savePerson(back) {
  const name = $('#np-name').value.trim();
  if (!name) return ($('#np-err').textContent = 'Enter a name');
  try {
    const p = await api('POST', '/api/parties', { name, phone: $('#np-phone').value.trim() });
    await refreshLists();
    if (back && F) { F.partyId = p.id; renderForm(); } else { closePanel(); toast(`${p.name} added`); route(); }
  } catch (e) { $('#np-err').textContent = fail(e); }
}
async function saveItem(back) {
  const name = $('#ni-name').value.trim(), unit = $('#ni-unit').value.trim(), price = parseMoney($('#ni-price').value);
  if (!name || !unit) return ($('#ni-err').textContent = 'Enter a name and a unit such as bag, kg or carton');
  if (!Number.isFinite(price)) return ($('#ni-err').textContent = 'Enter the usual price, for example 1500 or 1500.50');
  try {
    const it = await api('POST', '/api/items', { name, unit, priceKobo: price });
    await refreshLists();
    if (back && F) { const l = F.lines[F.pendingLine] || F.lines[0]; l.itemId = it.id; l.price = inputMoney(it.priceKobo); renderForm(); } else { closePanel(); toast(`${it.name} added`); route(); }
  } catch (e) { $('#ni-err').textContent = fail(e); }
}

function openDetail(id, confirming) {
  const e = S.rows.get(id); if (!e) return;
  const t = TYPE[e.type], p = e.partyId && party(e.partyId), credit = e.type === 'sale' || e.type === 'purchase';
  const lineRows = (e.lines || []).map((l) => { const it = item(l.itemId); return [it ? it.name : 'Removed item', `${num(l.qty)} × ${money(l.unitPriceKobo)} = ${money(l.totalKobo)}`]; });
  const kv = [['Invoice', e.invoiceNo, copyMark(e.invoiceNo, 18)], ['Date', `${dmy(e.date)}, ${hm(e.date)}`], p && ['Person', p.name], ...lineRows, ['Total', money(e.totalKobo)],
    credit && ['Paid', money(e.paidKobo)], credit && e.paidKobo < e.totalKobo && [e.type === 'sale' ? 'Still to collect' : 'Still to pay', money(e.totalKobo - e.paidKobo)], e.note && ['Note', e.note],
    e.createdBy && ['Recorded by', memberName(e.createdBy)], e.deleted && ['Deleted', deletedLine(e).replace(/^Deleted /, '')]].filter(Boolean);
  const image = credit ? `<div class="btns" style="margin-bottom:6px"><button class="b s" data-act="save-image" data-id="${esc(id)}" data-testid="export-invoice">Save as image</button>${canShareImage() ? `<button class="b p" data-act="share-image" data-id="${esc(id)}" data-testid="share-invoice">Share</button>` : ''}</div>` : '';
  const action = e.deleted ? '' : can('delete_entry', e) ? `<button class="link danger" data-act="del-entry-ask" data-id="${esc(id)}" data-testid="delete-entry">Delete entry</button>`
    : '<p class="muted" data-testid="no-delete" style="font-size:13px">Only the boss, or the person who recorded this, can delete it.</p>';
  openPanel(panelHtml(t.label, `<dl class="kv" data-testid="detail">${kv.map(([k, v, extra = '']) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${extra}</dd></div>`).join('')}</dl>
    ${confirming ? `<div class="confirm">Delete this entry? It disappears from every total, and everyone on this business will see who deleted it. To correct a mistake, delete it and add it again.</div>
      <div class="f"><label for="d-reason">Reason (optional)</label><input class="in" id="d-reason" data-testid="d-reason" maxlength="200" autocomplete="off"></div><div class="err" id="d-err" role="alert"></div>
      <div class="stack"><button class="save warn" data-act="del-entry" data-id="${esc(id)}" data-testid="confirm-delete">Yes, delete</button><button class="b s" data-act="close">Keep it</button></div>`
      : `${e.deleted ? '' : image}${action}`}`, 'Close'));
}
function openConfirm(title, text, act, id, yes) {
  openPanel(panelHtml(title, `<div class="confirm">${esc(text)} Everyone on this business will see who removed it.</div><div class="f"><label for="c-reason">Reason (optional)</label><input class="in" id="c-reason" data-testid="c-reason" maxlength="200" autocomplete="off"></div><div class="err" id="c-err" role="alert"></div><div class="stack"><button class="save warn" data-act="${act}" data-id="${esc(id)}" data-testid="confirm-yes">${yes}</button><button class="b s" data-act="close">Keep</button></div>`));
}
function openItemDetail(id) {
  const it = item(id); if (!it) return;
  openPanel(panelHtml(it.name, `<dl class="kv" data-testid="detail"><div><dt>Sold by</dt><dd>${esc(it.unit)}</dd></div><div><dt>Usual price</dt><dd>${money(it.priceKobo)}</dd></div><div><dt>In stock</dt><dd>${num(it.stock)} ${esc(plural(it.unit, it.stock))}</dd></div></dl>
    ${S.role === 'boss' ? `<button class="link danger" data-act="rm-item-ask" data-id="${esc(id)}" data-testid="remove-item">Remove item</button>` : ''}`, 'Close'));
}

async function remove(path, ok, errBox) {
  try { await api('DELETE', path); await refreshLists(); closePanel(); toast(ok); route(); }
  catch (e) { const box = $(errBox); if (box) box.textContent = fail(e); else toast(fail(e), true); }
}
