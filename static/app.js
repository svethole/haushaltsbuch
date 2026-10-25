// Haushaltsbuch – Oberfläche
import {
  h, icon, catBadge, euro, euro0, plain, pct, parseAmount, iso, parseISO, today, addDays, daysBetween, isoWeek,
  mondayOf, monthStart, monthEnd, MONTHS, weekday, weekdayShort, fmtDate, fmtDateLong, fmtRange, monthShort,
  norm, api, toast, openDialog, confirmDialog, hideTip,
} from './util.js';
import { Combo } from './combo.js';
import {
  PROVIDERS, providerOf, shortLabel, CANCEL_TIP, SUB_INTERVALS, effectiveDue, activeReminder, monthlyOf, dueText, reminderLabel,
  initAlerts, refreshAlerts, browserSupport, askBrowserPermission,
} from './subs.js';
import { makeExcluder, START_LABEL } from './excluded.js';
import { columnChart, donutChart } from './charts.js';

// ---------------------------------------------------------------- Konstanten
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948',
  '#8a6a4f', '#0f8a99', '#a14fb0', '#d4a373', '#5f7a8a', '#b5651d', '#9a8f2b', '#898781'];
const CAT_ICONS = ['shopping-basket', 'shopping-cart', 'store', 'utensils', 'croissant', 'cake-slice', 'coffee', 'ice-cream-cone',
  'wine', 'beer', 'cigarette', 'car', 'fuel', 'square-parking', 'bus', 'train-front', 'bike', 'plane', 'heart-pulse', 'pill',
  'stethoscope', 'glasses', 'droplets', 'bath', 'spray-can', 'sparkles', 'scissors', 'shirt', 'house', 'sofa', 'lamp',
  'sprout', 'flower-2', 'leaf', 'wrench', 'hammer', 'yarn', 'palette', 'paintbrush', 'pencil', 'book-open', 'graduation-cap',
  'laptop', 'smartphone', 'tv', 'gamepad-2', 'music', 'film', 'ticket', 'gift', 'package', 'mail', 'phone', 'wifi', 'zap',
  'dog', 'cat', 'baby', 'dumbbell', 'landmark', 'receipt', 'banknote', 'wallet', 'coins', 'hand-coins', 'piggy-bank',
  'target', 'tag'];
const INTERVALS = { 1: 'monatlich', 2: 'alle 2 Monate', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich' };
const PRESETS = [
  ['kw', 'Aktuelle KW'], ['7d', 'Letzte 7 Tage'], ['month', 'Aktueller Monat'], ['30d', 'Letzte 30 Tage'],
  ['year', 'Aktuelles Jahr'], ['365d', 'Letzte 365 Tage'], ['custom', 'Zeitraum …'],
];

// ---------------------------------------------------------------- Zustand
const S = {
  data: null,
  view: 'erfassen',
  erf: { week: mondayOf(today()), date: today() },
  ana: { preset: 'kw', offset: 0, from: monthStart(today()), to: today(), cats: [], shops: [], sort: 'date', sortDir: -1, showRows: 50, showShops: 10 },
};
try {
  const saved = JSON.parse(localStorage.getItem('hb-ana') || 'null');
  if (saved) Object.assign(S.ana, { preset: saved.preset || 'kw', from: saved.from || S.ana.from, to: saved.to || S.ana.to });
} catch (e) { /* egal */ }
function saveAnaPrefs() {
  try { localStorage.setItem('hb-ana', JSON.stringify({ preset: S.ana.preset, from: S.ana.from, to: S.ana.to })); } catch (e) { /* egal */ }
}

const main = document.getElementById('main');
let catMap = new Map();
let EX = null; // ausgeschlossene Tage (siehe excluded.js)

function indexData() {
  catMap = new Map(S.data.categories.map(c => [c.id, c]));
  S.data.excluded = S.data.excluded || [];
  EX = makeExcluder(S.data);
}
const cat = id => catMap.get(id);
const activeCats = () => S.data.categories.filter(c => !c.archived);

function shopStats() {
  const m = new Map();
  const recent = addDays(today(), -90);
  for (const e of S.data.expenses) {
    let s = m.get(e.shop);
    if (!s) m.set(e.shop, s = { shop: e.shop, count: 0, recent: 0, sum: 0, cats: new Map(), last: e.date });
    s.count++; s.sum += e.amount;
    if (e.date >= recent) s.recent++;
    if (e.date > s.last) s.last = e.date;
    s.cats.set(e.category_id, (s.cats.get(e.category_id) || 0) + 1);
  }
  return m;
}
function catCounts() {
  const m = new Map();
  for (const e of S.data.expenses) m.set(e.category_id, (m.get(e.category_id) || 0) + 1);
  return m;
}

// ---------------------------------------------------------------- Navigation
function route() {
  const v = (location.hash || '#erfassen').slice(1);
  S.view = ['erfassen', 'auswertung', 'toepfe', 'monat', 'einstellungen'].includes(v) ? v : 'erfassen';
  document.querySelectorAll('.sidebar a').forEach(a => {
    a.classList.toggle('active', a.dataset.view === S.view);
    if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  hideTip();
  render();
}
function render() {
  if (!S.data) return;
  main.innerHTML = '';
  ({ erfassen: viewErfassen, auswertung: viewAuswertung, toepfe: viewToepfe, monat: viewMonat, einstellungen: viewEinstellungen })[S.view]();
  refreshAlerts();
}

/** Springt zum Abo in der Monatsübersicht (aus Warnleiste, Liste oder Browser-Benachrichtigung). */
function openSub(id) {
  S.focusSub = id;
  if (S.view === 'monat') render(); else location.hash = '#monat';
}

function pageHead(title, sub, ...right) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), h('div', { class: 'toolbar', style: { margin: 0 } }, ...right));
}

// ================================================================ ERFASSEN
function viewErfassen() {
  const t = today();
  const wk = isoWeek(t);
  main.append(pageHead('Erfassen', `${fmtDateLong(t)} · KW ${wk.week}`));

  const listCard = h('div', { class: 'card' });
  const sumCard = h('div', { class: 'card' });
  const formCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
  main.append(formCard, h('div', { class: 'grid-2' }, listCard, sumCard));

  const form = buildEntryForm(formCard, () => { renderList(); renderSummary(); });

  function renderList() {
    listCard.innerHTML = '';
    const from = S.erf.week, to = addDays(from, 6);
    const w = isoWeek(from);
    const nav = h('div', { class: 'week-nav' },
      h('button', { class: 'icon-btn', title: 'Vorige Woche', 'aria-label': 'Vorige Woche', onclick: () => { S.erf.week = addDays(S.erf.week, -7); renderList(); renderSummary(); } }, icon('chevron-left')),
      h('span', { class: 'label' }, `KW ${w.week} · ${fmtRange(from, to)}`),
      h('button', { class: 'icon-btn', title: 'Nächste Woche', 'aria-label': 'Nächste Woche', onclick: () => { S.erf.week = addDays(S.erf.week, 7); renderList(); renderSummary(); } }, icon('chevron-right')),
      S.erf.week !== mondayOf(t) ? h('button', { class: 'btn small ghost', onclick: () => { S.erf.week = mondayOf(t); renderList(); renderSummary(); } }, 'Heute') : null,
    );
    listCard.append(h('div', { class: 'card-head' }, h('h2', {}, 'Buchungen'), nav));
    const strip = h('div', { class: 'day-strip', role: 'group', 'aria-label': 'Tage dieser Woche' });
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = EX.reason(d);
      const day = d;
      strip.append(h('button', {
        type: 'button', class: 'day-chip' + (r ? ' ex' : '') + (d === t ? ' today' : ''),
        title: r ? `Zählt nicht in der Statistik: ${r.label} – klicken zum Ändern` : 'Klicken, um diesen Tag (oder die Woche) aus der Statistik zu nehmen',
        onclick: () => excludeDialog(day, from, () => { renderList(); renderSummary(); }),
      }, h('span', { class: 'dc-wd' }, weekdayShort(d)), h('span', { class: 'dc-d' }, parseISO(d).getDate() + '.')));
    }
    listCard.append(strip);
    const wk = EX.scan(from, to);
    if (wk.ex) listCard.append(h('div', { class: 'ex-note' }, icon('info'), wk.ex === 7 ? `Diese Woche zählt nicht in der Statistik: ${EX.describe(wk)}.` : `Nicht in der Statistik: ${EX.describe(wk)}.`));

    const items = S.data.expenses.filter(e => e.date >= from && e.date <= to);
    if (!items.length) {
      listCard.append(h('div', { class: 'empty' }, 'In dieser Woche ist noch nichts eingetragen.'));
      return;
    }
    const byDay = new Map();
    for (const e of items) (byDay.get(e.date) || byDay.set(e.date, []).get(e.date)).push(e);
    for (const d of [...byDay.keys()].sort().reverse()) {
      const list = byDay.get(d).sort((a, b) => b.id - a.id);
      const sum = list.reduce((a, e) => a + e.amount, 0);
      const g = h('div', { class: 'day-group' },
        h('div', { class: 'day-head' },
          h('span', {}, fmtDateLong(d), d === t ? h('span', { class: 'today-tag' }, 'heute') : null, EX.isExcluded(d) ? h('span', { class: 'badge' }, 'nicht in der Statistik') : null),
          h('span', { class: 'num' }, euro(sum))));
      for (const e of list) g.append(entryRow(e));
      listCard.append(g);
    }
  }

  function entryRow(e) {
    const c = cat(e.category_id);
    const exr = EX.reason(e.date);
    const row = h('div', { class: 'entry-row' + (exr ? ' ex-row' : ''), 'data-id': e.id, title: exr ? `Zählt nicht in der Statistik: ${exr.label}` : null },
      catBadge(c),
      h('div', { class: 'what' },
        h('div', { class: 'shop' }, e.shop),
        h('div', { class: 'cat' }, c ? c.name : '?', e.note ? h('span', { class: 'note' }, ' · ' + e.note) : null)),
      h('div', { class: 'amount' }, euro(e.amount)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'icon-btn', title: 'Bearbeiten', 'aria-label': 'Bearbeiten', onclick: () => form.edit(e) }, icon('pencil')),
        h('button', { class: 'icon-btn danger', title: 'Löschen', 'aria-label': 'Löschen', onclick: () => deleteExpense(e) }, icon('trash-2'))));
    if (e.id === S.erf.flash) { row.classList.add('flash'); S.erf.flash = null; }
    return row;
  }

  async function deleteExpense(e) {
    try {
      await api('DELETE', `expenses/${e.id}`);
      S.data.expenses = S.data.expenses.filter(x => x.id !== e.id);
      renderList(); renderSummary();
      toast(`${e.shop} (${euro(e.amount)}) gelöscht`, {
        action: 'Rückgängig', onAction: async () => {
          const back = await api('POST', 'expenses', { date: e.date, shop: e.shop, amount: e.amount, category_id: e.category_id, note: e.note });
          S.data.expenses.push(back);
          S.erf.flash = back.id;
          renderList(); renderSummary();
        },
      });
    } catch (err) { toast(err.message, { error: true }); }
  }

  function renderSummary() {
    sumCard.innerHTML = '';
    const from = S.erf.week, to = addDays(from, 6);
    const items = S.data.expenses.filter(e => e.date >= from && e.date <= to);
    const total = items.reduce((a, e) => a + e.amount, 0);
    const days = Math.max(1, Math.min(7, daysBetween(from, t > to ? to : t)));
    // Ø pro Tag ohne ausgeschlossene Tage; Vorwoche über die gleichen Wochentage
    const counted = items.filter(e => !EX.isExcluded(e.date)).reduce((a, e) => a + e.amount, 0);
    const cDays = EX.scan(from, addDays(from, days - 1)).included;
    const pFrom = addDays(from, -7), pTo = addDays(from, days - 8);
    const pDays = EX.scan(pFrom, pTo).included;
    const pSum = S.data.expenses.filter(e => e.date >= pFrom && e.date <= pTo && !EX.isExcluded(e.date)).reduce((a, e) => a + e.amount, 0);
    const avg = cDays ? Math.round(counted / cDays) : null;
    const prev = pDays && pSum ? Math.round(pSum / pDays) : 0;
    const prevLabel = days < 7 ? `Vorwoche bis ${weekday(addDays(from, days - 1))}` : 'Vorwoche';
    sumCard.append(h('h2', {}, 'Woche im Überblick'));
    sumCard.append(h('div', { class: 'week-summary' },
      h('div', { class: 'week-total' }, euro(total)),
      h('div', { class: 'muted' }, `${items.length} ${items.length === 1 ? 'Buchung' : 'Buchungen'}` + (avg != null ? ` · Ø ${euro(avg)} pro Tag` : ' · zählt nicht in der Statistik')),
      prev && avg != null ? h('div', { class: 'muted' }, `${prevLabel}: Ø ${euro(prev)} pro Tag (${avg >= prev ? '+' : '−'}${pct(Math.abs(avg - prev), prev)})`) : null));
    const byCat = groupByCat(items);
    if (byCat.length) {
      sumCard.append(h('div', { class: 'stackbar' }, byCat.map(x => h('span', { title: `${x.cat.name}: ${euro(x.amount)}`, style: { width: (x.amount / total * 100) + '%', background: x.cat.color } }))));
      sumCard.append(h('div', { class: 'mini-legend' }, byCat.map(x => [
        catBadge(x.cat), h('span', {}, x.cat.name), h('span', { class: 'amt' }, euro(x.amount))])));
    }
    sumCard.append(h('div', { style: { marginTop: '14px' } },
      h('a', { href: '#auswertung', onclick: () => { S.ana.preset = 'custom'; S.ana.from = from; S.ana.to = to; } }, 'Ausführliche Auswertung dieser Woche →')));
  }

  renderList();
  renderSummary();
  form.focus();
}

function groupByCat(items) {
  const m = new Map();
  for (const e of items) m.set(e.category_id, (m.get(e.category_id) || 0) + e.amount);
  return [...m].map(([id, amount]) => ({ cat: cat(id) || { name: '?', color: '#898781', icon: 'circle-help' }, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Erfassungsformular. onSaved() wird nach jedem Speichern aufgerufen. */
function buildEntryForm(card, onSaved) {
  let stats = shopStats();
  let editing = null;
  let catAuto = false;

  const dateIn = h('input', { type: 'date', value: S.erf.date, required: true });
  const shop = new Combo({
    placeholder: 'z. B. Kaufland',
    items: () => [...stats.values()].map(s => ({ value: s.shop, score: s.count + s.recent * 3, meta: s.count + '×' })),
    onCommit: v => suggestCategory(v),
  });
  const amountIn = h('input', { type: 'text', class: 'amount-input', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
  const counts = () => catCounts();
  const category = new Combo({
    placeholder: 'Kategorie',
    strict: true, toggle: true, withIcon: true,
    items: () => { const n = counts(); return activeCats().map(c => ({ value: c.name, cat: c, score: n.get(c.id) || 0, meta: (n.get(c.id) || 0) + '×' })); },
    onCreate: name => categoryDialog(null, name).then(c => c && c.name),
  });
  const noteIn = h('input', { type: 'text', placeholder: 'optional', autocomplete: 'off', maxlength: 300 });
  const hint = h('div', { class: 'field-hint' });
  category.input.addEventListener('input', () => { catAuto = false; });

  function suggestCategory(shopName) {
    const s = stats.get(shopName);
    if (!s || (category.value && !catAuto)) return;
    const best = [...s.cats].sort((a, b) => b[1] - a[1])[0];
    const c = best && cat(best[0]);
    if (c && !c.archived) { category.value = c.name; catAuto = true; }
  }

  const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('check'), 'Speichern');
  const cancelBtn = h('button', { type: 'button', class: 'btn hidden', onclick: () => reset(true) }, 'Abbrechen');
  const banner = h('div', { class: 'edit-banner hidden' });

  const f = (label, el, extra) => h('label', { class: 'field' }, label, el, extra || null);
  const form = h('form', { class: 'entry-form', novalidate: true },
    f('Datum', dateIn),
    f('Geschäft', shop.el),
    f('Betrag (€)', amountIn),
    f('Kategorie', category.el),
    f('Notiz', noteIn),
    h('div', { class: 'actions' }, saveBtn, cancelBtn));
  card.append(
    h('h2', {}, icon('plus'), 'Neue Ausgabe'),
    banner, form, hint,
    h('div', { class: 'kbd-hint' }, h('kbd', {}, 'Tab'), ' übernimmt den grauen Vorschlag · ', h('kbd', {}, '↓'), ' öffnet die Liste · ',
      h('kbd', {}, 'Enter'), ' speichert · Beträge wie ', h('kbd', {}, '3,30+2,10'), ' werden zusammengerechnet'));

  form.addEventListener('keydown', e => { if (e.key === 'Escape' && editing) reset(true); });
  dateIn.addEventListener('change', () => { S.erf.date = dateIn.value; });
  amountIn.addEventListener('blur', () => {
    const c = parseAmount(amountIn.value);
    if (c != null && amountIn.value.trim()) amountIn.value = plain(c);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    [shop.input, amountIn, category.input, dateIn].forEach(x => x.classList.remove('invalid'));
    hint.className = 'field-hint'; hint.textContent = '';
    const err = (el, msg) => { el.classList.add('invalid'); hint.className = 'field-hint error'; hint.textContent = msg; el.focus(); };
    if (!dateIn.value) return err(dateIn, 'Bitte ein Datum angeben.');
    if (!shop.value) return err(shop.input, 'Bitte das Geschäft eintragen.');
    const cents = parseAmount(amountIn.value);
    if (cents == null || cents === 0) return err(amountIn, 'Der Betrag ist nicht lesbar – z. B. 12,34 eingeben.');
    const ex = category.exact();
    if (!ex) return err(category.input, category.value ? `Die Kategorie „${category.value}“ gibt es noch nicht – in der Liste „Neue Kategorie anlegen“ wählen.` : 'Bitte eine Kategorie wählen.');
    const body = { date: dateIn.value, shop: shop.value, amount: cents, category_id: ex.cat.id, note: noteIn.value.trim() };
    saveBtn.disabled = true;
    try {
      if (editing) {
        const upd = await api('PUT', `expenses/${editing.id}`, body);
        Object.assign(S.data.expenses.find(x => x.id === editing.id), upd);
        S.erf.flash = upd.id;
        toast('Änderung gespeichert');
      } else {
        const created = await api('POST', 'expenses', body);
        S.data.expenses.push(created);
        S.erf.flash = created.id;
      }
      if (body.date < S.erf.week || body.date > addDays(S.erf.week, 6)) S.erf.week = mondayOf(body.date);
      stats = shopStats();
      reset(false);
      onSaved();
    } catch (er) {
      toast(er.message, { error: true });
    } finally {
      saveBtn.disabled = false;
    }
  });

  function reset(cancel) {
    editing = null;
    catAuto = false;
    shop.value = ''; amountIn.value = ''; category.value = ''; noteIn.value = '';
    if (cancel) dateIn.value = S.erf.date;
    banner.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    saveBtn.lastChild.textContent = 'Speichern';
    shop.input.focus();
  }

  return {
    focus: () => shop.input.focus(),
    edit(e) {
      editing = e;
      dateIn.value = e.date; shop.value = e.shop; amountIn.value = plain(e.amount);
      category.value = (cat(e.category_id) || {}).name || ''; noteIn.value = e.note || '';
      banner.innerHTML = '';
      banner.append(icon('pencil'), `Du bearbeitest „${e.shop}“ vom ${fmtDate(e.date)} – Esc bricht ab.`);
      banner.classList.remove('hidden');
      cancelBtn.classList.remove('hidden');
      saveBtn.lastChild.textContent = 'Änderung speichern';
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      amountIn.focus();
    },
  };
}

// ================================================================ AUSWERTUNG
function periodRange() {
  const a = S.ana, t = today(), o = a.offset;
  switch (a.preset) {
    case 'kw': {
      const from = addDays(mondayOf(t), 7 * o), to = addDays(from, 6);
      return { from, to, label: `KW ${isoWeek(from).week} · ${fmtRange(from, to)}`, step: true };
    }
    case '7d': { const to = addDays(t, 7 * o); return { from: addDays(to, -6), to, label: fmtRange(addDays(to, -6), to), step: true }; }
    case 'month': {
      const from = monthStart(t, o), to = monthEnd(t, o), d = parseISO(from);
      return { from, to, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, step: true };
    }
    case '30d': { const to = addDays(t, 30 * o); return { from: addDays(to, -29), to, label: fmtRange(addDays(to, -29), to), step: true }; }
    case 'year': {
      const y = parseISO(t).getFullYear() + o;
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), step: true };
    }
    case '365d': { const to = addDays(t, 365 * o); return { from: addDays(to, -364), to, label: fmtRange(addDays(to, -364), to), step: true }; }
    default: {
      let { from, to } = a;
      if (from > to) [from, to] = [to, from];
      return { from, to, label: fmtRange(from, to), step: false };
    }
  }
}

function viewAuswertung() {
  const a = S.ana;
  const P = periodRange();
  const t = today();

  // --- Kopf & Werkzeugleiste
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Zeitraum' },
    PRESETS.map(([k, label]) => h('button', {
      type: 'button', class: a.preset === k ? 'on' : '', 'aria-pressed': String(a.preset === k),
      onclick: () => {
        if (k === 'custom' && a.preset !== 'custom') { const cur = periodRange(); a.from = cur.from; a.to = cur.to; }
        a.preset = k; a.offset = 0; a.showRows = 50; saveAnaPrefs(); render();
      },
    }, label)));
  main.append(pageHead('Auswertung', null));
  main.append(h('div', { class: 'toolbar' }, seg));

  let periodCtl;
  if (P.step) {
    periodCtl = h('div', { class: 'period-nav' },
      h('button', { class: 'icon-btn', title: 'Zurück', 'aria-label': 'Zurück', onclick: () => { a.offset--; render(); } }, icon('chevron-left')),
      h('span', { class: 'period-label' }, P.label),
      h('button', { class: 'icon-btn', title: 'Weiter', 'aria-label': 'Weiter', disabled: a.offset >= 0 ? true : null, onclick: () => { a.offset++; render(); } }, icon('chevron-right')),
      a.offset !== 0 ? h('button', { class: 'btn small ghost', onclick: () => { a.offset = 0; render(); } }, 'Aktuell') : null);
  } else {
    const fromIn = h('input', { type: 'date', value: a.from, 'aria-label': 'Von' });
    const toIn = h('input', { type: 'date', value: a.to, 'aria-label': 'Bis' });
    const upd = () => { if (fromIn.value && toIn.value) { a.from = fromIn.value; a.to = toIn.value; saveAnaPrefs(); render(); } };
    fromIn.addEventListener('change', upd); toIn.addEventListener('change', upd);
    periodCtl = h('div', { class: 'custom-range' }, h('span', { class: 'muted' }, 'von'), fromIn, h('span', { class: 'muted' }, 'bis'), toIn);
  }

  const stats = shopStats();
  const n = catCounts();
  const catFilter = multiFilter('Kategorien', 'tag',
    S.data.categories.filter(c => n.get(c.id)).sort((x, y) => (n.get(y.id) || 0) - (n.get(x.id) || 0))
      .map(c => ({ key: c.id, label: c.name, cat: c, meta: n.get(c.id) + '×' })),
    a.cats, v => { a.cats = v; render(); });
  const shopFilter = multiFilter('Geschäfte', 'store',
    [...stats.values()].sort((x, y) => y.count - x.count).map(s => ({ key: s.shop, label: s.shop, meta: s.count + '×' })),
    a.shops, v => { a.shops = v; render(); }, true);
  const hasFilter = a.cats.length || a.shops.length;
  main.append(h('div', { class: 'toolbar' }, periodCtl, h('span', { style: { flex: 1 } }), catFilter, shopFilter,
    hasFilter ? h('button', { class: 'btn small ghost', onclick: () => { a.cats = []; a.shops = []; render(); } }, icon('x'), 'Filter zurücksetzen') : null));

  // --- Daten
  const catSet = new Set(a.cats), shopSet = new Set(a.shops);
  const match = e => (!catSet.size || catSet.has(e.category_id)) && (!shopSet.size || shopSet.has(e.shop));
  const withEx = !!a.withExcluded;
  const keep = d => withEx || !EX.isExcluded(d);
  const inRange = S.data.expenses.filter(e => e.date >= P.from && e.date <= P.to && match(e));
  const items = inRange.filter(e => keep(e.date));
  const skipped = inRange.length - items.length;
  const exItems = withEx ? [] : inRange.filter(e => EX.isExcluded(e.date)); // werden nur grau angezeigt
  const total = items.reduce((s, e) => s + e.amount, 0);
  const len = daysBetween(P.from, P.to);
  const elapsedTo = P.to > t ? t : P.to;
  const elapsed = elapsedTo < P.from ? 0 : daysBetween(P.from, elapsedTo);
  const sc = elapsed ? EX.scan(P.from, elapsedTo) : { all: 0, ex: 0, included: 0, beforeStart: 0, periods: [] };
  const counted = withEx ? sc.all : sc.included;
  const avgDay = counted ? total / counted : 0;
  // Vergleich über den Ø pro Tag – so stören Urlaub & Co. auch im Vorzeitraum nicht.
  // Bei laufendem Zeitraum nur der gleich lange Abschnitt davor.
  const prevFrom = addDays(P.from, -len);
  const prevEnd = elapsed < len ? addDays(prevFrom, Math.max(0, elapsed - 1)) : addDays(P.from, -1);
  const prevItems = S.data.expenses.filter(e => e.date >= prevFrom && e.date <= prevEnd && match(e) && keep(e.date));
  const psc = EX.scan(prevFrom, prevEnd);
  const prevCounted = withEx ? psc.all : psc.included;
  const prevAvg = prevCounted && prevItems.length ? prevItems.reduce((s, e) => s + e.amount, 0) / prevCounted : 0;
  const byCat = groupByCat(items);

  // --- Kennzahlen
  const diff = avgDay - prevAvg;
  const exSub = !withEx && sc.ex ? `über ${counted} Tage (${sc.ex} ausgeschlossen)` : elapsed < len ? `über ${elapsed} von ${len} Tagen` : `über ${len} Tage`;
  main.append(h('div', { class: 'kpis' },
    kpi('Summe', euro(total), `${items.length} ${items.length === 1 ? 'Buchung' : 'Buchungen'}`),
    kpi('Ø pro Tag', counted ? euro(Math.round(avgDay)) : '–', counted ? exSub : 'alle Tage ausgeschlossen'),
    kpi('Ø pro Tag ggü. davor', prevAvg && counted ? `${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff), prevAvg)}` : '–',
      prevAvg ? h('span', {}, icon(diff >= 0 ? 'trending-up' : 'trending-down'), `Ø ${euro(Math.round(prevAvg))} ${elapsed < len ? 'im gleichen Abschnitt davor' : 'im Zeitraum davor'}`) : 'keine Daten davor'),
    byCat[0] ? kpi('Größte Kategorie', byCat[0].cat.name, `${euro(byCat[0].amount)} · ${pct(byCat[0].amount, total)}`) : kpi('Größte Kategorie', '–', '')));
  const fullScan = EX.scan(P.from, P.to);
  if (fullScan.ex) {
    const toggle = h('button', { class: 'btn small', onclick: () => { a.withExcluded = !withEx; render(); } }, withEx ? 'Wieder ausblenden' : 'Trotzdem mitzählen');
    main.append(h('div', { class: 'note-box ex-box', style: { marginBottom: '16px' } }, icon('info'),
      h('span', { style: { flex: 1 } }, withEx
        ? `Ausgeschlossene Tage werden gerade mitgezählt: ${EX.describe(fullScan)}.`
        : `Nicht mitgezählt: ${EX.describe(fullScan)}` + (skipped ? ` – dabei ${skipped} ${skipped === 1 ? 'Buchung' : 'Buchungen'}.` : '.')),
      toggle));
  }

  // --- Verlauf
  const gran = len <= 62 ? 'day' : len <= 400 ? 'week' : 'month';
  const buckets = buildBuckets(P.from, P.to, gran, items, len, !withEx, exItems);
  const chartBox = h('div', { class: 'chart' });
  const chartCard = h('div', { class: 'card' },
    h('h2', {}, 'Verlauf', h('span', { class: 'sub' }, { day: 'pro Tag', week: 'pro Woche', month: 'pro Monat' }[gran])),
    chartBox);
  main.append(chartCard);
  // Ø-Linie: Ø pro gezähltem Tag × Länge eines Balkens – unabhängig von Urlaub & Co.
  let chart = null;
  const drawCols = () => {
    chart = columnChart(chartBox, {
      buckets, avg: Math.round(avgDay * { day: 1, week: 7, month: 30.44 }[gran]), avgLabel: 'Ø',
      onSelect: (i0, i1, x, y) => {
        const b0 = buckets[i0], b1 = buckets[i1];
        const label = i0 === i1 ? b0.label : `${b0.short} – ${b1.short}`;
        rangeMenu(x, y, b0.from, b1.to, label, () => chart && chart.clearSelection());
      },
    });
  };
  chartCard.querySelector('h2').append(h('span', { class: 'sub chart-hint' }, '· Balken anklicken oder darüberziehen, um Zeiträume auszunehmen'));

  // --- Kategorien
  const donutBox = h('div');
  const catTable = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Kategorie'), h('th', { class: 'num' }, 'Betrag'), h('th', { class: 'num' }, 'Anteil'), h('th', {}, ''))));
  const tbody = h('tbody');
  const rowByCat = new Map();
  for (const x of byCat) {
    const tr = h('tr', { title: 'Klick: nur diese Kategorie anzeigen', style: { cursor: 'pointer' } },
      h('td', {}, h('div', { class: 'cell-cat' }, catBadge(x.cat), x.cat.name)),
      h('td', { class: 'num' }, euro(x.amount)),
      h('td', { class: 'num muted' }, pct(x.amount, total)),
      h('td', { style: { width: '22%' } }, h('div', { class: 'sharebar' }, h('span', { style: { width: (x.amount / byCat[0].amount * 100) + '%', background: x.cat.color } }))));
    tr.addEventListener('click', () => { if (x.cat.id) { a.cats = [x.cat.id]; render(); } });
    tr.addEventListener('mouseenter', () => donut && donut.highlight(x.cat));
    tr.addEventListener('mouseleave', () => donut && donut.highlight(null));
    rowByCat.set(x.cat, tr);
    tbody.append(tr);
  }
  catTable.append(tbody);
  let donut = null;
  const catCard = h('div', { class: 'card' }, h('h2', {}, 'Nach Kategorie'),
    byCat.length ? h('div', { class: 'donut-wrap' }, donutBox, h('div', { class: 'table-scroll' }, catTable)) : h('div', { class: 'empty' }, 'Keine Ausgaben im gewählten Zeitraum.'));
  if (byCat.length) {
    donut = donutChart(donutBox, {
      slices: byCat, total,
      onHover: sl => rowByCat.forEach((tr, c) => tr.classList.toggle('hl', !!sl && sl.cat === c)),
    });
  }

  // --- Geschäfte
  const sm = new Map();
  for (const e of items) {
    const s = sm.get(e.shop) || sm.set(e.shop, { shop: e.shop, n: 0, sum: 0 }).get(e.shop);
    s.n++; s.sum += e.amount;
  }
  const shops = [...sm.values()].sort((x, y) => y.sum - x.sum);
  const shopCard = h('div', { class: 'card' }, h('h2', {}, 'Nach Geschäft'));
  if (shops.length) {
    const tb = h('tbody', {}, shops.slice(0, a.showShops).map(s => h('tr', {},
      h('td', {}, s.shop), h('td', { class: 'num muted' }, s.n + '×'), h('td', { class: 'num' }, euro(Math.round(s.sum / s.n))), h('td', { class: 'num' }, euro(s.sum)))));
    shopCard.append(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Geschäft'), h('th', { class: 'num' }, 'Einkäufe'), h('th', { class: 'num' }, 'Ø Einkauf'), h('th', { class: 'num' }, 'Summe'))), tb)));
    if (shops.length > a.showShops) shopCard.append(h('button', { class: 'btn small ghost', style: { marginTop: '8px' }, onclick: () => { a.showShops = 1000; render(); } }, `Alle ${shops.length} Geschäfte anzeigen`));
  } else shopCard.append(h('div', { class: 'empty' }, '–'));

  main.append(h('div', { class: 'grid-2', style: { marginTop: '16px' } }, catCard, shopCard));

  // --- Einzelbuchungen
  const shown = items.concat(exItems);
  const sorted = shown.slice().sort((x, y) => {
    const k = a.sort === 'amount' ? x.amount - y.amount : x.date.localeCompare(y.date) || x.id - y.id;
    return k * a.sortDir;
  });
  const sortTh = (key, label, cls = '') => h('th', {
    class: 'sortable ' + cls, onclick: () => { if (a.sort === key) a.sortDir *= -1; else { a.sort = key; a.sortDir = -1; } render(); },
  }, label, a.sort === key ? (a.sortDir < 0 ? ' ↓' : ' ↑') : '');
  const rowsCard = h('div', { class: 'card', style: { marginTop: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, 'Einzelbuchungen', h('span', { class: 'sub' }, `${items.length}` + (exItems.length ? ` · ${exItems.length} ausgegraut (zählen nicht)` : ''))),
      items.length ? h('button', { class: 'btn small', onclick: () => downloadCsv(items.slice().sort((x, y) => x.date.localeCompare(y.date)), P) }, icon('download'), 'Als CSV') : null));
  if (shown.length) {
    rowsCard.append(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, sortTh('date', 'Datum'), h('th', {}, 'Geschäft'), h('th', {}, 'Kategorie'), h('th', {}, 'Notiz'), sortTh('amount', 'Betrag', 'num'))),
      h('tbody', {}, sorted.slice(0, a.showRows).map(e => {
        const c = cat(e.category_id);
        const r = !withEx && EX.reason(e.date);
        return h('tr', { class: r ? 'ex-row' : '', title: r ? `Zählt nicht in der Statistik: ${r.label}` : null },
          h('td', { class: 'tabular', style: { whiteSpace: 'nowrap' } }, fmtDate(e.date, { weekday: true })), h('td', {}, e.shop),
          h('td', {}, h('div', { class: 'cell-cat' }, h('span', { class: 'swatch', style: { background: c.color } }), c.name)),
          h('td', { class: 'muted' }, r ? h('span', { class: 'badge' }, r.label) : null, e.note || ''), h('td', { class: 'num' }, euro(e.amount)));
      })))));
    if (shown.length > a.showRows) rowsCard.append(h('button', { class: 'btn small ghost', style: { marginTop: '8px' }, onclick: () => { a.showRows += 200; render(); } }, `Weitere anzeigen (${shown.length - a.showRows} übrig)`));
  } else rowsCard.append(h('div', { class: 'empty' }, 'Keine Buchungen für diese Auswahl.'));
  main.append(rowsCard);

  drawCols();
  observeResize(chartBox, drawCols);
}

let resizeObs = null;
function observeResize(el, fn) {
  if (resizeObs) resizeObs.disconnect();
  let w = el.clientWidth, raf = 0;
  resizeObs = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - w) < 4) return;
    w = el.clientWidth;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fn);
  });
  resizeObs.observe(el);
}

function buildBuckets(from, to, gran, items, len, markExcluded, exItems = []) {
  const t = today();
  const buckets = [];
  const index = new Map();
  const add = (key, label, short, future) => { const b = { key, label, short, total: 0, exTotal: 0, parts: new Map(), future }; buckets.push(b); index.set(key, b); };
  if (gran === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const dd = parseISO(d);
      add(d, fmtDateLong(d), len <= 10 ? `${weekdayShort(d)} ${dd.getDate()}.` : `${dd.getDate()}.${dd.getMonth() + 1}.`, d > t);
    }
  } else if (gran === 'week') {
    for (let d = mondayOf(from); d <= to; d = addDays(d, 7)) {
      add(d, `KW ${isoWeek(d).week} · ${fmtRange(d, addDays(d, 6))}`, `KW${isoWeek(d).week}`, d > t);
    }
  } else {
    for (let d = monthStart(from); d <= to; d = monthStart(d, 1)) {
      const dd = parseISO(d);
      add(d.slice(0, 7), `${MONTHS[dd.getMonth()]} ${dd.getFullYear()}`, `${monthShort(dd.getMonth())} ${String(dd.getFullYear()).slice(2)}`, d > t);
    }
  }
  const keyOf = d => gran === 'day' ? d : gran === 'week' ? mondayOf(d) : d.slice(0, 7);
  for (const e of items) {
    const b = index.get(keyOf(e.date));
    if (!b) continue;
    b.total += e.amount;
    b.parts.set(e.category_id, (b.parts.get(e.category_id) || 0) + e.amount);
  }
  for (const e of exItems) {
    const b = index.get(keyOf(e.date));
    if (b) b.exTotal += e.amount;
  }
  return buckets.map(b => {
    const out = { ...b, parts: [...b.parts].map(([id, amount]) => ({ cat: cat(id), amount })) };
    const bFrom = gran === 'month' ? b.key + '-01' : b.key;
    const bTo = gran === 'day' ? b.key : gran === 'week' ? addDays(b.key, 6) : monthEnd(bFrom);
    out.from = bFrom < from ? from : bFrom; // Tage dieses Balkens innerhalb des gewählten Zeitraums
    out.to = bTo > to ? to : bTo;
    if (markExcluded) {
      const sc = EX.scan(out.from, out.to);
      if (sc.ex) { out.ex = sc.ex / sc.all; out.exText = (sc.ex === sc.all ? 'Zählt nicht: ' : `${sc.ex} von ${sc.all} Tagen zählen nicht: `) + EX.describe(sc); }
    }
    return out;
  });
}

// ---------------------------------------------------------------- Kontextmenü für markierte Zeiträume
let ctxMenu = null;
function closeRangeMenu() {
  if (!ctxMenu) return;
  const { el, onClose, off } = ctxMenu;
  ctxMenu = null;
  el.remove(); off(); onClose && onClose();
}

/** Menü am Mauszeiger: markierten Zeitraum ausnehmen, wieder mitzählen oder genauer ansehen */
function rangeMenu(x, y, from, to, title, onClose) {
  closeRangeMenu();
  const sc = EX.scan(from, to);
  const el = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': 'Markierter Zeitraum' });
  el.append(h('div', { class: 'ctx-title' }, title),
    h('div', { class: 'ctx-sub' }, `${fmtRange(from, to)} · ${sc.all} ${sc.all === 1 ? 'Tag' : 'Tage'}` + (sc.ex ? ` · ${sc.ex === sc.all ? 'alle' : sc.ex} ausgenommen` : '')));
  const done = msg => { closeRangeMenu(); indexData(); render(); if (msg) toast(msg); };
  const fail = e => toast(e.message, { error: true });
  if (sc.included) {
    const label = h('input', { type: 'text', value: 'Urlaub', maxlength: 60, list: 'ctx-labels', 'aria-label': 'Bezeichnung', placeholder: 'Bezeichnung' });
    const labels = [...new Set(['Urlaub', 'Nicht erfasst', 'Krank', ...S.data.excluded.map(p => p.label).filter(Boolean)])];
    const go = async () => {
      try {
        const p = await api('POST', 'excluded', { day_from: from, day_to: to, label: label.value.trim() });
        S.data.excluded.push(p);
        done(`${fmtRange(from, to)} zählt nicht mehr mit`);
      } catch (e) { fail(e); }
    };
    label.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    el.append(h('div', { class: 'ctx-form' }, label, h('datalist', { id: 'ctx-labels' }, labels.map(l => h('option', { value: l })))),
      h('button', { type: 'button', class: 'ctx-item', role: 'menuitem', onclick: go }, icon('bell-off'), 'Markierten Zeitraum ausschließen'));
    setTimeout(() => { label.focus(); label.select(); }, 0);
  }
  if (sc.ex) {
    el.append(h('button', { type: 'button', class: 'ctx-item', role: 'menuitem', onclick: async () => {
      try { await includeRange(from, to, sc); done(`${fmtRange(from, to)} zählt wieder mit`); } catch (e) { fail(e); }
    } }, icon('circle-check'), sc.ex === sc.all ? 'Zeitraum wieder aktivieren' : 'Ausgenommene Tage wieder aktivieren',
      sc.beforeStart ? h('span', { class: 'ctx-note' }, `Erfassungsbeginn wird auf ${fmtDate(from)} vorverlegt`) : null));
  }
  el.append(h('button', { type: 'button', class: 'ctx-item', role: 'menuitem', onclick: () => {
    S.ana.preset = 'custom'; S.ana.from = from; S.ana.to = to; S.ana.offset = 0; saveAnaPrefs(); closeRangeMenu(); render();
  } }, icon('search'), 'Nur diesen Zeitraum anzeigen'),
  h('button', { type: 'button', class: 'ctx-item muted', role: 'menuitem', onclick: closeRangeMenu }, icon('x'), 'Abbrechen'));
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x + 6, window.innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y + 6, window.innerHeight - r.height - 8)) + 'px';
  const outside = e => { if (!el.contains(e.target)) closeRangeMenu(); };
  const key = e => { if (e.key === 'Escape') closeRangeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  document.addEventListener('keydown', key);
  window.addEventListener('hashchange', closeRangeMenu, { once: true });
  ctxMenu = { el, onClose, off: () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); } };
}

/** Nimmt from..to wieder in die Statistik auf: Zeiträume löschen, kürzen oder teilen */
async function includeRange(from, to, sc) {
  for (const p of S.data.excluded.filter(q => q.day_from <= to && q.day_to >= from)) {
    const left = p.day_from < from, right = p.day_to > to, origTo = p.day_to;
    if (!left && !right) {
      await api('DELETE', `excluded/${p.id}`);
      S.data.excluded = S.data.excluded.filter(q => q.id !== p.id);
    } else {
      if (left) Object.assign(p, await api('PUT', `excluded/${p.id}`, { day_from: p.day_from, day_to: addDays(from, -1), label: p.label }));
      else Object.assign(p, await api('PUT', `excluded/${p.id}`, { day_from: addDays(to, 1), day_to: p.day_to, label: p.label }));
      if (left && right) S.data.excluded.push(await api('POST', 'excluded', { day_from: addDays(to, 1), day_to: origTo, label: p.label }));
    }
  }
  if (sc.beforeStart) { // Tage vor Beginn der Erfassung: Beginn vorverlegen
    const r = await api('PUT', 'settings', { tracking_start: from });
    S.data.settings.tracking_start = r.tracking_start;
  }
}

function kpi(label, value, sub) {
  return h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-value' }, value), h('div', { class: 'k-sub' }, sub));
}

/** Filter-Schaltfläche mit Auswahlliste (Mehrfachauswahl). */
function multiFilter(label, ico, options, selected, onChange, searchable = false) {
  const wrap = h('div', { class: 'filter-pop' });
  const sel = new Set(selected);
  const chip = h('button', { type: 'button', class: 'chip' + (sel.size ? ' on' : ''), 'aria-haspopup': 'true' },
    icon(ico), label, sel.size ? h('span', { class: 'count' }, sel.size) : null, icon('chevron-down'));
  wrap.append(chip);
  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; document.removeEventListener('mousedown', outside); } };
  const outside = e => { if (!wrap.contains(e.target)) { close(); if (changed) onChange([...sel]); } };
  let changed = false;
  chip.addEventListener('click', () => {
    if (pop) { close(); if (changed) onChange([...sel]); return; }
    changed = false;
    const opts = h('div', { class: 'opts' });
    const search = searchable ? h('input', { type: 'text', placeholder: 'Suchen …', autocomplete: 'off' }) : null;
    const draw = () => {
      opts.innerHTML = '';
      const q = search ? norm(search.value.trim()) : '';
      for (const o of options) {
        if (q && !norm(o.label).includes(q)) continue;
        const cb = h('input', { type: 'checkbox', checked: sel.has(o.key) });
        cb.addEventListener('change', () => { cb.checked ? sel.add(o.key) : sel.delete(o.key); changed = true; });
        opts.append(h('label', { class: 'opt' }, cb, o.cat ? catBadge(o.cat) : null, o.label, h('span', { class: 'meta' }, o.meta || '')));
      }
      if (!opts.children.length) opts.append(h('div', { class: 'empty' }, 'Nichts gefunden'));
    };
    if (search) search.addEventListener('input', draw);
    draw();
    pop = h('div', { class: 'popover' }, search, opts,
      h('div', { class: 'pop-foot' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { sel.clear(); close(); onChange([]); } }, 'Alle'),
        h('button', { type: 'button', class: 'btn small primary', onclick: () => { close(); onChange([...sel]); } }, 'Anwenden')));
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); chip.focus(); } });
    wrap.append(pop);
    document.addEventListener('mousedown', outside);
    (search || pop.querySelector('input'))?.focus();
  });
  return wrap;
}

function downloadCsv(rows, P) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['Datum;Geschäft;Kategorie;Betrag;Notiz', ...rows.map(e => [fmtDate(e.date), q(e.shop), q(cat(e.category_id).name), plain(e.amount), q(e.note || '')].join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: `ausgaben_${P.from}_${P.to}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ================================================================ SPARTÖPFE
function potBalance(id) { return S.data.pot_tx.filter(t => t.pot_id === id).reduce((a, t) => a + t.amount, 0); }

function viewToepfe() {
  const pots = S.data.pots.filter(p => !p.archived);
  const total = pots.reduce((a, p) => a + potBalance(p.id), 0);
  main.append(pageHead('Spartöpfe', 'Rücklagen und Sparziele im Blick',
    h('button', { class: 'btn primary', onclick: () => potDialog(null) }, icon('plus'), 'Neuer Spartopf')));
  main.append(h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
    kpi('Insgesamt zurückgelegt', euro(total), `in ${pots.length} Töpfen`)));
  const grid = h('div', { class: 'pots' });
  for (const p of pots) grid.append(potCard(p));
  grid.append(h('button', { type: 'button', class: 'card pot-new', onclick: () => potDialog(null) }, h('div', { style: { textAlign: 'center' } }, icon('plus'), h('div', {}, 'Neuen Topf anlegen'))));
  main.append(grid);
}

function potCard(p) {
  const bal = potBalance(p.id);
  const txs = S.data.pot_tx.filter(t => t.pot_id === p.id).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const card = h('div', { class: 'card' },
    h('div', { class: 'pot-head' }, catBadge(p, true),
      h('div', {}, h('div', { class: 'name' }, p.name), p.note ? h('div', { class: 'note' }, p.note) : null),
      h('button', { class: 'icon-btn', title: 'Bearbeiten', 'aria-label': 'Topf bearbeiten', onclick: () => potDialog(p) }, icon('settings'))),
    h('div', { class: 'pot-balance' }, euro(bal)));
  if (p.target) {
    const share = Math.max(0, Math.min(1, bal / p.target));
    card.append(h('div', { class: 'progress' }, h('span', { style: { width: share * 100 + '%', background: p.color } })),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, `${pct(Math.max(0, bal), p.target)} von ${euro(p.target)}` + (bal < p.target ? ` · noch ${euro(p.target - bal)}` : ' · Ziel erreicht 🎉')));
  }
  card.append(h('div', { class: 'pot-actions' },
    h('button', { class: 'btn', onclick: () => potTxDialog(p, 1) }, icon('arrow-down-left'), 'Einzahlen'),
    h('button', { class: 'btn', onclick: () => potTxDialog(p, -1) }, icon('arrow-up-right'), 'Entnehmen')));
  if (txs.length) {
    const hist = h('div', { class: 'pot-history' });
    let showAll = false;
    const draw = () => {
      hist.innerHTML = '';
      for (const t of (showAll ? txs : txs.slice(0, 4))) {
        hist.append(h('div', { class: 'tx' },
          h('span', { class: 'muted num' }, fmtDate(t.date)),
          h('span', { class: 'muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.note || (t.amount > 0 ? 'Einzahlung' : 'Entnahme')),
          h('span', { class: 'num' + (t.amount > 0 ? ' pos' : '') }, (t.amount > 0 ? '+' : '−') + euro(Math.abs(t.amount))),
          h('button', { class: 'icon-btn danger', style: { width: '26px', height: '26px' }, title: 'Buchung löschen', 'aria-label': 'Buchung löschen', onclick: () => delTx(t) }, icon('x'))));
      }
      if (txs.length > 4) hist.append(h('button', { class: 'btn small ghost', onclick: () => { showAll = !showAll; draw(); } }, showAll ? 'Weniger' : `Alle ${txs.length} Buchungen`));
    };
    draw();
    card.append(hist);
  }
  return card;

  async function delTx(t) {
    if (!(await confirmDialog('Buchung löschen?', `${fmtDate(t.date)}: ${euro(t.amount)} aus „${p.name}“ löschen?`))) return;
    try {
      await api('DELETE', `pot_tx/${t.id}`);
      S.data.pot_tx = S.data.pot_tx.filter(x => x.id !== t.id);
      render();
    } catch (e) { toast(e.message, { error: true }); }
  }
}

function potTxDialog(p, sign) {
  openDialog(sign > 0 ? `In „${p.name}“ einzahlen` : `Aus „${p.name}“ entnehmen`, (form, close) => {
    const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', placeholder: '0,00', required: true });
    const d = h('input', { type: 'date', value: today(), required: true });
    const note = h('input', { type: 'text', placeholder: sign > 0 ? 'z. B. Monatsrate' : 'z. B. Grafikkarte gekauft', maxlength: 300 });
    const hint = h('div', { class: 'field-hint' });
    form.append(
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Betrag (€)', amt), h('label', { class: 'field' }, 'Datum', d)),
      h('label', { class: 'field' }, 'Notiz', note), hint,
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, sign > 0 ? 'Einzahlen' : 'Entnehmen')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const c = parseAmount(amt.value);
      if (!c || c < 0) { hint.className = 'field-hint error'; hint.textContent = 'Bitte einen gültigen Betrag eingeben.'; amt.focus(); return; }
      try {
        const tx = await api('POST', 'pot_tx', { pot_id: p.id, date: d.value, amount: sign * c, note: note.value.trim() });
        S.data.pot_tx.push(tx);
        close(); render();
      } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
    });
  });
}

function potDialog(p) {
  const isNew = !p;
  openDialog(isNew ? 'Neuer Spartopf' : 'Spartopf bearbeiten', (form, close) => {
    const name = h('input', { type: 'text', value: p ? p.name : '', required: true, maxlength: 40, placeholder: 'z. B. Urlaub' });
    const target = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', value: p && p.target ? plain(p.target) : '', placeholder: 'optional' });
    const note = h('input', { type: 'text', value: p ? p.note : '', maxlength: 300, placeholder: 'optional' });
    const style = stylePicker(p ? p.color : PALETTE[0], p ? p.icon : 'piggy-bank');
    const hint = h('div', { class: 'field-hint' });
    form.append(
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Sparziel (€)', target)),
      h('label', { class: 'field' }, 'Notiz', note), style.el, hint,
      h('div', { class: 'dlg-actions' },
        !isNew ? h('button', { type: 'button', class: 'btn danger left', onclick: del }, icon('trash-2'), 'Löschen') : null,
        h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const tc = target.value.trim() ? parseAmount(target.value) : null;
      if (target.value.trim() && (!tc || tc < 0)) { hint.className = 'field-hint error'; hint.textContent = 'Das Sparziel ist kein gültiger Betrag.'; return; }
      const body = { name: name.value.trim(), target: tc, note: note.value.trim(), color: style.color, icon: style.icon };
      try {
        if (isNew) S.data.pots.push(await api('POST', 'pots', body));
        else Object.assign(p, await api('PUT', `pots/${p.id}`, body));
        close(); render();
      } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
    });
    async function del() {
      close();
      if (!(await confirmDialog('Spartopf löschen?', `„${p.name}“ und alle seine Buchungen werden gelöscht. Das lässt sich nicht rückgängig machen.`))) return;
      try {
        await api('DELETE', `pots/${p.id}`);
        S.data.pots = S.data.pots.filter(x => x.id !== p.id);
        S.data.pot_tx = S.data.pot_tx.filter(x => x.pot_id !== p.id);
        render();
      } catch (er) { toast(er.message, { error: true }); }
    }
  });
}

/** Farb- und Symbolauswahl für Kategorien und Töpfe */
function stylePicker(color, ico) {
  const st = { color, icon: ico };
  const preview = h('span');
  const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Farbe' });
  const ig = h('div', { class: 'icon-grid', role: 'radiogroup', 'aria-label': 'Symbol' });
  const draw = () => {
    preview.replaceChildren(catBadge(st, true));
    sw.replaceChildren(...PALETTE.map(c => h('button', {
      type: 'button', class: c === st.color ? 'on' : '', style: { background: c }, title: c, 'aria-label': 'Farbe ' + c,
      onclick: () => { st.color = c; draw(); },
    })));
    ig.replaceChildren(...CAT_ICONS.map(n => h('button', {
      type: 'button', class: n === st.icon ? 'on' : '', title: n, 'aria-label': n, onclick: () => { st.icon = n; draw(); },
    }, icon(n))));
  };
  draw();
  const el = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    h('div', { class: 'field' }, h('span', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, 'Farbe & Symbol', preview), sw), ig);
  return { el, get color() { return st.color; }, get icon() { return st.icon; } };
}

// ================================================================ MONATSÜBERBLICK
function viewMonat() {
  const rec = S.data.recurring;
  const monthly = r => Math.round(r.amount / r.interval);
  const act = rec.filter(r => r.active);
  const inc = act.filter(r => r.kind === 'income').reduce((a, r) => a + monthly(r), 0);
  const fix = act.filter(r => r.kind === 'expense').reduce((a, r) => a + monthly(r), 0);
  const from = addDays(today(), -90);
  const d90 = EX.scan(addDays(from, 1), today()).included;
  const daily = d90 ? Math.round(S.data.expenses.filter(e => e.date > from && e.date <= today() && !EX.isExcluded(e.date)).reduce((a, e) => a + e.amount, 0) / d90 * 30.44) : 0;
  const subs = S.data.subs || [];
  const activeSubs = subs.filter(x => x.status === 'active');
  const subMonthly = activeSubs.reduce((a, x) => a + monthlyOf(x), 0);
  const rest = inc - fix - subMonthly - daily;

  main.append(pageHead('Monatsüberblick', 'Regelmäßige Einnahmen und Fixkosten – als grober Überblick',
    h('button', { class: 'btn', onclick: () => recDialog(null, 'income') }, icon('plus'), 'Einnahme'),
    h('button', { class: 'btn', onclick: () => recDialog(null, 'expense') }, icon('plus'), 'Fixkosten'),
    h('button', { class: 'btn', onclick: () => subDialog(null) }, icon('plus'), 'Abo')));
  main.append(h('div', { class: 'balance-row' },
    kpi('Einnahmen pro Monat', euro(inc), `${act.filter(r => r.kind === 'income').length} Posten`),
    kpi('Fixkosten & Abos pro Monat', euro(fix + subMonthly), `${act.filter(r => r.kind === 'expense').length} Posten · davon Abos ${euro(subMonthly)}`),
    kpi('Tagesausgaben pro Monat', euro(daily), d90 < 90 ? `Ø der letzten 90 Tage (${90 - d90} ausgeschlossen)` : 'Ø der letzten 90 Tage'),
    inc ? kpi('Bleibt rechnerisch übrig', euro(rest), rest >= 0 ? h('span', { style: { color: 'var(--good)' } }, icon('check'), 'im Plus') : h('span', { style: { color: 'var(--danger)' } }, icon('info'), 'im Minus'))
      : kpi('Bleibt rechnerisch übrig', '–', 'erst Einnahmen eintragen')));
  if (!rec.length) {
    main.append(h('div', { class: 'note-box', style: { marginBottom: '16px' } }, icon('info'),
      h('span', {}, 'Trag hier nach und nach ein, was regelmäßig rein- und rausgeht: Gehalt, Rente, Miete, Verträge, Abos, Raten. Bei schwankenden Beträgen (z. B. Gehalt mit Zulagen) einfach einen groben Mittelwert nehmen und „schwankt“ ankreuzen. Jährliche oder vierteljährliche Posten werden automatisch auf den Monat umgerechnet.')));
  }
  main.append(h('div', { class: 'grid-2' }, recCard('income', 'Einnahmen'), recCard('expense', 'Fixkosten')));
  main.append(subsCard());
  if (S.focusSub) {
    const el = document.getElementById('sub-' + S.focusSub);
    S.focusSub = null;
    if (el) requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); });
  }

  function subsCard() {
    const t = today();
    const list = activeSubs.map(x => ({ x, due: effectiveDue(x, t), r: activeReminder(x, t) })).sort((a, b) => a.due.localeCompare(b.due));
    const cancelled = subs.filter(x => x.status === 'cancelled');
    const card = h('div', { class: 'card', id: 'abos', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Abos', activeSubs.length ? h('span', { class: 'sub' }, `${euro(subMonthly)} / Monat · ${euro(subMonthly * 12)} / Jahr`) : null),
        h('button', { class: 'btn small', onclick: () => subDialog(null) }, icon('plus'), 'Abo hinzufügen')));
    if (!subs.length) {
      card.append(h('div', { class: 'empty' }, 'Noch keine Abos eingetragen. Netflix, Spotify, App-Abos, Amazon Prime … alles, was regelmäßig abbucht und sich kündigen lässt.'));
      return card;
    }
    const box = h('div', { class: 'sub-list' });
    for (const { x, due, r } of list) box.append(subRow(x, due, r));
    if (!list.length) box.append(h('div', { class: 'empty' }, 'Keine laufenden Abos.'));
    card.append(box);
    if (cancelled.length) {
      const det = h('details', { class: 'sub-cancelled' }, h('summary', {}, `Gekündigt (${cancelled.length})`));
      for (const x of cancelled) det.append(subRow(x, null, null));
      card.append(det);
    }
    return card;
  }

  function subRow(x, due, r) {
    const pv = providerOf(x.provider);
    const t = today();
    const meta = [];
    if (due) meta.push(h('span', {}, `nächste Abbuchung ${fmtDate(due, { weekday: true })} · ${dueText(due, t)}`));
    else meta.push(h('span', {}, 'gekündigt'));
    meta.push(h('span', {}, SUB_INTERVALS[x.interval]));
    if (x.provider !== 'other') meta.push(h('span', {}, shortLabel(pv)));
    const remind = x.status === 'active' && x.remind_mode !== 'none'
      ? h('span', { class: 'remind-chip' + (r ? ' due' : ''), title: 'Erinnerung' }, icon(r ? 'bell-ring' : 'bell'), reminderLabel(x)) : null;
    const row = h('div', { class: 'sub-row' + (r ? ' alerting' : '') + (x.status === 'cancelled' ? ' inactive' : ''), id: 'sub-' + x.id },
      catBadge({ color: pv.color, icon: pv.icon }),
      h('div', { class: 'sub-main' },
        h('div', { class: 'r-name' }, x.name, remind),
        h('div', { class: 'r-meta' }, meta.reduce((acc, m, i) => (i ? [...acc, ' · ', m] : [m]), [])),
        x.note ? h('div', { class: 'r-meta' }, x.note) : null),
      h('div', { class: 'r-amt' }, euro(x.amount), x.interval > 1 ? h('small', {}, `≈ ${euro(monthlyOf(x))} / Monat`) : null),
      h('div', { class: 'sub-actions' },
        x.url ? h('a', { class: 'btn small', href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.url }, icon('external-link'), x.status === 'active' ? 'Kündigen' : 'Öffnen') : null,
        h('button', { class: 'icon-btn', title: 'Bearbeiten', 'aria-label': 'Abo bearbeiten', onclick: () => subDialog(x) }, icon('pencil'))));
    if (r) {
      const upd = async (body, msg) => {
        try { Object.assign(x, await api('PUT', `subs/${x.id}`, body)); render(); if (msg) toast(msg); }
        catch (e) { toast(e.message, { error: true }); }
      };
      row.append(h('div', { class: 'sub-alert' },
        icon('triangle-alert'),
        h('span', {}, x.remind_mode === 'date' ? `${x.remind_date === t ? 'Erinnerung für heute' : `Erinnerung vom ${fmtDate(x.remind_date)}`} – kündigen oder behalten?` : `Die nächste Abbuchung ist ${dueText(r.due, t)} – kündigen oder behalten?`),
        h('span', { class: 'sub-alert-actions' },
          h('button', { class: 'btn small', onclick: () => upd({ status: 'cancelled' }, `„${x.name}“ als gekündigt markiert`) }, icon('circle-check'), 'Ist gekündigt'),
          h('button', { class: 'btn small', onclick: () => upd({ ack_key: r.key, snooze_until: null }, 'Erinnerung erledigt') }, 'Behalten'),
          h('button', { class: 'btn small', onclick: () => upd({ snooze_until: addDays(t, 3) }, 'Ich erinnere Dich in 3 Tagen nochmal') }, icon('alarm-clock'), 'In 3 Tagen'))));
    }
    return row;
  }

  function recCard(kind, title) {
    const list = rec.filter(r => r.kind === kind);
    const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title),
      h('button', { class: 'btn small', onclick: () => recDialog(null, kind) }, icon('plus'), 'Hinzufügen')));
    if (!list.length) { card.append(h('div', { class: 'empty' }, 'Noch nichts eingetragen.')); return card; }
    const groups = new Map();
    for (const r of list) (groups.get(r.grp || 'Ohne Gruppe') || groups.set(r.grp || 'Ohne Gruppe', []).get(r.grp || 'Ohne Gruppe')).push(r);
    const box = h('div', { class: 'rec-list' });
    for (const [g, rs] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
      const gsum = rs.filter(r => r.active).reduce((a, r) => a + monthly(r), 0);
      box.append(h('div', { class: 'group-title', style: { display: 'flex', justifyContent: 'space-between' } }, h('span', {}, g), h('span', { class: 'num' }, euro(gsum))));
      for (const r of rs.sort((a, b) => monthly(b) - monthly(a))) {
        box.append(h('div', { class: 'rec' + (r.active ? '' : ' inactive') },
          h('div', {}, h('div', { class: 'r-name' }, r.name,
            r.variable ? h('span', { class: 'badge' }, 'schwankt') : null,
            !r.active ? h('span', { class: 'badge' }, 'pausiert') : null),
            h('div', { class: 'r-meta' }, INTERVALS[r.interval] + (r.note ? ' · ' + r.note : ''))),
          h('div', { class: 'r-amt' }, (r.variable ? '≈ ' : '') + euro(r.amount), r.interval > 1 ? h('small', {}, `≈ ${euro(monthly(r))} / Monat`) : null),
          h('button', { class: 'icon-btn', title: 'Bearbeiten', 'aria-label': 'Bearbeiten', onclick: () => recDialog(r) }, icon('pencil'))));
      }
    }
    card.append(box);
    return card;
  }
}

function subDialog(x) {
  const isNew = !x;
  const st = S.data.settings || {};
  x = x || { name: '', provider: 'other', url: '', amount: 0, interval: 1, next_due: today(), note: '', status: 'active',
    remind_mode: 'before', remind_days: 7, remind_date: null, ch_page: 1, ch_browser: 0, ch_email: 0 };
  openDialog(isNew ? 'Neues Abo' : 'Abo bearbeiten', (form, close) => {
    const prov = h('select', {}, PROVIDERS.map(p => h('option', { value: p.key, selected: p.key === x.provider }, p.label)));
    const name = h('input', { type: 'text', value: x.name, maxlength: 80, placeholder: 'z. B. Netflix Standard' });
    const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', value: x.amount ? plain(x.amount) : '', placeholder: '0,00' });
    const intv = h('select', {}, Object.entries(SUB_INTERVALS).map(([k, v]) => h('option', { value: k, selected: Number(k) === x.interval }, v)));
    const due = h('input', { type: 'date', value: x.next_due });
    const url = h('input', { type: 'url', value: x.url, maxlength: 500, placeholder: 'https://…' });
    const urlHint = h('div', { class: 'field-hint' });
    const note = h('input', { type: 'text', value: x.note, maxlength: 300, placeholder: 'z. B. Probeabo bis 15.11., Kündigungsfrist 1 Monat' });
    const mode = h('select', {},
      h('option', { value: 'none', selected: x.remind_mode === 'none' }, 'Keine Erinnerung'),
      h('option', { value: 'before', selected: x.remind_mode === 'before' }, 'Vor jeder Abbuchung'),
      h('option', { value: 'date', selected: x.remind_mode === 'date' }, 'An einem bestimmten Tag'));
    const days = h('input', { type: 'number', min: 0, max: 365, value: x.remind_days, style: { width: '90px' } });
    const rdate = h('input', { type: 'date', value: x.remind_date || addDays(today(), 7) });
    const chPage = h('input', { type: 'checkbox', checked: !!x.ch_page });
    const chBrowser = h('input', { type: 'checkbox', checked: !!x.ch_browser });
    const chEmail = h('input', { type: 'checkbox', checked: !!x.ch_email });
    const cancelled = h('input', { type: 'checkbox', checked: x.status === 'cancelled' });
    const hint = h('div', { class: 'field-hint' });
    const daysRow = h('label', { class: 'check-row' }, days, 'Tage vor der Abbuchung erinnern');
    const dateRow = h('label', { class: 'field' }, 'Erinnern am', rdate);
    const chans = h('div', { class: 'chan-row' },
      h('label', { class: 'check-row' }, chPage, 'Auf der Seite'),
      h('label', { class: 'check-row' }, chBrowser, 'Im Browser'),
      h('label', { class: 'check-row' }, chEmail, 'Per E-Mail'));
    const chanHint = h('div', { class: 'field-hint' });
    const drawMode = () => {
      daysRow.classList.toggle('hidden', mode.value !== 'before');
      dateRow.classList.toggle('hidden', mode.value !== 'date');
      chans.classList.toggle('hidden', mode.value === 'none');
      const notes = [];
      if (mode.value !== 'none' && chBrowser.checked && (!browserSupport() || Notification.permission !== 'granted')) notes.push('Browser-Benachrichtigungen musst Du unter Einstellungen noch erlauben.');
      if (mode.value !== 'none' && chEmail.checked && (!st.smtp_configured || !st.notify_email)) notes.push(st.smtp_configured ? 'Unter Einstellungen fehlt noch Deine E-Mail-Adresse.' : 'Der E-Mail-Versand ist auf dem Server noch nicht eingerichtet (siehe Einstellungen).');
      chanHint.textContent = notes.join(' ');
      chanHint.classList.toggle('hidden', mode.value === 'none' || !notes.length);
    };
    let lastPreset = providerOf(x.provider).url;
    const drawProv = () => {
      const p = providerOf(prov.value);
      if (!url.value.trim() || url.value.trim() === lastPreset) url.value = p.url;
      lastPreset = p.url;
      name.placeholder = p.key === 'other' ? 'z. B. Fitnessstudio-App' : shortLabel(p);
      urlHint.textContent = p.hint || (p.url ? '' : CANCEL_TIP);
    };
    prov.addEventListener('change', drawProv);
    [mode, chBrowser, chEmail].forEach(el => el.addEventListener('change', drawMode));
    drawProv(); drawMode();
    form.append(
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Anbieter', prov), h('label', { class: 'field' }, 'Name', name)),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Betrag (€)', amt), h('label', { class: 'field' }, 'Rhythmus', intv)),
      h('label', { class: 'field' }, 'Nächste Abbuchung', due),
      h('label', { class: 'field' }, 'Webseite zum Kündigen / Verwalten', url, urlHint),
      h('label', { class: 'field' }, 'Notiz', note),
      h('fieldset', { class: 'remind-box' }, h('legend', {}, icon('bell'), 'Kündigungs-Erinnerung'),
        mode, daysRow, dateRow, chans, chanHint),
      h('label', { class: 'check-row' }, cancelled, 'Gekündigt (läuft nicht mehr, zählt nicht mit)'),
      hint,
      h('div', { class: 'dlg-actions' },
        !isNew ? h('button', { type: 'button', class: 'btn danger left', onclick: del }, icon('trash-2'), 'Löschen') : null,
        h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const err = (msg, el) => { hint.className = 'field-hint error'; hint.textContent = msg; if (el) el.focus(); };
      const c = amt.value.trim() ? parseAmount(amt.value) : 0;
      if (c == null || c < 0) return err('Bitte einen gültigen Betrag eingeben.', amt);
      if (!name.value.trim() && prov.value === 'other') return err('Bitte einen Namen eingeben.', name);
      if (!due.value) return err('Bitte das Datum der nächsten Abbuchung eingeben.', due);
      const d = parseInt(days.value, 10);
      if (mode.value === 'before' && (isNaN(d) || d < 0 || d > 365)) return err('Tage vor der Abbuchung: 0 bis 365.', days);
      if (mode.value === 'date' && !rdate.value) return err('Bitte ein Erinnerungsdatum wählen.', rdate);
      const body = {
        name: name.value.trim() || shortLabel(providerOf(prov.value)), provider: prov.value, url: url.value.trim(), amount: c,
        interval: Number(intv.value), next_due: due.value, note: note.value.trim(),
        status: cancelled.checked ? 'cancelled' : 'active',
        remind_mode: mode.value, remind_days: isNaN(d) ? 7 : d, remind_date: mode.value === 'date' ? rdate.value : null,
        ch_page: chPage.checked, ch_browser: chBrowser.checked, ch_email: chEmail.checked,
      };
      try {
        if (isNew) S.data.subs.push(await api('POST', 'subs', body));
        else Object.assign(x, await api('PUT', `subs/${x.id}`, body));
        S.focusSub = isNew ? S.data.subs[S.data.subs.length - 1].id : x.id;
        close(); render();
      } catch (er) { err(er.message); }
    });
    async function del() {
      close();
      if (!(await confirmDialog('Abo löschen?', `„${x.name}“ löschen? Wenn Du es nur gekündigt hast, markier es besser als „gekündigt“ – dann bleibt es in der Liste.`))) return;
      try {
        await api('DELETE', `subs/${x.id}`);
        S.data.subs = S.data.subs.filter(y => y.id !== x.id);
        render();
      } catch (er) { toast(er.message, { error: true }); }
    }
  });
}

function recDialog(r, kind) {
  const isNew = !r;
  r = r || { kind, name: '', amount: 0, interval: 1, grp: '', variable: 0, note: '', active: 1 };
  openDialog(isNew ? (r.kind === 'income' ? 'Neue Einnahme' : 'Neue Fixkosten') : 'Posten bearbeiten', (form, close) => {
    const kindSel = h('select', {}, h('option', { value: 'income', selected: r.kind === 'income' }, 'Einnahme'), h('option', { value: 'expense', selected: r.kind === 'expense' }, 'Ausgabe / Fixkosten'));
    const name = h('input', { type: 'text', value: r.name, maxlength: 80, placeholder: r.kind === 'income' ? 'z. B. Gehalt' : 'z. B. Miete' });
    const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', value: r.amount ? plain(r.amount) : '', placeholder: '0,00' });
    const intv = h('select', {}, Object.entries(INTERVALS).map(([k, v]) => h('option', { value: k, selected: Number(k) === r.interval }, v)));
    const groups = [...new Set(S.data.recurring.map(x => x.grp).filter(Boolean))];
    const dl = h('datalist', { id: 'grp-list' }, groups.map(g => h('option', { value: g })));
    const grp = h('input', { type: 'text', value: r.grp, list: 'grp-list', maxlength: 40, placeholder: 'z. B. Wohnen, Verträge, Abos' });
    const variable = h('input', { type: 'checkbox', checked: !!r.variable });
    const active = h('input', { type: 'checkbox', checked: !!r.active });
    const note = h('input', { type: 'text', value: r.note, maxlength: 300, placeholder: 'optional' });
    const hint = h('div', { class: 'field-hint' });
    form.append(
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Art', kindSel), h('label', { class: 'field' }, 'Bezeichnung', name)),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Betrag (€)', amt), h('label', { class: 'field' }, 'Rhythmus', intv)),
      h('label', { class: 'field' }, 'Gruppe', grp, dl),
      h('label', { class: 'field' }, 'Notiz', note),
      h('label', { class: 'check-row' }, variable, 'Betrag schwankt (Mittelwert eintragen)'),
      h('label', { class: 'check-row' }, active, 'Aktiv (in die Summen einrechnen)'),
      hint,
      h('div', { class: 'dlg-actions' },
        !isNew ? h('button', { type: 'button', class: 'btn danger left', onclick: del }, icon('trash-2'), 'Löschen') : null,
        h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const c = parseAmount(amt.value);
      if (!c || c < 0) { hint.className = 'field-hint error'; hint.textContent = 'Bitte einen gültigen Betrag eingeben.'; amt.focus(); return; }
      const body = { kind: kindSel.value, name: name.value.trim(), amount: c, interval: Number(intv.value), grp: grp.value.trim(), variable: variable.checked, active: active.checked, note: note.value.trim() };
      try {
        if (isNew) S.data.recurring.push(await api('POST', 'recurring', body));
        else Object.assign(r, await api('PUT', `recurring/${r.id}`, body));
        close(); render();
      } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
    });
    async function del() {
      close();
      if (!(await confirmDialog('Posten löschen?', `„${r.name}“ löschen?`))) return;
      try {
        await api('DELETE', `recurring/${r.id}`);
        S.data.recurring = S.data.recurring.filter(x => x.id !== r.id);
        render();
      } catch (er) { toast(er.message, { error: true }); }
    }
  });
}

// ================================================================ EINSTELLUNGEN
/** Neue Kategorie anlegen oder bestehende bearbeiten. Liefert die Kategorie. */
function categoryDialog(c, presetName = '') {
  return new Promise(resolve => {
    let result = null;
    const used = new Set(S.data.categories.map(x => x.color));
    const dlg = openDialog(c ? 'Kategorie bearbeiten' : 'Neue Kategorie', (form, close) => {
      const name = h('input', { type: 'text', value: c ? c.name : presetName, maxlength: 40, required: true });
      const style = stylePicker(c ? c.color : (PALETTE.find(p => !used.has(p)) || PALETTE[0]), c ? c.icon : 'tag');
      const hint = h('div', { class: 'field-hint' });
      form.append(h('label', { class: 'field' }, 'Name', name), style.el, hint,
        h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
          h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const body = { name: name.value.trim(), color: style.color, icon: style.icon };
        try {
          if (c) { Object.assign(c, await api('PUT', `categories/${c.id}`, body)); result = c; }
          else { result = await api('POST', 'categories', body); S.data.categories.push(result); }
          S.data.categories.sort((a, b) => a.name.localeCompare(b.name, 'de'));
          indexData();
          close();
        } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
      });
    });
    dlg.addEventListener('close', () => resolve(result), { once: true });
  });
}

function viewEinstellungen() {
  main.append(pageHead('Einstellungen', 'Kategorien, Geschäfte und Datensicherung'));
  const counts = catCounts();

  // --- Kategorien
  const catCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Kategorien'),
    h('button', { class: 'btn small', onclick: async () => { if (await categoryDialog(null)) render(); } }, icon('plus'), 'Neue Kategorie')));
  for (const c of S.data.categories) {
    const n = counts.get(c.id) || 0;
    const nameIn = h('input', { type: 'text', value: c.name, maxlength: 40, 'aria-label': 'Name' });
    nameIn.addEventListener('change', async () => {
      try { Object.assign(c, await api('PUT', `categories/${c.id}`, { name: nameIn.value.trim() })); toast('Umbenannt'); }
      catch (e) { toast(e.message, { error: true }); nameIn.value = c.name; }
    });
    const merge = h('select', { 'aria-label': 'Zusammenlegen mit', style: { minHeight: '36px', padding: '5px 8px', width: 'auto' } },
      h('option', { value: '' }, 'Zusammenlegen mit …'),
      S.data.categories.filter(x => x.id !== c.id).map(x => h('option', { value: x.id }, x.name)));
    merge.addEventListener('change', async () => {
      const into = cat(Number(merge.value));
      if (!into) return;
      if (!(await confirmDialog('Kategorien zusammenlegen?', `Alle ${n} Ausgaben aus „${c.name}“ kommen nach „${into.name}“, danach wird „${c.name}“ gelöscht.`, 'Zusammenlegen'))) { merge.value = ''; return; }
      try {
        await api('POST', `categories/${c.id}/merge`, { into: into.id });
        S.data.expenses.forEach(e => { if (e.category_id === c.id) e.category_id = into.id; });
        S.data.categories = S.data.categories.filter(x => x.id !== c.id);
        indexData(); render(); toast(`„${c.name}“ ist jetzt Teil von „${into.name}“`);
      } catch (e) { toast(e.message, { error: true }); }
    });
    catCard.append(h('div', { class: 'cat-row' },
      h('button', { class: 'badge-btn', title: 'Farbe & Symbol ändern', 'aria-label': 'Farbe und Symbol ändern', onclick: async () => { if (await categoryDialog(c)) render(); } }, catBadge(c, true)),
      h('div', {}, nameIn, h('div', { class: 'cnt' }, n === 1 ? '1 Buchung' : `${n} Buchungen`)),
      merge,
      h('button', {
        class: 'icon-btn danger', title: n ? 'Wird noch verwendet – zuerst zusammenlegen' : 'Löschen', 'aria-label': 'Löschen', disabled: n ? true : null,
        onclick: async () => {
          try { await api('DELETE', `categories/${c.id}`); S.data.categories = S.data.categories.filter(x => x.id !== c.id); indexData(); render(); }
          catch (e) { toast(e.message, { error: true }); }
        },
      }, icon('trash-2'))));
  }

  // --- Geschäfte
  const stats = [...shopStats().values()].sort((a, b) => a.shop.localeCompare(b.shop, 'de'));
  const search = h('input', { type: 'text', placeholder: 'Geschäft suchen …', autocomplete: 'off' });
  const shopList = h('div', { class: 'shop-list' });
  const drawShops = () => {
    const q = norm(search.value.trim());
    shopList.replaceChildren(...stats.filter(s => !q || norm(s.shop).includes(q)).map(s => h('div', { class: 'shop-row' },
      h('span', {}, s.shop), h('span', { class: 'muted num' }, s.count + '×'), h('span', { class: 'num' }, euro(s.sum)),
      h('button', { class: 'icon-btn', title: 'Umbenennen / zusammenlegen', 'aria-label': 'Umbenennen', onclick: () => renameShop(s.shop) }, icon('pencil')))));
  };
  search.addEventListener('input', drawShops);
  drawShops();
  const shopCard = h('div', { class: 'card' }, h('h2', {}, 'Geschäfte', h('span', { class: 'sub' }, `${stats.length}`)),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13.5px' } }, 'Umbenennen gilt für alle Buchungen. Gibst Du den Namen eines anderen Geschäfts ein, werden beide zusammengelegt (z. B. „Kaiserbau Café“ → „Café Kaiserbau“).'),
    search, h('div', { style: { height: '8px' } }), shopList);

  // --- Daten
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (e) { toast('Die Datei ist kein gültiges JSON.', { error: true }); return; }
    const n = (data.expenses || []).length;
    if (!(await confirmDialog('Sicherung einspielen?', `Die Datei enthält ${n} Ausgaben. Alle aktuellen Daten werden dabei ersetzt! Lade vorher am besten eine Sicherung herunter.`, 'Ersetzen & einspielen'))) { fileIn.value = ''; return; }
    try {
      const r = await api('POST', 'import', data);
      await load();
      toast(`Eingespielt: ${r.expenses} Ausgaben, ${r.categories} Kategorien`);
    } catch (e) { toast(e.message, { error: true }); }
    fileIn.value = '';
  });
  const dataCard = h('div', { class: 'card' }, h('h2', {}, 'Datensicherung'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '13.5px' } }, `Aktuell: ${S.data.expenses.length} Ausgaben, ${S.data.categories.length} Kategorien, ${S.data.pots.length} Spartöpfe, ${S.data.recurring.length} regelmäßige Posten.`),
    h('div', { class: 'toolbar', style: { margin: 0 } },
      h('a', { class: 'btn', href: 'api/export', download: '' }, icon('download'), 'Sicherung herunterladen'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload'), 'Sicherung einspielen'), fileIn));

  main.append(h('div', { class: 'grid-2' }, h('div', { class: 'stack' }, catCard), h('div', { class: 'stack' }, statsCard(), notifyCard(), shopCard, dataCard)));
}

function statsCard() {
  const st = S.data.settings || {};
  const card = h('div', { class: 'card', id: 'statistik' }, h('div', { class: 'card-head' }, h('h2', {}, icon('calendar'), 'Tage ohne Statistik'),
    h('button', { class: 'btn small', onclick: () => excludeDialog(null, null, render) }, icon('plus'), 'Zeitraum')));
  const startIn = h('input', { type: 'date', value: st.tracking_start || EX.firstExpense || '' });
  startIn.addEventListener('change', async () => {
    try {
      const r = await api('PUT', 'settings', { tracking_start: startIn.value || '' });
      S.data.settings.tracking_start = r.tracking_start; indexData(); render(); toast('Beginn der Erfassung gespeichert');
    } catch (e) { toast(e.message, { error: true }); }
  });
  card.append(h('label', { class: 'field' }, 'Erfassung seit', startIn,
    h('div', { class: 'field-hint' }, st.tracking_start ? 'Tage davor zählen in keiner Statistik mit.' : `Tage davor zählen nicht mit. Automatisch: Dein erster Eintrag (${EX.firstExpense ? fmtDate(EX.firstExpense) : '–'}).`)));
  const list = h('div', { class: 'rec-list', style: { marginTop: '10px' } });
  const periods = S.data.excluded.slice().sort((a, b) => b.day_from.localeCompare(a.day_from));
  if (!periods.length) list.append(h('p', { class: 'muted', style: { fontSize: '13.5px', margin: '6px 0 0' } }, 'Noch keine Zeiträume. Urlaub & Co. markierst Du am schnellsten unter „Erfassen“: einfach auf einen Tag in der Wochenleiste klicken.'));
  for (const p of periods) {
    const n = daysBetween(p.day_from, p.day_to);
    list.append(h('div', { class: 'rec' },
      h('div', {}, h('div', { class: 'r-name' }, p.label || 'ausgeschlossen'), h('div', { class: 'r-meta' }, `${fmtRange(p.day_from, p.day_to)} · ${n} ${n === 1 ? 'Tag' : 'Tage'}`)),
      h('button', { class: 'icon-btn', title: 'Bearbeiten', 'aria-label': 'Zeitraum bearbeiten', onclick: () => excludeDialog(null, null, render, p) }, icon('pencil')),
      h('button', { class: 'icon-btn danger', title: 'Wieder mitzählen', 'aria-label': 'Zeitraum löschen', onclick: async () => {
        try { await api('DELETE', `excluded/${p.id}`); S.data.excluded = S.data.excluded.filter(x => x.id !== p.id); indexData(); render(); toast(`„${p.label || 'Zeitraum'}“ zählt wieder mit`); }
        catch (e) { toast(e.message, { error: true }); }
      } }, icon('trash-2'))));
  }
  card.append(list);
  return card;
}

/**
 * Tag/Woche/Zeitraum aus der Statistik nehmen – oder wieder aufnehmen.
 * day: angeklickter Tag (oder null), weekStart: Montag der Woche, done: Rückruf nach Änderung, period: zum Bearbeiten
 */
function excludeDialog(day, weekStart, done, period) {
  const r = day ? EX.reason(day) : null;
  if (r && r.start) {
    toast(`Tage ${START_LABEL} (${fmtDate(EX.start)}) zählen nie mit – änderbar unter Einstellungen.`, { ms: 6000 });
    return;
  }
  const refresh = () => { indexData(); done && done(); };
  const create = async b => { const x = await api('POST', 'excluded', b); S.data.excluded.push(x); return x; };

  if (r && r.period) { // angeklickter Tag ist schon ausgeschlossen
    const p = r.period;
    openDialog('Wieder mitzählen?', (form, close) => {
      const single = p.day_from === p.day_to;
      const run = async fn => { try { await fn(); close(); refresh(); } catch (e) { toast(e.message, { error: true }); } };
      form.append(h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, `${fmtDateLong(day)} gehört zu „${p.label || 'ausgeschlossen'}“ (${fmtRange(p.day_from, p.day_to)}).`),
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn left', onclick: close }, 'Abbrechen'),
          !single ? h('button', { type: 'button', class: 'btn', onclick: () => run(async () => {
            await api('DELETE', `excluded/${p.id}`);
            S.data.excluded = S.data.excluded.filter(x => x.id !== p.id);
            if (p.day_from < day) await create({ day_from: p.day_from, day_to: addDays(day, -1), label: p.label });
            if (day < p.day_to) await create({ day_from: addDays(day, 1), day_to: p.day_to, label: p.label });
          }) }, 'Nur diesen Tag') : null,
          h('button', { type: 'button', class: 'btn primary', onclick: () => run(async () => {
            await api('DELETE', `excluded/${p.id}`);
            S.data.excluded = S.data.excluded.filter(x => x.id !== p.id);
          }) }, single ? 'Wieder mitzählen' : 'Ganzen Zeitraum')));
    });
    return;
  }

  openDialog(period ? 'Zeitraum bearbeiten' : 'Aus der Statistik nehmen', (form, close) => {
    const fromIn = h('input', { type: 'date', value: period ? period.day_from : day || today() });
    const toIn = h('input', { type: 'date', value: period ? period.day_to : day || today() });
    const label = h('input', { type: 'text', value: period ? period.label : 'Urlaub', maxlength: 60, list: 'ex-labels', placeholder: 'z. B. Urlaub, krank, Besuch' });
    const labels = [...new Set(['Urlaub', 'Krank', 'Besuch', ...S.data.excluded.map(x => x.label).filter(Boolean)])];
    const hint = h('div', { class: 'field-hint' });
    const quick = day ? h('div', { class: 'toolbar', style: { margin: 0 } },
      h('button', { type: 'button', class: 'btn small', onclick: () => { fromIn.value = day; toIn.value = day; } }, `Nur ${weekdayShort(day)}, ${fmtDate(day, { year: false })}`),
      weekStart ? h('button', { type: 'button', class: 'btn small', onclick: () => { fromIn.value = weekStart; toIn.value = addDays(weekStart, 6); } }, `Ganze KW ${isoWeek(weekStart).week}`) : null) : null;
    form.append(
      h('p', { style: { margin: 0, color: 'var(--ink-2)', fontSize: '14px' } }, 'Diese Tage zählen dann bei Durchschnitten, Vergleichen und Diagrammen nicht mit – praktisch für Urlaub oder Wochen, in denen Du nichts eingetragen hast.'),
      quick,
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Von', fromIn), h('label', { class: 'field' }, 'Bis', toIn)),
      h('label', { class: 'field' }, 'Bezeichnung', label, h('datalist', { id: 'ex-labels' }, labels.map(l => h('option', { value: l })))),
      hint,
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!fromIn.value || !toIn.value) { hint.className = 'field-hint error'; hint.textContent = 'Bitte beide Daten angeben.'; return; }
      const body = { day_from: fromIn.value, day_to: toIn.value, label: label.value.trim() };
      try {
        if (period) Object.assign(period, await api('PUT', `excluded/${period.id}`, body));
        else await create(body);
        close(); refresh();
        toast(`„${body.label || 'Zeitraum'}“ wird in der Statistik nicht mitgezählt`);
      } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
    });
  });
}

function notifyCard() {
  const st = S.data.settings || {};
  const card = h('div', { class: 'card', id: 'benachrichtigungen' }, h('h2', {}, icon('bell'), 'Abo-Erinnerungen'));
  // Browser
  const perm = !browserSupport() ? 'unsupported' : Notification.permission;
  const permText = { granted: 'erlaubt ✓', denied: 'blockiert – bitte in den Website-Einstellungen des Browsers erlauben', default: 'noch nicht erlaubt', unsupported: 'werden von diesem Browser nicht unterstützt' }[perm];
  card.append(h('div', { class: 'set-row' },
    h('div', {}, h('div', { class: 'r-name' }, 'Browser-Benachrichtigungen'), h('div', { class: 'r-meta' }, permText)),
    perm === 'default' ? h('button', { class: 'btn small', onclick: async () => { await askBrowserPermission(); render(); } }, 'Erlauben') : null));
  card.append(h('p', { class: 'muted', style: { fontSize: '13px', margin: '4px 0 14px' } },
    'Erscheinen, solange das Haushaltsbuch in einem Tab offen ist (auch im Hintergrund). Für Erinnerungen bei geschlossenem Browser nimm zusätzlich die E-Mail.'));
  // E-Mail
  const mail = h('input', { type: 'email', value: st.notify_email || '', placeholder: 'name@example.org', autocomplete: 'email' });
  const status = h('div', { class: 'field-hint' + (st.smtp_configured ? '' : ' error') },
    st.smtp_configured ? 'E-Mail-Versand ist auf dem Server eingerichtet. Geprüft wird alle 30 Minuten.' : 'Auf dem Server ist der E-Mail-Versand noch nicht eingerichtet (README → „E-Mail-Erinnerungen“).');
  const save = h('button', { class: 'btn small', onclick: async () => {
    try { const r = await api('PUT', 'settings', { notify_email: mail.value.trim() }); S.data.settings.notify_email = r.notify_email; toast('E-Mail-Adresse gespeichert'); }
    catch (e) { toast(e.message, { error: true }); }
  } }, 'Speichern');
  const test = h('button', { class: 'btn small', disabled: st.smtp_configured ? null : true, onclick: async () => {
    test.disabled = true;
    try { const r = await api('POST', 'test-email', {}); toast(`Test-E-Mail an ${r.to} verschickt`); }
    catch (e) { toast(e.message, { error: true, ms: 8000 }); }
    finally { test.disabled = false; }
  } }, icon('mail-check'), 'Test-E-Mail');
  card.append(h('label', { class: 'field' }, 'E-Mail-Adresse für Erinnerungen', h('div', { class: 'inline-form' }, mail, save, test), status));
  return card;
}

function renameShop(old) {
  openDialog('Geschäft umbenennen', (form, close) => {
    const stats = shopStats();
    const combo = new Combo({ items: () => [...stats.values()].filter(s => s.shop !== old).map(s => ({ value: s.shop, score: s.count, meta: s.count + '×' })) });
    combo.value = old;
    const hint = h('div', { class: 'field-hint' }, `${stats.get(old).count} Buchungen betroffen`);
    form.append(h('label', { class: 'field' }, 'Neuer Name', combo.el), hint,
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Übernehmen')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const to = combo.value;
      if (!to || to === old) return close();
      try {
        const r = await api('POST', 'shops/rename', { from: old, to });
        S.data.expenses.forEach(x => { if (x.shop === old) x.shop = to; });
        close(); render(); toast(`${r.changed} Buchungen umbenannt`);
      } catch (er) { hint.className = 'field-hint error'; hint.textContent = er.message; }
    });
  });
}

// ---------------------------------------------------------------- Farbschema
const themeBtn = document.getElementById('themeToggle');
function drawTheme() {
  const t = document.documentElement.dataset.theme || 'auto';
  themeBtn.replaceChildren(icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'sparkles'),
    { auto: 'Automatisch', light: 'Hell', dark: 'Dunkel' }[t]);
  themeBtn.title = 'Farbschema wechseln (automatisch → hell → dunkel)';
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'auto';
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[cur];
  if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
  try { next === 'auto' ? localStorage.removeItem('hb-theme') : localStorage.setItem('hb-theme', next); } catch (e) { /* egal */ }
  drawTheme();
  if (S.view === 'auswertung') render();
});

// ---------------------------------------------------------------- Start
async function load() {
  S.data = await api('GET', 'data');
  indexData();
  render();
}

initAlerts({ getSubs: () => (S.data && S.data.subs) || [], openSub });
// Alle 30 Minuten neu laden: neue Erinnerungen, Änderungen von anderen Geräten
setInterval(async () => {
  try {
    const fresh = await api('GET', 'data');
    const dlgOpen = document.getElementById('dialog').open;
    S.data.subs = fresh.subs; S.data.settings = fresh.settings;
    if (!dlgOpen && S.view === 'monat') render(); else refreshAlerts();
  } catch (e) { /* offline – beim nächsten Mal */ }
}, 30 * 60 * 1000);

document.querySelectorAll('[data-icon]').forEach(el => el.classList.contains('brand-mark') ? el.append(icon(el.dataset.icon)) : el.replaceWith(icon(el.dataset.icon)));
drawTheme();
window.addEventListener('hashchange', route);
main.innerHTML = '<div class="loading">Lade Daten …</div>';
load().then(route).catch(e => { main.innerHTML = ''; main.append(h('div', { class: 'card empty' }, 'Die Daten konnten nicht geladen werden: ' + e.message)); });
