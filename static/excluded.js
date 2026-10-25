// Tage, die nicht in die Statistik eingehen: vor Beginn der Erfassung und markierte Zeiträume (Urlaub …)
import { addDays, fmtRange } from './util.js';

export const START_LABEL = 'vor Beginn der Erfassung';

/**
 * @param {object} data  kompletter Datenstand (expenses, excluded, settings)
 * @returns Hilfsfunktionen rund um ausgeschlossene Tage
 */
export function makeExcluder(data) {
  const firstExpense = data.expenses.reduce((m, e) => (!m || e.date < m ? e.date : m), '');
  const start = (data.settings && data.settings.tracking_start) || firstExpense || '';
  const byDay = new Map();
  for (const p of data.excluded || []) {
    for (let d = p.day_from, n = 0; d <= p.day_to && n < 3700; d = addDays(d, 1), n++) if (!byDay.has(d)) byDay.set(d, p);
  }

  /** null = zählt mit; sonst { label, period?, start? } */
  const reason = d => {
    if (start && d < start) return { label: START_LABEL, start: true };
    const p = byDay.get(d);
    return p ? { label: p.label || 'ausgeschlossen', period: p } : null;
  };

  /** Zählt Tage im Bereich: alle und davon ausgeschlossene, samt Gründen */
  const scan = (from, to) => {
    let all = 0, ex = 0, beforeStart = 0;
    const periods = new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      all++;
      const r = reason(d);
      if (!r) continue;
      ex++;
      if (r.start) beforeStart++; else periods.add(r.period);
    }
    return { all, ex, included: all - ex, beforeStart, periods: [...periods].sort((a, b) => a.day_from.localeCompare(b.day_from)) };
  };

  const describe = s => {
    const parts = [];
    if (s.beforeStart) parts.push(`${s.beforeStart} ${s.beforeStart === 1 ? 'Tag' : 'Tage'} ${START_LABEL}`);
    for (const p of s.periods) parts.push(`${p.label || 'ausgeschlossen'} (${fmtRange(p.day_from, p.day_to)})`);
    return parts.join(', ');
  };

  return { start, firstExpense, reason, isExcluded: d => !!reason(d), scan, describe };
}
