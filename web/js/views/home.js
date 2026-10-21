'use strict';
/* Home: profit, owed to you / you owe, recent entries. */

async function homeView(my) {
  const [sum, ents] = await Promise.all([api('GET', `/api/summary?window=${S.win}`), api('GET', '/api/entries')]);
  if (my !== seq) return;
  await learn(ents.data);
  if (my !== seq) return; // they moved on while names were reloading
  const recent = ents.data.slice(0, 5);
  main(`<div class="view narrow">
    <header class="top"><div><div class="biz-l">${esc(bizName())}</div><div class="hello" data-testid="hello">${greeting()}</div></div>
      <button class="avatar" data-act="account" aria-label="Account" data-testid="avatar">${esc(initials())}</button></header>
    <div class="chips" role="group" aria-label="Period">${Object.entries(WINS).map(([k, l]) => `<button class="chip ${k === S.win ? 'on' : ''}" data-act="win" data-win="${k}" data-testid="win-${k}">${l}</button>`).join('')}</div>
    <section class="hero"><div class="lab">Profit · last ${WINS[S.win]}</div><div class="big" data-testid="profit">${signed(sum.profitKobo)}</div>
      <div class="row">
        <div class="cell"><div class="cl">Sales</div><div class="cv" data-testid="sales">${money(sum.salesKobo)}</div></div>
        <div class="cell"><div class="cl">Bought</div><div class="cv" data-testid="bought">${money(sum.purchasesKobo)}</div></div>
        <div class="cell"><div class="cl">Expenses</div><div class="cv" data-testid="expenses">${money(sum.expensesKobo)}</div></div>
      </div></section>
    <div class="two">
      <div class="card"><div class="cl">Owed to you</div><div class="cv ${sum.owedToYouKobo > 0 ? 'red' : ''}" data-testid="owed">${signed(sum.owedToYouKobo)}</div></div>
      <div class="card"><div class="cl">You owe</div><div class="cv" data-testid="oweing">${signed(sum.youOweKobo)}</div></div>
    </div>
    <div class="sec"><b>Recent</b><a href="#/entries" data-testid="see-all">See all</a></div>
    ${recent.length ? `<div class="list">${recent.map((e) => rowHtml(e)).join('')}</div>` : empty('No entries yet', 'Tap + to record your first sale, purchase or expense.')}
  </div>`);
}
