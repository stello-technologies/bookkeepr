'use strict';
/* People: searchable list with balances, and one person's statement. */

let peopleQ = '', itemsQ = '', peopleSeq = 0;
function balanceChip(p) {
  if (p.owesYouKobo > 0) return `<span class="chip-bal red">Owes you ${money(p.owesYouKobo)}</span>`;
  if (p.youOweKobo > 0) return `<span class="chip-bal">You owe ${money(p.youOweKobo)}</span>`;
  return '<span class="chip-bal">Settled</span>';
}
async function peopleView(my) {
  main(`<div class="view narrow"><header class="top"><h1 class="h1">People</h1><button class="mini" data-act="new-person" data-testid="new-person">+ New person</button></header>
    <label class="search">${svg('search')}<input id="pq" type="search" placeholder="Search people" value="${esc(peopleQ)}" data-testid="pq" aria-label="Search people"></label><div id="plist"></div></div>`);
  await paintPeople(my);
}
async function paintPeople() {
  const mine = ++peopleSeq;
  const list = await all('/api/parties' + (peopleQ.trim() ? '?q=' + encodeURIComponent(peopleQ.trim()) : ''));
  const box = $('#plist'); if (!box || mine !== peopleSeq) return;
  if (!peopleQ.trim()) S.parties = list;
  box.innerHTML = list.length ? `<div class="list">${list.map((p) => `<a class="pr" href="#/people/${esc(p.id)}" data-testid="person-row"><div class="t"><b>${hl(p.name, peopleQ)}</b><small>${esc(p.phone || 'No phone')}</small></div>${balanceChip(p)}</a>`).join('')}</div>`
    : peopleQ.trim() ? empty('Nobody found', 'Try another name or number.') : empty('No people yet', 'Add the customers you sell to and the suppliers you buy from.');
}

async function personView(id, my) {
  const to = Eng.now() + 60_000; // statements cover at most 30 days
  let st, list;
  try { [list, st] = await Promise.all([all('/api/parties'), api('GET', `/api/statements?kind=party&partyId=${id}&from=${new Date(to - 30 * DAY).toISOString()}&to=${new Date(to).toISOString()}`)]); }
  catch (e) { if (my === seq) main(`<div class="view narrow"><a class="nav-back" href="#/people">${svg('back', 24)}People</a>${empty('Person not found', 'They may have been removed.')}</div>`); return; }
  if (my !== seq) return;
  S.parties = list;
  const p = party(id) || { id, name: st.party.name, phone: '', owesYouKobo: 0, youOweKobo: 0 };
  index(st.rows);
  const owes = p.owesYouKobo, owed = p.youOweKobo;
  const wa = p.phone && owes > 0 ? `https://wa.me/${p.phone.replace(/\D/g, '').replace(/^0/, '234')}?text=${encodeURIComponent(`Hello ${p.name}, a reminder that you owe ${money(owes)} to ${bizName()}. Thank you.`)}` : '';
  const rows = st.rows.slice().reverse().map((r) => {
    const theirs = r.type === 'sale' || r.type === 'payment_in'; // these two move what THEY owe you; the others move what YOU owe them
    return rowHtml(r, '', { testid: 'statement-row', balance: `${theirs ? 'Owes you' : 'You owe'} ${money(theirs ? r.owesYouKobo : r.youOweKobo)}` });
  });
  const bf = st.broughtForward;
  if (bf.owesYouKobo || bf.youOweKobo) rows.push(`<div class="er"><span class="t"><b>Balance brought forward</b><small>Before ${dm(st.from)}</small></span><span class="amt">${bf.owesYouKobo ? 'Owes you ' + money(bf.owesYouKobo) : ''}${bf.youOweKobo ? 'You owe ' + money(bf.youOweKobo) : ''}</span></div>`);
  main(`<div class="view narrow"><a class="nav-back" href="#/people" data-testid="back">${svg('back', 24)}People</a>
    <div><div class="name" data-testid="person-name">${esc(p.name)}</div><div class="sub">${esc(p.phone || 'No phone number')}</div></div>
    <section class="bal"><div class="l">${owes > 0 ? 'Owes you' : owed > 0 ? 'You owe' : 'Balance'}</div>
      <div class="v ${owes > 0 ? 'red' : ''}" data-testid="person-balance">${money(owes > 0 ? owes : owed)}</div>
      ${owes > 0 && owed > 0 ? `<div class="l">You also owe them <b data-testid="person-balance2">${money(owed)}</b></div>` : ''}
      ${owes === 0 && owed === 0 ? '<div class="l" style="margin-bottom:12px">All settled</div>' : ''}
      <div class="btns"><button class="b p" data-act="pay" data-id="${esc(p.id)}" data-testid="record-payment">Record payment</button>${wa ? `<a class="b s" href="${wa}" target="_blank" rel="noopener" data-testid="reminder">Send reminder</a>` : ''}</div></section>
    <div class="sec"><b>Statement</b><span class="muted" style="font-size:13px">Last 30 days</span></div>
    ${rows.length ? `<div class="list">${rows.join('')}</div>` : empty('No entries in the last 30 days', '')}
    ${S.role === 'boss' ? `<button class="link danger" data-act="rm-person-ask" data-id="${esc(p.id)}" data-testid="remove-person">Remove ${esc(p.name)}</button>` : ''}</div>`);
}
