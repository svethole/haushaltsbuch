// Eingabefeld mit Vorschlag (Ghost-Text, per Tab übernehmen) und aufklappbarer Liste
import { h, icon, catBadge, norm, esc } from './util.js';

let uid = 0;

export class Combo {
  /**
   * @param {object} o
   * @param {() => Array<{value:string, score?:number, meta?:string, cat?:object}>} o.items
   * @param {boolean} [o.strict]   nur Werte aus der Liste zulassen (Kategorie)
   * @param {boolean} [o.toggle]   Knopf zum Aufklappen der ganzen Liste
   * @param {boolean} [o.withIcon] Kategorie-Symbol im Feld zeigen
   * @param {(name:string) => Promise<string|null>} [o.onCreate]
   * @param {(value:string) => void} [o.onCommit] nach Übernahme eines Vorschlags
   */
  constructor(o) {
    this.o = o;
    this.id = 'combo' + (++uid);
    this.open = false;
    this.showAll = false;
    this.active = -1;
    this.navigated = false;
    this.matches = [];

    this.input = h('input', {
      type: 'text', id: o.id || this.id, name: o.name || this.id, autocomplete: 'off', spellcheck: false,
      placeholder: o.placeholder || '', role: 'combobox', 'aria-autocomplete': 'both',
      'aria-expanded': 'false', 'aria-controls': this.id + '-list',
    });
    this.ghost = h('div', { class: 'combo-ghost', 'aria-hidden': 'true' });
    this.list = h('ul', { class: 'combo-list', id: this.id + '-list', role: 'listbox', hidden: true });
    this.el = h('div', { class: 'combo' + (o.withIcon ? ' has-icon' : '') + (o.toggle ? ' has-toggle' : '') },
      h('div', { class: 'combo-bg' }), this.ghost, this.input, this.list);
    if (o.withIcon) {
      this.badge = h('span', { class: 'combo-icon' });
      this.el.append(this.badge);
    }
    if (o.toggle) {
      const btn = h('button', { type: 'button', class: 'combo-toggle', tabindex: '-1', title: 'Liste aufklappen', 'aria-label': 'Liste aufklappen' }, icon('chevron-down'));
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        if (this.open && this.showAll) return this.close();
        this.input.focus();
        this.showAll = true;
        this.refresh(true);
      });
      this.el.append(btn);
    }

    this.input.addEventListener('input', () => { this.showAll = false; this.navigated = false; this.refresh(true); });
    this.input.addEventListener('focus', () => this.input.select());
    this.input.addEventListener('blur', () => { this.close(); this.normalize(); this.updateGhost(); });
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.list.addEventListener('mousedown', e => e.preventDefault());
    this.updateBadge();
  }

  get value() { return this.input.value.trim(); }
  set value(v) { this.input.value = v || ''; this.updateGhost(); this.updateBadge(); this.input.classList.remove('invalid'); }

  /** Exakter Treffer (ohne Groß/Klein) oder null */
  exact(v = this.value) {
    const n = norm(v);
    return this.o.items().find(i => norm(i.value) === n) || null;
  }

  compute() {
    const all = this.o.items().slice().sort((a, b) => (b.score || 0) - (a.score || 0) || a.value.localeCompare(b.value, 'de'));
    const q = norm(this.input.value.trim());
    if (this.showAll || !q) return { list: this.showAll ? all : [], prefix: null };
    const prefix = [], word = [], inner = [];
    for (const it of all) {
      const n = norm(it.value);
      if (n.startsWith(q)) prefix.push(it);
      else if (n.split(/[\s\-&/]+/).some(w => w.startsWith(q))) word.push(it);
      else if (n.includes(q)) inner.push(it);
    }
    return { list: [...prefix, ...word, ...inner].slice(0, 8), prefix: prefix[0] || null };
  }

  refresh(openList) {
    const { list, prefix } = this.compute();
    this.matches = list;
    this.prefix = prefix;
    this.active = list.length ? (this.showAll ? Math.max(0, list.findIndex(i => norm(i.value) === norm(this.value))) : 0) : -1;
    this.updateGhost();
    this.updateBadge();
    this.input.classList.remove('invalid');
    if (openList) this.renderList();
  }

  updateGhost() {
    const typed = this.input.value;
    const p = this.prefix;
    if (document.activeElement === this.input && p && typed && norm(p.value).startsWith(norm(typed)) && p.value.length > typed.length) {
      this.ghost.innerHTML = `<span class="typed">${esc(typed)}</span>${esc(p.value.slice(typed.length))}`;
    } else {
      this.ghost.textContent = '';
    }
  }

  updateBadge() {
    if (!this.badge) return;
    const it = this.exact() || (document.activeElement === this.input && this.prefix) || null;
    this.badge.replaceWith(this.badge = it && it.cat ? Object.assign(catBadge(it.cat), { className: 'combo-icon cat-badge' }) : h('span', { class: 'combo-icon' }, icon('tag')));
  }

  renderList() {
    const q = this.input.value.trim();
    this.list.innerHTML = '';
    const items = this.matches;
    items.forEach((it, i) => {
      const li = h('li', { role: 'option', class: i === this.active ? 'active' : '', 'aria-selected': String(i === this.active) });
      if (it.cat) li.append(catBadge(it.cat));
      const label = h('span');
      const n = norm(it.value), qn = norm(q), pos = qn && !this.showAll ? n.indexOf(qn) : -1;
      if (pos >= 0) label.innerHTML = esc(it.value.slice(0, pos)) + '<mark>' + esc(it.value.slice(pos, pos + q.length)) + '</mark>' + esc(it.value.slice(pos + q.length));
      else label.textContent = it.value;
      li.append(label);
      if (it.meta) li.append(h('span', { class: 'meta' }, it.meta));
      li.addEventListener('click', () => { this.pick(it.value); this.close(); });
      li.addEventListener('mousemove', () => { if (this.active !== i) { this.active = i; this.paintActive(); } });
      this.list.append(li);
    });
    this.createIndex = -1;
    if (this.o.strict && this.o.onCreate && q && !this.exact(q) && !this.showAll) {
      this.createIndex = items.length;
      const li = h('li', { class: 'create' + (items.length === 0 ? ' active' : '') }, icon('plus'), h('span', {}, `Neue Kategorie „${q}“ anlegen`));
      li.addEventListener('click', () => this.create(q));
      this.list.append(li);
      if (items.length === 0) this.active = this.createIndex;
    }
    const show = this.list.children.length > 0 && (this.showAll || q.length > 0);
    this.list.hidden = !show;
    this.open = show;
    this.input.setAttribute('aria-expanded', String(show));
    if (show) {
      const a = this.list.children[this.active];
      if (a) a.scrollIntoView({ block: 'nearest' });
    }
  }

  paintActive() {
    [...this.list.children].forEach((li, i) => li.classList.toggle('active', i === this.active));
    const a = this.list.children[this.active];
    if (a) a.scrollIntoView({ block: 'nearest' });
  }

  close() {
    this.open = false;
    this.showAll = false;
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
  }

  pick(value) {
    this.input.value = value;
    this.prefix = null;
    this.updateGhost();
    this.updateBadge();
    this.input.classList.remove('invalid');
    if (this.o.onCommit) this.o.onCommit(value);
  }

  async create(name) {
    this.close();
    const v = await this.o.onCreate(name);
    if (v) this.pick(v);
    this.input.focus();
  }

  /** Vorschlag übernehmen, falls es einen gibt. true = übernommen */
  acceptSuggestion() {
    if (!this.value) return false;
    if (this.active === this.createIndex && this.createIndex >= 0) return false;
    const it = this.matches[this.active] || this.prefix;
    if (it && (this.navigated || this.prefix === it || this.o.strict)) {
      if (it.value !== this.input.value) this.pick(it.value);
      else if (this.o.onCommit) this.o.onCommit(it.value);
      return true;
    }
    return false;
  }

  normalize() {
    const ex = this.exact();
    if (ex && ex.value !== this.input.value) this.input.value = ex.value;
    this.updateBadge();
  }

  onKey(e) {
    const n = this.list.children.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) {
        this.showAll = !this.value;
        this.refresh(true);
        if (!this.value) return;
      }
      if (!n) return;
      this.navigated = true;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      this.paintActive();
    } else if (e.key === 'Enter') {
      if (this.open && this.navigated) {
        e.preventDefault();
        if (this.active === this.createIndex) this.create(this.value);
        else { this.pick(this.matches[this.active].value); this.close(); }
        return;
      }
      if (this.open && this.active === this.createIndex && this.createIndex >= 0) {
        e.preventDefault();
        this.create(this.value);
        return;
      }
      this.acceptSuggestion();
      this.close();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      this.acceptSuggestion();
      this.close();
    } else if (e.key === 'Escape') {
      if (this.open) { e.preventDefault(); e.stopPropagation(); this.close(); }
      this.prefix = null;
      this.updateGhost();
    }
  }
}
