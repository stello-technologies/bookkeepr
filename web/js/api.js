'use strict';
/* Talking to the server: every call carries the access token. Also keeps names (people, items) fresh. */

async function api(method, path, body) {
  const token = await A.getTokenSilently();
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, code: data.code });
  return data;
}
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
const gone = new Set(); // ids still unknown after a refresh: removed people and items
/** Remember these entries; if they mention a person or item we haven't loaded (added elsewhere), reload the lists once. */
async function learn(rows) {
  index(rows);
  const missing = () => rows.flatMap((e) => [e.partyId && !party(e.partyId) && e.partyId, e.itemId && !item(e.itemId) && e.itemId]).filter((x) => x && !gone.has(x));
  if (!missing().length) return;
  await refreshLists();
  missing().forEach((x) => gone.add(x));
}
