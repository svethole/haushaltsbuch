// Hilfsfunktionen: Datum, Geld, DOM, Schnittstelle
import { ICONS } from './icons.js';

// ---------------------------------------------------------------- DOM
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = 'icon') {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS['tag']}</svg>`;
  return span.firstElementChild;
}
export const ICON_NAMES = Object.keys(ICONS);

export function catBadge(cat, large = false) {
  const b = h('span', { class: 'cat-badge' + (large ? ' lg' : ''), style: { background: cat ? cat.color : 'var(--surface-3)' } });
  b.append(icon(cat ? cat.icon : 'circle-help'));
  return b;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- Geld
const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const EUR0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const euro = c => EUR.format(c / 100);
export const euro0 = c => EUR0.format(c / 100);
export const plain = c => NUM.format(c / 100);
export const pct = (a, b) => (b ? (a / b * 100).toLocaleString('de-DE', { maximumFractionDigits: a / b < 0.1 ? 1 : 0 }) + ' %' : '–');

/** "12,34" / "12.34" / "1.234,50" / "3,30 + 2,10" → Cent (oder null). */
export function parseAmount(text) {
  if (text == null) return null;
  const parts = String(text).replace(/€|\s/g, '').split(/(?=[+-])/).filter(Boolean);
  if (!parts.length) return null;
  let sum = 0;
  for (let p of parts) {
    let sign = 1;
    if (p[0] === '+') p = p.slice(1);
    else if (p[0] === '-') { sign = -1; p = p.slice(1); }
    if (!p) return null;
    if (p.includes(',')) p = p.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(p)) p = p.replace(/\./g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(p)) return null;
    sum += sign * Math.round(parseFloat(p) * 100);
  }
  return sum;
}

// ---------------------------------------------------------------- Datum
export function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = () => iso(new Date());
export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
export function daysBetween(a, b) { // inklusive beider Tage
  return Math.round((parseISO(b) - parseISO(a)) / 86400000) + 1;
}
export function isoWeek(s) {
  const d = parseISO(s);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { year: y, week: w };
}
export function mondayOf(s) {
  const d = parseISO(s);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return iso(d);
}
export function monthStart(s, offset = 0) {
  const d = parseISO(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + offset, 1));
}
export function monthEnd(s, offset = 0) {
  const d = parseISO(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + offset + 1, 0));
}
const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const weekday = s => WD[parseISO(s).getDay()];
export const weekdayShort = s => WD_SHORT[parseISO(s).getDay()];
export function fmtDate(s, { year = true, weekday: wd = false } = {}) {
  const d = parseISO(s);
  const base = `${d.getDate()}.${d.getMonth() + 1}.${year ? d.getFullYear() : ''}`;
  return (wd ? WD_SHORT[d.getDay()] + ', ' : '') + base;
}
export function fmtDateLong(s) {
  const d = parseISO(s);
  return `${WD[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
}
export function fmtRange(a, b) {
  const da = parseISO(a), db = parseISO(b);
  if (a === b) return fmtDate(a);
  if (da.getFullYear() === db.getFullYear()) {
    if (da.getMonth() === db.getMonth()) return `${da.getDate()}.–${db.getDate()}. ${MONTHS_SHORT[db.getMonth()]} ${db.getFullYear()}`;
    return `${da.getDate()}. ${MONTHS_SHORT[da.getMonth()]} – ${db.getDate()}. ${MONTHS_SHORT[db.getMonth()]} ${db.getFullYear()}`;
  }
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}
export const monthShort = i => MONTHS_SHORT[i];

// ---------------------------------------------------------------- Texte
export function norm(s) {
  return String(s).toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ---------------------------------------------------------------- Schnittstelle
export async function api(method, path, body) {
  const res = await fetch('api/' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* leer */ }
  if (!res.ok) throw new Error((data && data.error) || `Fehler ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- Rückmeldungen
export function toast(msg, { action, onAction, error = false, ms = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, h('span', {}, msg));
  if (action) {
    t.append(h('button', { type: 'button', onclick: () => { onAction(); t.remove(); } }, action));
  }
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

const tip = () => document.getElementById('tooltip');
export function showTip(html, x, y) {
  const el = tip();
  el.innerHTML = html;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = Math.max(8, top) + 'px';
}
export function hideTip() { tip().hidden = true; }

// ---------------------------------------------------------------- Dialog
/** Öffnet einen modalen Dialog. build(form, close) befüllt das Formular. */
export function openDialog(title, build) {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = '';
  const form = h('form', { method: 'dialog' }, h('h3', {}, title));
  const close = () => dlg.close();
  build(form, close);
  dlg.append(form);
  dlg.showModal();
  const first = form.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return dlg;
}

export function confirmDialog(title, text, okLabel = 'Löschen') {
  return new Promise(resolve => {
    let ok = false;
    const dlg = openDialog(title, (form, close) => {
      form.append(
        h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, text),
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn', onclick: close }, 'Abbrechen'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => { ok = true; close(); } }, okLabel)),
      );
    });
    dlg.addEventListener('close', () => resolve(ok), { once: true });
  });
}
