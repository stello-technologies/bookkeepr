'use strict';
/* What the app remembers: the Auth0 client, the lists it has loaded, and the lookup tables used for labels. */

let A; // Auth0 client
const S = {
  user: null, parties: [], items: [], win: 'month',
  rows: new Map(), // every entry seen, by id, so a tapped row can open its detail
  E: { q: '', chip: 'all', range: '', list: [], next: null, seq: 0 },
};
let seq = 0; // bumped on every navigation so late answers are ignored
const party = (id) => S.parties.find((p) => p.id === id);
const item = (id) => S.items.find((i) => i.id === id);
const bizName = () => S.user?.name || S.user?.email || 'My business';
const initials = () => (bizName().match(/\p{L}/gu) || ['B']).slice(0, 2).join('').toUpperCase();

const WINS = { day: '24 hours', week: '7 days', month: '30 days' };
const CHIPS = { all: ['All', ''], sales: ['Sales', 'sale'], bought: ['Bought', 'purchase'], expenses: ['Expenses', 'expense'], payments: ['Payments', 'payment_in,payment_out'] };
const RANGES = { '': 'All time', today: 'Today', 7: 'Last 7 days', 30: 'Last 30 days' };
// How each category is marked everywhere (rows, tags, detail). key = colour set in lists.css; sign = what is shown before the amount.
const TYPE = {
  sale: { label: 'Sale', key: 'sale', icon: 'up', sign: '+' },
  payment_in: { label: 'Money in', key: 'in', icon: 'moneyin', sign: '+' },
  purchase: { label: 'Bought', key: 'bought', icon: 'bag', sign: '−' },
  expense: { label: 'Expense', key: 'expense', icon: 'receipt', sign: '−' },
  payment_out: { label: 'Money out', key: 'out', icon: 'moneyout', sign: '−' },
  opening_stock: { label: 'Opening stock', key: 'stock', icon: 'box', sign: '' },
};
const NAV = [{ id: 'home', label: 'Home', icon: 'home' }, { id: 'entries', label: 'Entries', icon: 'list' }, { id: 'people', label: 'People', icon: 'people' }, { id: 'inventory', label: 'Inventory', icon: 'box' }];
