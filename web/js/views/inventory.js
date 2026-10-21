'use strict';
/* Inventory: every item with its price and stock on hand, low and out markers. */

function stockChip(it) {
  if (it.stock <= 0) return '<span class="stk out" data-testid="stock-chip">Out</span>';
  if (it.stock <= LOW_STOCK) return `<span class="stk low" data-testid="stock-chip">${num(it.stock)} left</span>`;
  return `<span class="stk" data-testid="stock-chip">${num(it.stock)} ${esc(plural(it.unit, it.stock))}</span>`;
}
async function inventoryView(my) {
  main(`<div class="view narrow"><header class="top"><h1 class="h1">Inventory</h1><button class="mini" data-act="new-item" data-testid="new-item">+ New item</button></header>
    <label class="search">${svg('search')}<input id="iq" type="search" placeholder="Search inventory" value="${esc(itemsQ)}" data-testid="iq" aria-label="Search inventory"></label><div id="ilist"></div></div>`);
  await paintItems(my);
}
async function paintItems() {
  const mine = ++peopleSeq;
  const list = await all('/api/items' + (itemsQ.trim() ? '?q=' + encodeURIComponent(itemsQ.trim()) : ''));
  const box = $('#ilist'); if (!box || mine !== peopleSeq) return;
  if (!itemsQ.trim()) S.items = list;
  box.innerHTML = list.length ? `<div class="list">${list.map((it) => `<button class="pr" data-act="item" data-id="${esc(it.id)}" data-testid="item-row"><div class="t"><b>${hl(it.name, itemsQ)}</b><small>${money(it.priceKobo)} per ${esc(it.unit)}</small></div>${stockChip(it)}</button>`).join('')}</div>`
    : itemsQ.trim() ? empty('Nothing found', 'Try another name.') : empty('Your inventory is empty', 'Add what you sell, with its unit and usual price.');
}
