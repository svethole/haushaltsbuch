// Abos: Anbieter, Erinnerungsregeln und Hinweise (Warnleiste, Symbol unten rechts, Browser-Benachrichtigungen)
import { h, icon, euro, iso, parseISO, today, addDays, daysBetween, fmtDate } from './util.js';

/** Gängige Anbieter mit Link zur Abo-Verwaltung. Der Link lässt sich pro Abo ändern. */
export const PROVIDERS = [
  { key: 'google-play', label: 'Google Play Store', icon: 'play', color: '#1baf7a', url: 'https://play.google.com/store/account/subscriptions',
    hint: 'App-Abos aus dem Play Store. Am Handy auch: Play Store → Profilbild → Zahlungen und Abos → Abos.' },
  { key: 'google', label: 'Google-Konto (Google One, YouTube …)', icon: 'cloud', color: '#2a78d6', url: 'https://myaccount.google.com/payments-and-subscriptions',
    hint: 'Sammelseite für alle Google-Dienste, die über Dein Google-Konto laufen (Google One, YouTube Premium, Play-Abos …).' },
  { key: 'apple', label: 'Apple App Store & Apple-Dienste', icon: 'apple', color: '#5f7a8a', url: 'https://apps.apple.com/account/subscriptions',
    hint: 'Öffnet die Abo-Verwaltung am besten auf iPhone, iPad oder Mac. Am iPhone auch: Einstellungen → Dein Name → Abonnements.' },
  { key: 'amazon', label: 'Amazon (Prime, Channels, Kindle …)', icon: 'package', color: '#eb6834', url: 'https://www.amazon.de/yourmembershipsandsubscriptions',
    hint: 'Unter „Mitgliedschaften und Abonnements“ stehen Prime, Prime-Video-Channels, Kindle Unlimited, Music Unlimited und mehr.' },
  { key: 'netflix', label: 'Netflix', icon: 'film', color: '#e34948', url: 'https://www.netflix.com/account' },
  { key: 'spotify', label: 'Spotify', icon: 'music', color: '#008300', url: 'https://www.spotify.com/de/account/subscription/' },
  { key: 'disney', label: 'Disney+', icon: 'sparkles', color: '#6250d6', url: 'https://www.disneyplus.com/account' },
  { key: 'youtube', label: 'YouTube Premium / Music', icon: 'tv', color: '#e34948', url: 'https://www.youtube.com/paid_memberships',
    hint: 'Wenn Du YouTube Premium über Apple gebucht hast, kündigst Du es dort.' },
  { key: 'audible', label: 'Audible', icon: 'headphones', color: '#eda100', url: 'https://www.audible.de/account/overview' },
  { key: 'microsoft', label: 'Microsoft 365 / Xbox', icon: 'laptop', color: '#0f8a99', url: 'https://account.microsoft.com/services' },
  { key: 'paypal', label: 'PayPal (automatische Zahlungen)', icon: 'wallet', color: '#2a78d6', url: 'https://www.paypal.com/myaccount/autopay/',
    hint: 'Hier siehst Du alle Händler, die per PayPal regelmäßig abbuchen dürfen.' },
  { key: 'adobe', label: 'Adobe', icon: 'palette', color: '#e34948', url: 'https://account.adobe.com/plans' },
  { key: 'patreon', label: 'Patreon', icon: 'heart', color: '#eb6834', url: 'https://www.patreon.com/settings/memberships' },
  { key: 'press', label: 'Zeitung / Magazin', icon: 'newspaper', color: '#8a6a4f', url: '' },
  { key: 'software', label: 'Software / Online-Dienst', icon: 'cloud', color: '#5f7a8a', url: '' },
  { key: 'other', label: 'Sonstiges', icon: 'repeat', color: '#898781', url: '' },
];
export const shortLabel = p => p.label.split(' (')[0];
export const providerOf = key => PROVIDERS.find(p => p.key === key) || PROVIDERS[PROVIDERS.length - 1];
export const CANCEL_TIP = 'Tipp: Seit Juli 2022 muss jeder Anbieter, bei dem man online einen Vertrag abschließen kann, einen gut sichtbaren „Verträge hier kündigen“-Button anbieten.';

export const SUB_INTERVALS = { 1: 'monatlich', 2: 'alle 2 Monate', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich', 24: 'alle 2 Jahre' };

// ---------------------------------------------------------------- Regeln (gleich wie im Server, server.py)
function addMonths(s, n) {
  const d = parseISO(s);
  const y = d.getFullYear(), m = d.getMonth() + n;
  const last = new Date(y, m + 1, 0).getDate();
  return iso(new Date(y, m, Math.min(d.getDate(), last)));
}

/** Nächste Abbuchung ab heute (das gespeicherte Datum wird im Abo-Rhythmus weitergezählt). */
export function effectiveDue(sub, t = today()) {
  let d = sub.next_due, k = 0;
  while (d < t && k < 2000) { k++; d = addMonths(sub.next_due, k * sub.interval); }
  return d;
}

/** Fällige Erinnerung oder null. */
export function activeReminder(sub, t = today()) {
  if (sub.status !== 'active' || sub.remind_mode === 'none') return null;
  const due = effectiveDue(sub, t);
  let trigger, key;
  if (sub.remind_mode === 'before') { trigger = addDays(due, -sub.remind_days); key = 'b' + due; }
  else { if (!sub.remind_date) return null; trigger = sub.remind_date; key = 'd' + sub.remind_date; }
  if (t < trigger || sub.ack_key === key) return null;
  if (sub.snooze_until && t < sub.snooze_until) return null;
  return { key, trigger, due };
}

export const monthlyOf = sub => Math.round(sub.amount / sub.interval);

export function dueText(due, t = today()) {
  const n = daysBetween(t, due) - 1;
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  return `in ${n} Tagen`;
}

export function reminderLabel(sub) {
  if (sub.remind_mode === 'before') return sub.remind_days === 0 ? 'am Tag der Abbuchung' : sub.remind_days === 1 ? '1 Tag vorher' : `${sub.remind_days} Tage vorher`;
  if (sub.remind_mode === 'date' && sub.remind_date) return `am ${fmtDate(sub.remind_date)}`;
  return '';
}

// ---------------------------------------------------------------- Hinweise
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* egal */ } },
};

let getSubs = () => [];
let openSub = () => {};
let bar, fab, panel;

export function initAlerts(opts) {
  getSubs = opts.getSubs;
  openSub = opts.openSub;
  bar = h('div', { class: 'alertbar', role: 'alert', hidden: true });
  fab = h('button', { type: 'button', class: 'alertfab', hidden: true, title: 'Abo-Erinnerungen anzeigen', 'aria-label': 'Abo-Erinnerungen anzeigen', onclick: () => togglePanel() });
  panel = h('div', { class: 'alertpanel', hidden: true, role: 'dialog', 'aria-label': 'Abo-Erinnerungen' });
  document.body.append(bar, fab, panel);
  document.addEventListener('mousedown', e => {
    if (!panel.hidden && !panel.contains(e.target) && !fab.contains(e.target) && !bar.contains(e.target)) panel.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; fab.focus(); } });
}

function current() {
  const t = today();
  return getSubs().map(s => ({ sub: s, r: activeReminder(s, t) })).filter(x => x.r)
    .sort((a, b) => a.r.due.localeCompare(b.r.due));
}

function line(x) {
  return `${x.sub.name}: Abbuchung ${dueText(x.r.due)} (${fmtDate(x.r.due)}, ${euro(x.sub.amount)})`;
}

export function refreshAlerts() {
  if (!bar) return;
  const all = current();
  const onPage = all.filter(x => x.sub.ch_page);
  const keyset = onPage.map(x => x.sub.id + ':' + x.r.key).sort().join(',');
  const dismissed = store.get('hb-alert-dismissed', '');
  const showBar = onPage.length > 0 && dismissed !== keyset;

  bar.replaceChildren();
  if (showBar) {
    const text = onPage.length === 1
      ? h('span', { class: 'ab-text' }, 'Abo-Erinnerung', h('span', { class: 'ab-names' }, ' – ' + line(onPage[0])))
      : h('span', { class: 'ab-text' }, `${onPage.length} Abo-Erinnerungen`, h('span', { class: 'ab-names' }, ': ' + onPage.map(x => x.sub.name).join(', ')));
    bar.append(icon('triangle-alert'), text,
      h('button', { type: 'button', class: 'ab-btn', onclick: () => (onPage.length === 1 ? go(onPage[0].sub.id) : togglePanel(true)) }, onPage.length === 1 ? 'Zum Abo' : 'Anzeigen'),
      h('button', { type: 'button', class: 'ab-close', title: 'Ausblenden', 'aria-label': 'Hinweis ausblenden', onclick: () => { store.set('hb-alert-dismissed', keyset); refreshAlerts(); } }, icon('x')));
  }
  bar.hidden = !showBar;
  document.body.classList.toggle('has-alertbar', showBar);
  fab.hidden = showBar || onPage.length === 0;
  fab.replaceChildren(icon('triangle-alert'), h('span', { class: 'count' }, onPage.length));

  panel.replaceChildren(h('div', { class: 'ap-head' }, icon('bell-ring'), 'Abo-Erinnerungen'),
    ...onPage.map(x => h('button', { type: 'button', class: 'ap-item', onclick: () => go(x.sub.id) },
      h('span', { class: 'ap-name' }, x.sub.name),
      h('span', { class: 'ap-meta' }, `Abbuchung ${dueText(x.r.due)} · ${fmtDate(x.r.due)} · ${euro(x.sub.amount)}`))),
    ...(onPage.length ? [] : [h('div', { class: 'empty' }, 'Keine offenen Erinnerungen')]));
  if (!onPage.length) panel.hidden = true;

  notifyBrowser(all.filter(x => x.sub.ch_browser));
}

function togglePanel(force) {
  panel.hidden = force === true ? false : !panel.hidden;
  if (!panel.hidden) panel.querySelector('.ap-item')?.focus();
}

function go(id) {
  panel.hidden = true;
  openSub(id);
}

// ---------------------------------------------------------------- Browser-Benachrichtigungen
export const browserSupport = () => 'Notification' in window && window.isSecureContext;

function notifyBrowser(list) {
  if (!browserSupport() || Notification.permission !== 'granted' || !list.length) return;
  const t = today();
  const shown = store.get('hb-notified', {});
  for (const k of Object.keys(shown)) if (shown[k] < addDays(t, -60)) delete shown[k];
  for (const x of list) {
    const k = x.sub.id + ':' + x.r.key + ':' + (x.sub.snooze_until || '');
    if (shown[k] === t) continue; // höchstens einmal am Tag
    try {
      const n = new Notification(`Abo-Erinnerung: ${x.sub.name}`, {
        body: `Abbuchung ${dueText(x.r.due)} (${fmtDate(x.r.due)}) – ${euro(x.sub.amount)}. Jetzt kündigen oder behalten?`,
        tag: 'hb-sub-' + x.sub.id, icon: 'favicon.svg',
      });
      n.onclick = () => { window.focus(); openSub(x.sub.id); n.close(); };
      shown[k] = t;
    } catch (e) { /* manche Browser erlauben das nur über einen Service Worker */ }
  }
  store.set('hb-notified', shown);
}

export async function askBrowserPermission() {
  if (!browserSupport()) return 'unsupported';
  const p = await Notification.requestPermission();
  if (p === 'granted') {
    try { new Notification('Haushaltsbuch', { body: 'Browser-Benachrichtigungen sind eingeschaltet. 🎉', icon: 'favicon.svg' }); } catch (e) { /* egal */ }
  }
  return p;
}
