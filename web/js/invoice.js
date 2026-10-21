'use strict';
/* An invoice as a picture. It is drawn on a canvas right in the browser and saved as a PNG
   (or shared, on phones that can). Nothing is sent to a server. */

const INV = { W: 760, PAD: 40, SCALE: 2, ROW: 46, FONT: "'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif" };

async function drawInvoice(e) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const { W, PAD, SCALE, ROW, FONT } = INV;
  const lines = e.lines || [];
  const sale = e.type === 'sale';
  const p = e.partyId && party(e.partyId);
  const owed = Math.max(0, e.totalKobo - e.paidKobo);
  const H = 268 + lines.length * ROW + 170 + (e.note ? 70 : 0) + 70;

  const c = document.createElement('canvas');
  c.width = W * SCALE; c.height = H * SCALE;
  const g = c.getContext('2d');
  g.scale(SCALE, SCALE);
  const say = (str, x, y, o = {}) => { g.font = `${o.weight || 500} ${o.size || 16}px ${FONT}`; g.fillStyle = o.color || '#14211C'; g.textAlign = o.align || 'left'; g.textBaseline = 'alphabetic'; g.fillText(str, x, y); };
  const fit = (str, max, size, weight) => { g.font = `${weight} ${size}px ${FONT}`; let s = String(str); if (g.measureText(s).width <= max) return s; while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1); return s + '…'; };
  const rule = (y) => { g.fillStyle = '#E1E8E4'; g.fillRect(PAD, y, W - PAD * 2, 1); };

  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  // header band
  g.fillStyle = '#0B6B4F'; g.fillRect(0, 0, W, 112);
  say(fit(bizName(), 380, 28, 700), PAD, 58, { size: 28, weight: 700, color: '#fff' });
  say(sale ? 'INVOICE' : 'PURCHASE RECORD', W - PAD, 52, { size: 22, weight: 700, color: '#fff', align: 'right' });
  say(e.invoiceNo, W - PAD, 80, { size: 16, weight: 600, color: 'rgba(255,255,255,.85)', align: 'right' });
  // who and when
  say(sale ? 'BILLED TO' : 'BOUGHT FROM', PAD, 152, { size: 12, weight: 700, color: '#5B6B65' });
  say(fit(p ? p.name : sale ? 'Walk-in customer' : 'Supplier not recorded', 380, 22, 700), PAD, 182, { size: 22, weight: 700 });
  if (p && p.phone) say(p.phone, PAD, 206, { size: 15, color: '#5B6B65' });
  say('DATE', W - PAD, 152, { size: 12, weight: 700, color: '#5B6B65', align: 'right' });
  say(`${dmy(e.date)}, ${hm(e.date)}`, W - PAD, 182, { size: 16, weight: 600, align: 'right' });
  // table
  g.fillStyle = '#F5F7F6'; g.fillRect(PAD, 232, W - PAD * 2, 36);
  const heads = { item: PAD + 14, qty: W - PAD - 300, price: W - PAD - 160, amount: W - PAD - 14 };
  say('ITEM', heads.item, 255, { size: 12, weight: 700, color: '#5B6B65' });
  say('QTY', heads.qty, 255, { size: 12, weight: 700, color: '#5B6B65', align: 'right' });
  say('PRICE', heads.price, 255, { size: 12, weight: 700, color: '#5B6B65', align: 'right' });
  say('AMOUNT', heads.amount, 255, { size: 12, weight: 700, color: '#5B6B65', align: 'right' });
  lines.forEach((l, i) => {
    const y = 268 + i * ROW, it = item(l.itemId);
    say(fit(it ? it.name : 'Removed item', heads.qty - heads.item - 90, 16, 600), heads.item, y + 29, { weight: 600 });
    say(`${num(l.qty)}${it ? ' ' + it.unit : ''}`, heads.qty, y + 29, { align: 'right', color: '#3D4C46' });
    say(money(l.unitPriceKobo), heads.price, y + 29, { align: 'right', color: '#3D4C46' });
    say(money(l.totalKobo), heads.amount, y + 29, { align: 'right', weight: 700 });
    rule(y + ROW - 1);
  });
  // totals
  let y = 268 + lines.length * ROW + 40;
  say('Total', W - PAD - 250, y, { size: 18, weight: 700 }); say(money(e.totalKobo), W - PAD - 14, y, { size: 18, weight: 700, align: 'right' });
  say('Paid', W - PAD - 250, y + 32, { color: '#3D4C46' }); say(money(e.paidKobo), W - PAD - 14, y + 32, { align: 'right', color: '#3D4C46' });
  if (owed > 0) {
    // stacked (label above the figure) so a long amount can never run into the label
    const tone = sale ? '#B42318' : '#B54708'; // money to collect is red; money you still have to pay is amber
    say(sale ? 'BALANCE DUE' : 'STILL TO PAY', W - PAD - 14, y + 74, { size: 13, weight: 700, color: tone, align: 'right' });
    say(money(owed), W - PAD - 14, y + 108, { size: 30, weight: 700, color: tone, align: 'right' });
  } else {
    g.fillStyle = '#E3F2EB'; g.beginPath(); g.roundRect(W - PAD - 190, y + 52, 190, 44, 22); g.fill();
    say('PAID IN FULL', W - PAD - 95, y + 80, { size: 16, weight: 700, color: '#0B6B4F', align: 'center' });
  }
  y = 268 + lines.length * ROW + 170;
  if (e.note) { say('NOTE', PAD, y + 4, { size: 12, weight: 700, color: '#5B6B65' }); say(fit(e.note, W - PAD * 2, 16, 500), PAD, y + 30, { color: '#3D4C46' }); }
  say('Thank you for your business', W / 2, H - 30, { size: 14, color: '#6B7A74', align: 'center' });
  return c;
}

async function invoiceFile(e) {
  const c = await drawInvoice(e);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return new File([blob], `${e.invoiceNo}.png`, { type: 'image/png' });
}

async function saveInvoiceImage(e) {
  const file = await invoiceFile(e);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved ${file.name}`);
}

const canShareImage = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch { return false; } };

async function shareInvoiceImage(e) {
  const file = await invoiceFile(e);
  try { await navigator.share({ files: [file], title: `Invoice ${e.invoiceNo}` }); }
  catch (err) { if (err.name !== 'AbortError') toast('Could not share. Use Save as image instead.', true); }
}
