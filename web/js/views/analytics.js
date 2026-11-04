'use strict';
/* Analytics (boss only): four answers at a glance. Top product, best customer, average sale, leading debts.
   Everything is worked out on the phone by the engine, so it works offline. */

async function analyticsView(my) {
  if (S.role !== 'boss') { main(`<div class="view narrow">${empty('Owner only', 'Analytics is for the business owner.')}</div>`); return; }
  const r = await api('GET', `/api/analytics?window=${S.win}`);
  if (my !== seq) return;
  const { topProduct: p, bestCustomer: c, avgSale: a, debts } = r;
  const none = (label, id) => `<div class="card" data-testid="${id}"><div class="cl">${label}</div><div class="cv">—</div><small class="muted">No sales in this period</small></div>`;
  const tap = 'style="cursor:pointer;text-decoration:none;color:inherit;display:block"';
  const sub = (t) => `<small class="muted" style="display:block">${t}</small>`;

  const productCard = !p ? none('Top product', 'top-product')
    : `<div class="card" ${p.gone ? '' : `role="button" tabindex="0" data-act="item" data-id="${esc(p.id)}" ${tap}`} data-testid="top-product"><div class="cl">Top product</div><div class="cv" style="word-break:break-word">${esc(p.name)}</div>${sub(`${num(p.qty)} ${esc(plural(p.unit, p.qty))} · ${money(p.kobo)}`)}</div>`;
  const customerCard = !c ? none('Best customer', 'best-customer')
    : `<${c.gone ? 'div' : 'a'} class="card" ${c.gone ? '' : `href="#/people/${esc(c.id)}" ${tap}`} data-testid="best-customer"><div class="cl">Best customer</div><div class="cv" style="word-break:break-word">${esc(c.name)}</div>${sub(`${money(c.kobo)} · ${c.count} sale${c.count === 1 ? '' : 's'}`)}</${c.gone ? 'div' : 'a'}>`;
  const avgCard = a.kobo === null ? none('Average sale', 'avg-sale')
    : `<div class="card" data-testid="avg-sale"><div class="cl">Average sale</div><div class="cv">${money(a.kobo)}</div>${sub(`from ${a.count} sale${a.count === 1 ? '' : 's'}`)}</div>`;

  const debtRow = (d) => `<${d.gone ? 'div' : 'a'} class="pr" ${d.gone ? '' : `href="#/people/${esc(d.id)}" ${tap}`} data-testid="debt-row"><div class="t"><b>${esc(d.name)}</b></div><b>${money(d.kobo)}</b></${d.gone ? 'div' : 'a'}>`;

  main(`<div class="view narrow">
    <header class="top"><div><div class="biz-l">${esc(bizName())}</div><div class="hello" data-testid="ana-title">Analytics</div></div></header>
    <div class="chips" role="group" aria-label="Period">${Object.entries(WINS).map(([k, l]) => `<button class="chip ${k === S.win ? 'on' : ''}" data-act="win" data-win="${k}" data-testid="win-${k}">${l}</button>`).join('')}</div>
    <p class="muted" style="font-size:13px;margin:4px 0 12px">Sales in the last ${WINS[S.win]}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">${productCard}${customerCard}</div>
    <div style="margin-bottom:12px">${avgCard}</div>
    <div class="sec"><b>Leading debts</b><span class="muted" style="font-size:12px;color:red">owed to you</span></div>
    ${debts.length ? `<div class="list">${debts.map(debtRow).join('')}</div>` : '<p class="muted" data-testid="no-debts">Nobody owes you anything.</p>'}
    <p style="margin-top:16px"><a href="#/home" data-testid="ana-back">Back to Home</a></p>
  </div>`);
}
