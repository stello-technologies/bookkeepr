'use strict';
/* Entry point (loaded last): sign-in that survives being offline, the phone's own books, sync, page shell, routing, and all click / typing handlers. */

const LS = { cfg: 'bk-config', user: 'bk-user', device: 'bk-device', invite: 'bk-invite', theme: 'bk-theme' };
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: carry on */ } };
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  lsSet(LS.theme, theme);
}
setTheme(lsGet(LS.theme) === 'dark' ? 'dark' : 'light');
const deviceId = () => { let d = lsGet(LS.device); if (!d) { d = 'd-' + Engine.newId().slice(8); lsSet(LS.device, d); } return d; };

async function loadConfig() { // settings for sign-in; kept on the phone so it can start with no network
  try {
    const cfg = await (await fetch('/config.json')).json();
    lsSet(LS.cfg, cfg);
    ProductAnalytics.init(cfg.posthog);
    return cfg;
  } catch {
    const cfg = lsGet(LS.cfg);
    if (cfg) { ProductAnalytics.init(cfg.posthog); return cfg; }
    throw new Error('Connect to the internet once to sign in.');
  }
}
async function initAuth() {
  if (A) return A;
  if (!window.auth0) throw new Error('Could not load the sign-in library.');
  const cfg = await loadConfig();
  A = await window.auth0.createAuth0Client({ domain: cfg.domain, clientId: cfg.clientId, cacheLocation: 'localstorage', useRefreshTokens: true, authorizationParams: { audience: cfg.audience, redirect_uri: location.origin } });
  return A;
}
async function identify() { // who is signed in: the login id names this phone's copy of the books
  const u = (await A.getUser()) || {};
  let sub = u.sub;
  if (!sub) { const t = await A.getTokenSilently(); sub = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; }
  const user = { sub, name: u.name || '', email: u.email || '' };
  lsSet(LS.user, user);
  return user;
}
const registerWorker = () => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); };
const message = (text, testid, button) => { $('#app').innerHTML = `<div class="login"><h1>Bookkeeper</h1><p data-testid="${testid}">${esc(text)}</p>${button || '<button class="save" onclick="location.reload()">Try again</button>'}</div>`; };

function refreshState() {
  const s = Eng.session();
  S.role = s.role; S.biz = s.name; S.members = s.members;
}

async function boot() {
  try {
    registerWorker();
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) { lsSet(LS.invite, invite); history.replaceState({}, '', location.pathname + location.hash); }

    let user = lsGet(LS.user), signedIn = false;
    try {
      await initAuth();
      if (/[?&]code=/.test(location.search) && /[?&]state=/.test(location.search)) {
        await A.handleRedirectCallback();
        history.replaceState({}, '', location.pathname + location.hash);
      }
      signedIn = await A.isAuthenticated();
      if (signedIn && !user) user = await identify();
    } catch (e) {
      if (!user) throw e; // never signed in on this phone, so there is nothing to show offline
      signedIn = true; // signed in before: carry on from the phone's own copy of the books
    }
    if (!signedIn && user && !navigator.onLine) signedIn = true; // offline, and signed in before: never bounce to a login screen that cannot work
    if (!signedIn) return showLogin();

    S.user = user; S.me = user.sub;
    Eng = Engine.create(await Store.open('bk-' + user.sub));
    await Eng.load();
    await Eng.setSession({ userId: user.sub, deviceId: deviceId() });
    Eng.on('remote', async () => { // something arrived from another phone
      refreshState(); await refreshLists();
      if ($('#panel') && $('#panel').hidden && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#main'))) route();
    });
    Syn = Sync.create({ eng: Eng, getToken: token, deviceId: deviceId(), onRevoked: removed });

    if (lsGet(LS.invite)) await joinFromInvite(user);
    if (!Eng.session().role || !Eng.session().accountId) { // the first time on this phone needs the internet, once
      message('Setting up your books…', 'setup', '');
      await Syn.run();
      if (!Eng.session().accountId) return message(Syn.state() === 'offline' ? 'Connect to the internet to finish setting up.' : 'Setup could not finish. Please try again.', 'setup-failed');
    }
    refreshState();
    await refreshLists();
    shell();
    window.addEventListener('hashchange', route);
    route();
    Syn.start(S.role === 'staff' ? 30_000 : 120_000);
    Syn.run();
  } catch (e) {
    message(e.message, 'fatal');
  }
}
const showLogin = () => {
  $('#app').innerHTML = '<div class="login"><h1>Bookkeeper</h1><p>Simple books for your shop: sales, purchases, expenses and who owes what.</p><button class="save" data-act="login" data-testid="login">Sign in</button><button class="link" data-act="analytics-preferences">Analytics preferences</button></div>';
  ProductAnalytics.page('login');
};

/** A staff member opens the boss's invite link, signs in, and joins the boss's business. */
async function joinFromInvite(user) {
  const code = lsGet(LS.invite);
  lsSet(LS.invite, null);
  try {
    await cloud('POST', '/api/invites/accept', { code, name: user.name || user.email || 'Staff' });
    await Eng.wipe(); // an empty copy of their own, never used
    await Eng.setSession({ userId: user.sub, deviceId: deviceId() });
  } catch (e) { setTimeout(() => toast(fail(e), true), 500); }
}

/** The boss removed this login: forget everything on this phone. */
async function removed() {
  Syn.stop();
  await Eng.wipe();
  await Store.drop('bk-' + S.me);
  lsSet(LS.user, null);
  message('You were removed from this business.', 'revoked', '<button class="save" data-act="signout-now">Sign out</button>');
}

async function leave() { // sign out: send what is waiting, then take the books off this phone
  if (Eng.pendingCount()) await Syn.run();
  if (Eng.pendingCount() && !confirm(`${Eng.pendingCount()} change(s) have not reached the cloud yet and will be lost if you sign out. Sign out anyway?`)) return;
  Syn.stop();
  await Eng.wipe();
  await Store.drop('bk-' + S.me);
  lsSet(LS.user, null);
  A ? A.logout({ logoutParams: { returnTo: location.origin } }) : location.reload();
}

function accountPanel() {
  const boss = S.role === 'boss';
  const active = S.members.filter((m) => !m.removed);
  const staff = active.filter((m) => m.role !== 'boss');
  const members = boss ? staff : active;
  const rows = members.map((m) => `<div class="pr" data-testid="member-row"><div class="t"><b>${esc(m.name)}</b></div>${boss ? `<button class="mini" data-act="rm-member" data-id="${esc(m.id)}" data-testid="remove-member">Remove</button>` : ''}</div>`).join('');
  openPanel(panelHtml('Account', `<p class="muted" style="margin-top:0">Signed in as <b data-testid="whoami">${esc(S.user?.name || S.user?.email || bizName())}</b> · ${boss ? 'Boss' : 'Staff'}</p>
    ${boss ? `<div class="sec"><b>Staff</b></div>
      ${staff.length ? `<div class="list">${rows}</div>` : '<p class="muted" data-testid="no-staff" style="margin:0 0 8px">No staff yet.</p>'}
      <div class="err" id="a-err" role="alert"></div><div id="inv"></div>
      <button class="link" data-act="make-invite" data-testid="invite">Add staff</button>`
      : `<div class="sec"><b>People in this business</b></div><div class="list">${rows}</div>`}
    <button class="link" data-act="analytics-preferences">Analytics preferences</button>
    <button class="save" data-act="signout" data-testid="signout">Sign out</button>`, 'Close'));
}
const why = () => encodeURIComponent((($('#c-reason') || $('#d-reason') || {}).value || '').trim());

function shell() {
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand">Bookkeeper</div><div class="biz">${esc(bizName())}</div>
      <button class="new" data-act="add" data-testid="add-side">${svg('plus', 18, 2.5)}New entry</button>
      ${NAV.map((n) => `<a class="nav" href="#/${n.id}" data-nav="${n.id}" data-testid="nav-${n.id}">${svg(n.icon)}${n.label}</a>`).join('')}
      <button class="me" data-act="account" data-testid="account-side"><span class="av">${esc(initials())}</span>Account</button>
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
  const known = { home: homeView, entries: entriesView, people: arg ? () => personView(arg, my) : peopleView, inventory: inventoryView, items: inventoryView, analytics: analyticsView };
  const v = view === 'items' ? 'inventory' : known[view] ? view : 'home'; // #/items still works
  ProductAnalytics.page(v);
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
  signout: () => leave(),
  'signout-now': () => (A ? A.logout({ logoutParams: { returnTo: location.origin } }) : location.reload()),
  account: () => accountPanel(),
  'toggle-theme': (el) => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    setTheme(dark ? 'dark' : 'light');
    el.textContent = dark ? 'Light mode' : 'Dark mode';
    el.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
    el.setAttribute('aria-pressed', String(dark));
  },
  'analytics-preferences': () => ProductAnalytics.preferences(),
  'analytics-accept': () => ProductAnalytics.choose('accepted'),
  'analytics-decline': () => ProductAnalytics.choose('declined'),
  'make-invite': async () => {
    try {
      const r = await cloud('POST', '/api/invites');
      ProductAnalytics.event('invite_created');
      const link = `${location.origin}/?invite=${r.code}`;
      $('#inv').innerHTML = `<p class="muted" style="font-size:13px">Send this link to your staff member. It works once and expires in 7 days.</p><p data-testid="invite-link" style="word-break:break-all"><b>${esc(link)}</b></p>`;
      $('#a-err').textContent = '';
    } catch (e) { $('#a-err').textContent = fail(e); }
  },
  'rm-member': async (el) => {
    try { await cloud('DELETE', `/api/members/${encodeURIComponent(el.dataset.id)}`); await Syn.run(); refreshState(); accountPanel(); toast('Removed. Their phone clears itself next time it connects.'); }
    catch (e) { $('#a-err').textContent = fail(e); }
  },
  add: () => openForm(),
  close: () => closePanel(),
  win: (el) => { S.win = el.dataset.win; route(); },
  chip: (el) => { S.E.chip = el.dataset.chip; document.querySelectorAll('[data-chip]').forEach((c) => c.classList.toggle('on', c === el)); loadEntries(true); },
  more: () => loadEntries(false),
  entry: (el) => openDetail(el.dataset.id),
  'del-entry-ask': (el) => openDetail(el.dataset.id, true),
  'del-entry': (el) => remove(`/api/entries/${el.dataset.id}?reason=${why()}`, 'Entry deleted', '#d-err'),
  item: (el) => openItemDetail(el.dataset.id),
  'rm-item-ask': (el) => openConfirm('Remove item?', `${item(el.dataset.id)?.name} will disappear from your lists. Past entries stay in your totals.`, 'rm-item', el.dataset.id, 'Yes, remove'),
  'rm-item': (el) => remove(`/api/items/${el.dataset.id}?reason=${why()}`, 'Item removed', '#c-err'),
  'rm-person-ask': (el) => openConfirm('Remove this person?', `${party(el.dataset.id)?.name} will disappear from your lists. Past entries and what they owe stay in your totals.`, 'rm-person', el.dataset.id, 'Yes, remove'),
  'rm-person': async (el) => { await remove(`/api/parties/${el.dataset.id}?reason=${why()}`, 'Person removed', '#c-err'); if (location.hash.startsWith('#/people/')) location.hash = '#/people'; },
  pay: (el) => { const p = party(el.dataset.id); openForm({ type: p && p.owesYouKobo === 0 && p.youOweKobo > 0 ? 'payment_out' : 'payment_in', partyId: el.dataset.id }); },
  type: (el) => switchType(el.dataset.type),
  'new-person': () => openNewPerson(false), 'new-item': () => openNewItem(false),
  'new-person-in-form': () => openNewPerson(true), 'new-item-in-form': (el) => openNewItem(true, Number(el.dataset.line)),
  'select-item': (el) => {
    const line = Number(el.dataset.line), l = F?.lines[line], it = item(el.dataset.id);
    if (!l || !it) return;
    l.itemId = it.id; l.itemSearch = it.name; l.price = inputMoney(it.priceKobo);
    renderForm();
    $(`#f-qty-${line}`)?.focus();
  },
  'edit-price': (el) => openPriceEdit(el.dataset.id), 'save-price': (el) => savePrice(el.dataset.id),
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
// ---------- boss changes an item's price ----------
function openPriceEdit(id) {
  const it = item(id);
  if (!it) return toast('Item not found', true);
  openPanel(panelHtml('Edit price: ' + it.name, `<p class="muted" style="margin-top:0">Past entries keep the price they were recorded at. The new price is used for new entries.</p>
    <div class="f"><label for="p-price">Price per ${esc(it.unit)} (₦)</label><input class="in" id="p-price" data-testid="price-input" inputmode="decimal" value="${esc(inputMoney(it.priceKobo))}"></div>
    <div class="err" id="p-err" role="alert"></div>
    <button class="save" data-act="save-price" data-id="${esc(it.id)}" data-testid="save-price">Save price</button>`));
  const el = $('#p-price'); el.focus(); el.select();
}
async function savePrice(id) {
  const k = parseMoney($('#p-price').value);
  if (Number.isNaN(k)) { $('#p-err').textContent = 'Enter a valid price, like 1500 or 1,500.50'; return; }
  try {
    await api('PATCH', `/api/items/${id}`, { priceKobo: k });
    await refreshLists();
    toast('Price updated');
    route(); // closes the panel and redraws the page with the new price
  } catch (e) { $('#p-err').textContent = fail(e); }
}
// Adds the boss-only "Edit price" button to the item detail panel without touching panels.js.
// If you prefer, move this button into openItemDetail() in panels.js and delete this observer.
new MutationObserver(() => {
  const rm = $('#panel [data-act="rm-item-ask"]');
  if (!rm || S.role !== 'boss' || $('#panel [data-act="edit-price"]')) return;
  rm.insertAdjacentHTML('beforebegin', `<button class="b s" data-act="edit-price" data-id="${esc(rm.dataset.id)}" data-testid="edit-price">Edit price</button>`);
}).observe(document.body, { childList: true, subtree: true });

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
    else {
      const itemMatch = id.match(/^f-item-(\d+)$/);
      if (itemMatch) {
        const index = Number(itemMatch[1]), line = F.lines[index];
        if (line) {
          line.itemSearch = v; line.itemId = ''; line.price = '';
          const price = $(`#f-price-${index}`); if (price) price.value = '';
          paintItemResults(index, v);
          derive();
        }
      } else {
        const map = { 'f-paid': 'paid', 'f-amount': 'amount', 'f-note': 'note', 'f-date': 'date' };
        if (map[id]) { F[map[id]] = v; if (id === 'f-paid') F.paidTouched = true; derive(); }
      }
    }
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
  if (id === 'f-kind' && FORMS[v]) switchType(v);
});

boot();
