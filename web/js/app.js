'use strict';
/* Entry point (loaded last): sign-in, page shell, routing, and all click / typing handlers. */

async function boot() {
  try {
    if (!window.auth0) throw new Error('Could not load the sign-in library. Check your internet connection.');
    const cfg = await (await fetch('/config.json')).json();
    A = await window.auth0.createAuth0Client({ domain: cfg.domain, clientId: cfg.clientId, authorizationParams: { audience: cfg.audience, redirect_uri: location.origin } });
    if (/[?&]code=/.test(location.search) && /[?&]state=/.test(location.search)) {
      await A.handleRedirectCallback();
      history.replaceState({}, '', location.pathname + location.hash);
    }
    if (!(await A.isAuthenticated())) return showLogin();
    S.user = await A.getUser();
    await refreshLists();
    shell();
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><h1>Bookkeeper</h1><p data-testid="fatal">${esc(e.message)}</p><button class="save" onclick="location.reload()">Try again</button></div>`;
  }
}
const showLogin = () => { $('#app').innerHTML = '<div class="login"><h1>Bookkeeper</h1><p>Simple books for your shop: sales, purchases, expenses and who owes what.</p><button class="save" data-act="login" data-testid="login">Sign in</button></div>'; };

function shell() {
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand">Bookkeeper</div><div class="biz">${esc(bizName())}</div>
      <button class="new" data-act="add" data-testid="add-side">${svg('plus', 18, 2.5)}New entry</button>
      ${NAV.map((n) => `<a class="nav" href="#/${n.id}" data-nav="${n.id}" data-testid="nav-${n.id}">${svg(n.icon)}${n.label}</a>`).join('')}
      <button class="me" data-act="signout" data-testid="signout-side"><span class="av">${esc(initials())}</span>Sign out</button>
    </aside>
    <main class="main" id="main"></main>
    <nav class="tabs" aria-label="Main">
      <a class="tab" href="#/home" data-nav="home" data-testid="tab-home">${svg('home', 24)}Home</a>
      <a class="tab" href="#/entries" data-nav="entries" data-testid="tab-entries">${svg('list', 24)}Entries</a>
      <button class="plus" data-act="add" aria-label="Add entry" data-testid="add-tab">${svg('plus', 26, 2.5)}</button>
      <a class="tab" href="#/people" data-nav="people" data-testid="tab-people">${svg('people', 24)}People</a>
      <a class="tab" href="#/inventory" data-nav="inventory" data-testid="tab-inventory">${svg('box', 24)}Inventory</a>
    </nav>
    <div class="dim" id="dim" data-act="close" hidden></div>
    <aside class="panel" id="panel" hidden></aside>
  </div>`;
}

function route() {
  const my = ++seq;
  closePanel();
  const [, view = 'home', arg] = location.hash.split('/');
  const known = { home: homeView, entries: entriesView, people: arg ? () => personView(arg, my) : peopleView, inventory: inventoryView, items: inventoryView };
  const v = view === 'items' ? 'inventory' : known[view] ? view : 'home'; // #/items still works
  document.querySelectorAll('[data-nav]').forEach((a) => { const on = a.dataset.nav === v; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  loading();
  (known[view] || homeView)(my).catch((e) => { if (my === seq) main(`<div class="view">${empty('Could not load this page', fail(e))}</div>`); });
}


// ---------- events ----------
/** Copy text. Uses the clipboard where the browser allows it, otherwise the older select-and-copy way (works on plain http). */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not allowed here: fall through */ }
  const box = document.createElement('textarea');
  box.value = text; box.setAttribute('readonly', ''); box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(box); box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  box.remove();
  return ok;
}

const ACT = {
  login: () => A.loginWithRedirect(),
  signout: () => A.logout({ logoutParams: { returnTo: location.origin } }),
  account: () => openPanel(panelHtml('Account', `<p class="muted" style="margin-top:0">Signed in as <b data-testid="whoami">${esc(bizName())}</b></p><button class="save" data-act="signout" data-testid="signout">Sign out</button>`, 'Close')),
  add: () => openForm(),
  close: () => closePanel(),
  win: (el) => { S.win = el.dataset.win; route(); },
  chip: (el) => { S.E.chip = el.dataset.chip; document.querySelectorAll('[data-chip]').forEach((c) => c.classList.toggle('on', c === el)); loadEntries(true); },
  more: () => loadEntries(false),
  entry: (el) => openDetail(el.dataset.id),
  'del-entry-ask': (el) => openDetail(el.dataset.id, true),
  'del-entry': (el) => remove(`/api/entries/${el.dataset.id}`, 'Entry deleted', '#d-err'),
  item: (el) => openItemDetail(el.dataset.id),
  'rm-item-ask': (el) => openConfirm('Remove item?', `${item(el.dataset.id)?.name} will disappear from your lists. Past entries stay in your totals.`, 'rm-item', el.dataset.id, 'Yes, remove'),
  'rm-item': (el) => remove(`/api/items/${el.dataset.id}`, 'Item removed', '#c-err'),
  'rm-person-ask': (el) => openConfirm('Remove this person?', `${party(el.dataset.id)?.name} will disappear from your lists. Past entries and what they owe stay in your totals.`, 'rm-person', el.dataset.id, 'Yes, remove'),
  'rm-person': async (el) => { await remove(`/api/parties/${el.dataset.id}`, 'Person removed', '#c-err'); if (location.hash.startsWith('#/people/')) location.hash = '#/people'; },
  pay: (el) => { const p = party(el.dataset.id); openForm({ type: p && p.owesYouKobo === 0 && p.youOweKobo > 0 ? 'payment_out' : 'payment_in', partyId: el.dataset.id }); },
  type: (el) => { const keep = { note: F.note, partyId: F.partyId }; if (FORMS[el.dataset.type].lines) keep.lines = F.lines; F = newForm(el.dataset.type, keep); renderForm(); },
  'new-person': () => openNewPerson(false), 'new-item': () => openNewItem(false),
  'new-person-in-form': () => openNewPerson(true), 'new-item-in-form': (el) => openNewItem(true, Number(el.dataset.line)),
  'save-person': (el) => savePerson(el.dataset.back), 'save-item': (el) => saveItem(el.dataset.back),
  copy: async (el) => {
    const text = el.dataset.copy, size = Number(el.dataset.size) || 13;
    const ok = await copyText(text);
    toast(ok ? `Copied ${text}` : 'Could not copy. Press and hold the number to copy it.', !ok);
    if (ok) { el.innerHTML = svg('check', size, 2.5); el.classList.add('done'); setTimeout(() => { el.innerHTML = svg('copy', size, 2); el.classList.remove('done'); }, 1500); }
  },
  'add-line': () => { F.lines.push(blankLine()); renderForm(); const el = $(`#f-item-${F.lines.length - 1}`); if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); } },
  'remove-line': (el) => { F.lines.splice(Number(el.dataset.line), 1); renderForm(); },
  'save-image': (el) => saveInvoiceImage(S.rows.get(el.dataset.id)).catch((err) => toast(fail(err), true)),
  'share-image': (el) => shareInvoiceImage(S.rows.get(el.dataset.id)),
  'save-entry': saveEntry,
};
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  ev.preventDefault();
  ACT[el.dataset.act](el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('#panel') && !$('#panel').hidden) closePanel();
  const copy = ev.target.closest && ev.target.closest('[data-act="copy"]');
  if (copy && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); ev.stopPropagation(); ACT.copy(copy); } // the copy mark is focusable, so the keyboard works too
});

let typing;
document.addEventListener('input', (ev) => {
  const id = ev.target.id, v = ev.target.value;
  if (F && id.startsWith('f-')) {
    const m = id.match(/^f-(qty|price)-(\d+)$/);
    if (m) { F.lines[Number(m[2])][m[1]] = v; derive(); }
    else { const map = { 'f-paid': 'paid', 'f-amount': 'amount', 'f-note': 'note' }; if (map[id]) { F[map[id]] = v; if (id === 'f-paid') F.paidTouched = true; derive(); } }
  }
  if (id === 'q' || id === 'pq' || id === 'iq') {
    clearTimeout(typing);
    typing = setTimeout(() => { if (id === 'q') { S.E.q = v; loadEntries(true); } else if (id === 'pq') { peopleQ = v; paintPeople(); } else { itemsQ = v; paintItems(); } }, 250);
  }
});
document.addEventListener('change', (ev) => {
  const id = ev.target.id, v = ev.target.value;
  if (id === 'range') { S.E.range = v; loadEntries(true); }
  if (!F) return;
  if (id === 'f-party') { F.partyId = v; derive(); }
  const m = id.match(/^f-item-(\d+)$/);
  if (m) {
    const l = F.lines[Number(m[1])], it = item(v);
    l.itemId = v;
    if (it) { l.price = inputMoney(it.priceKobo); $(`#f-price-${m[1]}`).value = l.price; }
    derive();
  }
});

boot();
