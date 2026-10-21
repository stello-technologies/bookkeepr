'use strict';
/* Entries: search, type chips, date range, entries grouped by day (a table on desktop). */

const rangeFrom = (r) => (r === 'today' ? lagosMidnight() : r ? new Date(Date.now() - Number(r) * DAY) : null);

async function entriesView(my) {
  const E = S.E;
  main(`<div class="view">
    <div class="bar"><div class="grow"><h1 class="h1">Entries</h1></div>
      <label class="search">${svg('search')}<input id="q" type="search" placeholder="Search invoice no., people, items, notes" value="${esc(E.q)}" data-testid="q" aria-label="Search entries"></label></div>
    <div class="stats" id="stats"></div>
    <div class="filters"><div class="chips" role="group" aria-label="Type">${Object.entries(CHIPS).map(([k, [l]]) => `<button class="chip ${k === E.chip ? 'on' : ''}" data-act="chip" data-chip="${k}" data-testid="chip-${k}">${l}</button>`).join('')}</div>
      <select class="range grow" id="range" aria-label="Dates" data-testid="range">${Object.entries(RANGES).map(([k, l]) => `<option value="${k}" ${String(k) === String(E.range) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div id="elist"></div></div>`);
  api('GET', '/api/summary?window=month').then((s) => { // desktop stat strip
    const box = $('#stats'); if (!box || my !== seq) return;
    box.innerHTML = `<div class="st g"><div class="l">Profit, last 30 days</div><div class="v">${signed(s.profitKobo)}</div></div><div class="st"><div class="l">Sales</div><div class="v">${money(s.salesKobo)}</div></div><div class="st"><div class="l">Owed to you</div><div class="v ${s.owedToYouKobo > 0 ? 'red' : ''}">${signed(s.owedToYouKobo)}</div></div><div class="st"><div class="l">You owe</div><div class="v">${signed(s.youOweKobo)}</div></div>`;
  }).catch(() => {});
  await loadEntries(true);
}

async function loadEntries(reset) {
  const E = S.E;
  const p = new URLSearchParams();
  if (E.q.trim()) p.set('q', E.q.trim());
  if (CHIPS[E.chip][1]) p.set('type', CHIPS[E.chip][1]);
  const from = rangeFrom(E.range);
  if (from) p.set('from', from.toISOString());
  if (!reset && E.next) p.set('cursor', E.next);
  const mine = ++E.seq;
  try {
    const r = await api('GET', '/api/entries?' + p);
    if (mine !== E.seq) return; // a newer search is already running
    await learn(r.data);
    if (mine !== E.seq) return; // a newer search started while names were reloading
    E.list = reset ? r.data : E.list.concat(r.data);
    E.next = r.next;
    paintEntries();
  } catch (e) { if ($('#elist')) $('#elist').innerHTML = empty('Could not load entries', fail(e)); }
}

function paintEntries() {
  const box = $('#elist'); if (!box) return;
  const { list, next, q } = S.E;
  if (!list.length) {
    box.innerHTML = q.trim() || S.E.chip !== 'all' || S.E.range ? empty('Nothing found', 'Try a different search, type or date range.') : empty('No entries yet', 'Tap + to record your first sale, purchase or expense.');
    return;
  }
  const groups = [];
  for (const e of list) { const k = dayKey(e.date); (groups.at(-1)?.k === k ? groups.at(-1).rows : groups[groups.push({ k, d: e.date, rows: [] }) - 1].rows).push(e); }
  box.innerHTML = `<div class="tbl"><div class="tr hd"><div class="c1">Date</div><div class="c2">Type</div><div class="c3">Detail</div><div class="c4">Person</div><div class="c5">Amount</div><div class="c6">Outstanding</div></div>
    ${groups.map((g) => `<div class="date"><span>${dayLabel(g.d)}</span><span>${dayLabel(g.d) === dmy(g.d) ? '' : dmy(g.d)}</span></div><div class="list">${g.rows.map((e) => rowHtml(e, q)).join('')}</div>`).join('')}</div>
    ${next ? '<div class="stack" style="margin-top:14px"><button class="more" data-act="more" data-testid="more">Show more</button></div>' : ''}`;
}
