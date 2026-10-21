'use strict';
/* Small pure helpers: constants, text and money formatting, dates, icons, search highlighting. */

const LOW_STOCK = 5; // at or below this an item is marked "low"
const LAGOS = 'Africa/Lagos';
const DAY = 86_400_000;

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const money = (k) => { const a = Math.abs(k); return '₦' + (a / 100).toLocaleString('en-NG', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 }); };
const signed = (k) => (k < 0 ? '−' : '') + money(k);
const num = (n) => String(Math.round(n * 1000) / 1000);
const inputMoney = (k) => (k / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 }); // for filling inputs
const parseMoney = (s) => { const t = String(s).replace(/[,₦\s]/g, ''); return /^\d+(\.\d{0,2})?$/.test(t) ? Math.round(parseFloat(t) * 100) : NaN; };
const parseQty = (s) => { const t = String(s).replace(/,/g, '').trim(); const n = Number(t); return t !== '' && Number.isFinite(n) && n > 0 ? n : NaN; };
const plural = (unit, n) => (n !== 1 && /^[a-z]{3,}$/i.test(unit) && !/s$/i.test(unit) ? unit + 's' : unit);

const fmt = (d, o) => new Date(d).toLocaleDateString('en-GB', { timeZone: LAGOS, ...o });
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: LAGOS }); // YYYY-MM-DD in Lagos
const dmy = (d) => fmt(d, { day: 'numeric', month: 'short', year: 'numeric' }); // 18 Oct 2026
const dm = (d) => fmt(d, { day: 'numeric', month: 'short' });
const hm = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: LAGOS, hour: '2-digit', minute: '2-digit' });
const lagosMidnight = () => new Date(dayKey(Date.now()) + 'T00:00:00+01:00'); // Nigeria has no daylight saving
const dayLabel = (d) => (dayKey(d) === dayKey(Date.now()) ? 'Today' : dayKey(d) === dayKey(Date.now() - DAY) ? 'Yesterday' : dmy(d));
const greeting = () => { const h = Number(new Date().toLocaleString('en-GB', { timeZone: LAGOS, hour: 'numeric', hour12: false })) % 24; return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

const ICON = {
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M19 12l-7 7-7-7"/>', card: '<path d="M3 7h18v10H3zM3 11h18"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  people: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.5"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
  moneyin: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>', moneyout: '<path d="M12 21V9M7 14l5-5 5 5M4 4h16"/>',
  bag: '<path d="M6 8h12l1 12H5zM9 8V7a3 3 0 0 1 6 0v1"/>', receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>', check: '<path d="M5 12l5 5 9-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>', back: '<path d="M15 6l-6 6 6 6"/>',
};
const svg = (n, size = 20, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

/** Wrap the typed search words in <mark>, escaping everything else. */
function hl(text, q) {
  const s = String(text ?? '');
  const ws = words(q);
  if (!ws.length) return esc(s);
  const re = new RegExp('(?<![\\p{L}\\p{N}])(' + ws.map(escRe).join('|') + ')', 'giu');
  let out = '', last = 0;
  for (const m of s.matchAll(re)) { out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; }
  return out + esc(s.slice(last));
}
