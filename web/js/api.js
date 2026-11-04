'use strict';
/* Every screen talks to api(). It answers from the books on this phone, so it works with no network.
   cloud() is for the few things that need the internet (members and invites). */

const api = (method, path, body) => Eng.request(method, path, body);
async function all(path) { // follow the cursor until the last page
  const out = [];
  let next = '';
  do {
    const r = await api('GET', path + (next ? (path.includes('?') ? '&' : '?') + 'cursor=' + next : ''));
    out.push(...r.data);
    next = r.next;
  } while (next);
  return out;
}
const refreshLists = async () => { [S.parties, S.items] = await Promise.all([all('/api/parties'), all('/api/items')]); };
const index = (rows) => rows.forEach((e) => S.rows.set(e.id, e));
const learn = async (rows) => index(rows); // names are always on the phone, so there is nothing to reload

/** An access token, or null when the phone cannot get one right now (offline). */
async function token() {
  if (!A) { try { await initAuth(); } catch { return null; } }
  try { return await A.getTokenSilently(); } catch { return null; }
}
/** Talk to the cloud directly. Only for things that cannot be done offline. */
async function cloud(method, path, body) {
  const offline = () => Object.assign(new Error('You are offline. Try again when you have internet.'), { status: 0 });
  const t = await token();
  if (!t) throw offline();
  let res;
  try { res = await fetch(path, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); } catch { throw offline(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, code: data.code });
  return data;
}
