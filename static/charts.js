// Schlanke SVG-Diagramme: Säulen über die Zeit und Ring nach Kategorien
import { euro, euro0, esc, showTip, hideTip, pct } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}

function niceStep(max, count = 4) {
  if (max <= 0) return 1000;
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function tipRows(parts, total, limit = 4) {
  const sorted = parts.slice().sort((a, b) => b.amount - a.amount);
  const shown = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((a, p) => a + p.amount, 0);
  let html = shown.map(p => `<div class="t-row"><span class="swatch" style="background:${p.cat.color}"></span><span>${esc(p.cat.name)}</span><span class="v">${euro(p.amount)}</span></div>`).join('');
  if (rest) html += `<div class="t-row"><span class="swatch" style="background:var(--muted)"></span><span>Weitere</span><span class="v">${euro(rest)}</span></div>`;
  return html;
}

/**
 * Säulendiagramm.
 * buckets: [{label, short, total, parts:[{cat, amount}], future?}]
 */
export function columnChart(container, { buckets, avg, avgLabel }) {
  container.innerHTML = '';
  const W = Math.max(280, container.clientWidth || 600);
  const H = 250;
  const m = { t: 14, r: 8, b: 26, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(...buckets.map(b => b.total), avg || 0, 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = v => m.t + ih - (v / top) * ih;
  const band = iw / buckets.length;
  const bw = Math.max(2, Math.min(34, band * 0.68));

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Ausgaben im Zeitverlauf' });
  // Schraffur für Tage, die nicht in die Statistik eingehen
  const pid = 'hatch' + Math.random().toString(36).slice(2, 8);
  const defs = s('defs');
  const pat = s('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(s('rect', { width: 6, height: 6, class: 'hatch-bg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-line' }));
  defs.append(pat);
  svg.append(defs);
  buckets.forEach((b, i) => {
    if (b.ex) svg.append(s('rect', { x: m.l + band * i + 1, y: m.t, width: Math.max(1, band - 2), height: ih, fill: `url(#${pid})`, class: 'ex-band', opacity: 0.45 + 0.55 * b.ex }));
  });
  for (let v = 0; v <= top + 1e-6; v += step) {
    if (v > 0) svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' });
    t.textContent = euro0(v);
    svg.append(t);
  }
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 46))));
  const bars = [];
  buckets.forEach((b, i) => {
    const cx = m.l + band * i + band / 2;
    let bar = null;
    if (b.total > 0) {
      const x = cx - bw / 2, y0 = y(0), y1 = y(b.total), r = Math.min(4, bw / 2, y0 - y1);
      bar = s('path', { class: 'bar', d: `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z` });
      svg.append(bar);
    }
    bars.push(bar);
    if (i % labelEvery === 0) {
      const t = s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis-label' });
      t.textContent = b.short;
      svg.append(t);
    }
    const hit = s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, class: 'hit' });
    hit.addEventListener('mousemove', e => {
      bars.forEach((o, j) => o && o.classList.toggle('dim', j !== i));
      showTip(`<div class="t-title">${esc(b.label)}</div><div class="t-total">${euro(b.total)}</div>${tipRows(b.parts, b.total)}${b.exText ? `<div class="t-ex">${esc(b.exText)}</div>` : ''}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => { bars.forEach(o => o && o.classList.remove('dim')); hideTip(); });
    svg.append(hit);
  });

  if (avg > 0) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(avg), y2: y(avg), class: 'avgline' }));
    const t = s('text', { x: W - m.r, y: y(avg) - 5, 'text-anchor': 'end', class: 'avg-label' });
    t.textContent = `${avgLabel || 'Ø'} ${euro(avg)}`;
    svg.append(t);
  }
  container.append(svg);
}

/**
 * Ringdiagramm. slices: [{cat, amount}] (absteigend sortiert)
 * onHover(index|null) für die Verknüpfung mit der Tabelle.
 */
export function donutChart(container, { slices, total, onHover }) {
  container.innerHTML = '';
  const size = 200, R = 96, r = 62, c = size / 2;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img', 'aria-label': 'Anteile nach Kategorie' });
  const paths = [];
  let a0 = -Math.PI / 2;
  const pos = slices.filter(x => x.amount > 0);
  const sum = pos.reduce((a, x) => a + x.amount, 0) || 1;
  pos.forEach((sl, i) => {
    const frac = sl.amount / sum;
    const a1 = a0 + frac * Math.PI * 2;
    let p;
    if (frac >= 0.9999) {
      p = s('path', { d: `M${c},${c - R} A${R},${R} 0 1 1 ${c - 0.01},${c - R} L${c - 0.01},${c - r} A${r},${r} 0 1 0 ${c},${c - r} Z`, fill: sl.cat.color });
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const P = (rad, a) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
      p = s('path', { d: `M${P(R, a0)} A${R},${R} 0 ${large} 1 ${P(R, a1)} L${P(r, a1)} A${r},${r} 0 ${large} 0 ${P(r, a0)} Z`, fill: sl.cat.color });
    }
    p.addEventListener('mousemove', e => {
      highlight(i);
      showTip(`<div class="t-row" style="margin:0"><span class="swatch" style="background:${sl.cat.color}"></span><b>${esc(sl.cat.name)}</b><span></span></div><div class="t-total">${euro(sl.amount)}</div><div class="muted">${pct(sl.amount, total)} der Ausgaben</div>`, e.clientX, e.clientY);
    });
    p.addEventListener('mouseleave', () => { highlight(null); hideTip(); });
    paths.push(p);
    svg.append(p);
    a0 = a1;
  });
  if (!pos.length) svg.append(s('circle', { cx: c, cy: c, r: (R + r) / 2, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': R - r }));
  const t1 = s('text', { x: c, y: c + 2, 'text-anchor': 'middle', class: 'center-value' });
  t1.textContent = euro0(total);
  const t2 = s('text', { x: c, y: c + 20, 'text-anchor': 'middle', class: 'center-label' });
  t2.textContent = 'gesamt';
  svg.append(t1, t2);
  container.append(svg);

  function highlight(i) {
    paths.forEach((p, j) => p.classList.toggle('dim', i != null && j !== i));
    if (onHover) onHover(i == null ? null : pos[i]);
  }
  return { highlight: cat => { const i = cat == null ? -1 : pos.findIndex(x => x.cat === cat); highlight(i < 0 ? null : i); } };
}
