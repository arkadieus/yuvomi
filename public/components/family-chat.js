/**
 * Dworak Family Chat — czat rodzinny (tylko tekst) jako pływający panel.
 * Wątki: „Wszyscy” (grupa) i rozmowy prywatne. Odświeżanie przez odpytywanie,
 * licznik nieprzeczytanych na przycisku, powiadomienia push z serwera.
 */
import { api } from '/api.js';

const POS_KEY = 'dworak-chat-pos';

const STYLE = `
  :host { display: contents; }
  [hidden] { display: none !important; }
  .fc-btn { position: fixed; touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer;
    width: 56px; height: 56px; border-radius: 50%; border: none; z-index: 900;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0,0,0,.2);
    background: var(--color-primary, #4f46e5); color: #fff; -webkit-tap-highlight-color: transparent; }
  .fc-btn:active { transform: scale(.93); }
  .fc-badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 5px;
    border-radius: 10px; background: #ef4444; color: #fff; font: 700 12px/20px system-ui, sans-serif; text-align: center; }
  .fc-panel { position: fixed; z-index: 901; width: 360px; max-width: calc(100vw - 16px);
    height: min(520px, calc(100vh - 100px)); display: flex; flex-direction: column; overflow: hidden;
    background: var(--color-surface, #fff); color: var(--color-text, #111);
    border: 1px solid var(--color-border, #ddd); border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.25);
    font: 14px/1.4 system-ui, sans-serif; }
  .fc-head { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid var(--color-border, #ddd); }
  .fc-head select { flex: 1; min-width: 0; font: inherit; padding: 7px; border-radius: 8px;
    border: 1px solid var(--color-border, #ccc); background: var(--color-surface, #fff); color: inherit; }
  .fc-x { background: none; border: none; font-size: 22px; line-height: 1; cursor: pointer; color: inherit; padding: 4px 8px; }
  .fc-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px;
    overscroll-behavior: contain; }
  .fc-empty { margin: auto; color: var(--color-text-secondary, #666); text-align: center; font-size: 13px; }
  .fc-msg { max-width: 82%; padding: 7px 10px; border-radius: 12px; background: var(--color-surface-2, #f1f1f3);
    word-break: break-word; white-space: pre-wrap; align-self: flex-start; }
  .fc-msg.mine { align-self: flex-end; background: var(--color-primary, #4f46e5); color: #fff; }
  .fc-meta { font-size: 11px; opacity: .7; margin-top: 2px; }
  .fc-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--color-border, #ddd); }
  .fc-form textarea { flex: 1; min-width: 0; resize: none; font: inherit; padding: 8px; border-radius: 10px; max-height: 90px;
    border: 1px solid var(--color-border, #ccc); background: var(--color-surface, #fff); color: inherit; }
  .fc-send { font: inherit; padding: 0 14px; border-radius: 10px; border: none; cursor: pointer;
    background: var(--color-primary, #4f46e5); color: #fff; }
  .fc-send:disabled { opacity: .6; }
  .fc-err { color: #b91c1c; font-size: 12px; padding: 0 10px 6px; }
`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })} ${hm}`;
};

class FamilyChat extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this._open = false;
    this._thread = 'group';
    this._members = [];
    this._lastId = 0;
    this._me = null;
    this._pos = this._loadPos();

    const root = this.attachShadow({ mode: 'open' });
    root.append(el('style', { text: STYLE }));
    this._badge = el('span', { class: 'fc-badge', hidden: '' });
    this._btn = el('button', { class: 'fc-btn', type: 'button', 'aria-label': 'Czat rodzinny', hidden: '' });
    this._btn.insertAdjacentHTML('afterbegin', ICON);
    this._btn.append(this._badge);

    this._select = el('select', { 'aria-label': 'Rozmowa', onchange: () => this._switch(this._select.value) });
    this._list = el('div', { class: 'fc-list', 'aria-live': 'polite' });
    this._err = el('div', { class: 'fc-err', hidden: '' });
    this._input = el('textarea', { rows: '1', maxlength: '2000', placeholder: 'Napisz wiadomość…', 'aria-label': 'Wiadomość' });
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    this._sendBtn = el('button', { class: 'fc-send', type: 'button', text: 'Wyślij', onclick: () => this._send() });
    this._panel = el('div', { class: 'fc-panel', role: 'dialog', 'aria-label': 'Czat rodzinny', hidden: '' },
      el('div', { class: 'fc-head' }, this._select,
        el('button', { class: 'fc-x', type: 'button', 'aria-label': 'Zamknij', text: '×', onclick: () => this._toggle(false) })),
      this._list, this._err,
      el('div', { class: 'fc-form' }, this._input, this._sendBtn));
    root.append(this._btn, this._panel);

    this._wireDrag();
    this._onResize = () => this._layout();
    window.addEventListener('resize', this._onResize);
    this._layout();

    this._timer = setInterval(() => this._tick(), 5000);
    this._tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._tick(true); });
    if (new URLSearchParams(location.search).get('chat') === '1') this._pendingOpen = true;
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    window.removeEventListener('resize', this._onResize);
  }

  _loadPos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) return { left: p.left, top: p.top };
    } catch { /* brak localStorage */ }
    return { left: 16, top: Math.max(4, window.innerHeight - 160) };
  }

  _layout() {
    this._pos.left = Math.min(Math.max(4, this._pos.left), Math.max(4, window.innerWidth - 60));
    this._pos.top = Math.min(Math.max(4, this._pos.top), Math.max(4, window.innerHeight - 60));
    const { left, top } = this._pos;
    this._btn.style.left = `${left}px`;
    this._btn.style.top = `${top}px`;
    const p = this._panel.style;
    p.left = `${Math.min(Math.max(8, left), Math.max(8, window.innerWidth - 368))}px`;
    if (top > window.innerHeight / 2) { p.top = 'auto'; p.bottom = `${window.innerHeight - top + 8}px`; }
    else { p.bottom = 'auto'; p.top = `${top + 64}px`; }
  }

  _wireDrag() {
    let start = null;
    this._btn.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, left: this._pos.left, top: this._pos.top, moved: false };
      try { this._btn.setPointerCapture(e.pointerId); } catch { /* ignoruj */ }
    });
    this._btn.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true;
      this._pos = { left: start.left + dx, top: start.top + dy };
      this._layout();
    });
    const end = () => {
      if (start?.moved) {
        try { localStorage.setItem(POS_KEY, JSON.stringify(this._pos)); } catch { /* ignoruj */ }
        this._justDragged = true;
        setTimeout(() => { this._justDragged = false; }, 0);
      }
      start = null;
    };
    this._btn.addEventListener('pointerup', end);
    this._btn.addEventListener('pointercancel', end);
    this._btn.addEventListener('click', () => { if (!this._justDragged) this._toggle(!this._open); });
  }

  async _toggle(open) {
    this._open = open;
    this._panel.hidden = !open;
    if (!open) return;
    await this._loadMembers();
    this._lastId = 0;
    this._list.replaceChildren();
    await this._poll(true);
    this._input.focus();
  }

  async _loadMembers() {
    try {
      const res = await api.get('/chat/members');
      this._members = res?.data ?? [];
    } catch { /* zostaje poprzednia lista */ }
    const keep = this._thread;
    this._select.replaceChildren(el('option', { value: 'group', text: 'Wszyscy (rodzina)' }));
    for (const m of this._members) this._select.append(el('option', { value: String(m.id), text: m.display_name }));
    this._select.value = [...this._select.options].some((o) => o.value === keep) ? keep : 'group';
    this._thread = this._select.value;
  }

  _switch(value) {
    this._thread = value;
    this._lastId = 0;
    this._list.replaceChildren();
    this._poll(true);
  }

  async _tick(force = false) {
    if (document.hidden && !force) return;
    if (document.querySelector('main.auth-page')) { this._btn.hidden = true; return; }
    try {
      const res = await api.get('/chat/summary');
      this._btn.hidden = false;
      const total = Number(res?.data?.total) || 0;
      // Otwarta rozmowa jest czytana na bieżąco, więc nie liczy się jako nieprzeczytana.
      this._badge.hidden = total === 0 || (this._open && total === (Number(res?.data?.unread?.[this._key()]) || 0));
      this._badge.textContent = total > 99 ? '99+' : String(total);
      if (this._pendingOpen) { this._pendingOpen = false; this._toggle(true); return; }
      if (this._open) await this._poll(false);
    } catch {
      // Brak sesji (401) albo sieci: przycisk zostaje ukryty do następnej udanej próby.
      if (!this._open) this._btn.hidden = true;
    }
  }

  _key() { return this._thread === 'group' ? 'group' : `u${this._thread}`; }

  async _poll(scroll) {
    if (this._polling) return;
    this._polling = true;
    const thread = this._thread;
    try {
      const res = await api.get(`/chat/messages?thread=${encodeURIComponent(thread)}&after=${this._lastId}`);
      if (thread !== this._thread) return; // użytkownik zmienił rozmowę w trakcie
      this._me = res?.me ?? this._me;
      const rows = res?.data ?? [];
      if (rows.length) this._append(rows, scroll);
      else if (!this._list.children.length) this._showEmpty();
      this._err.hidden = true;
    } catch {
      /* chwilowy błąd — spróbujemy za 5 s */
    } finally {
      this._polling = false;
    }
  }

  _showEmpty() {
    this._list.replaceChildren(el('div', { class: 'fc-empty', text: 'Brak wiadomości. Napisz pierwszą.' }));
  }

  _append(rows, forceScroll) {
    this._list.querySelector('.fc-empty')?.remove();
    const nearBottom = this._list.scrollHeight - this._list.scrollTop - this._list.clientHeight < 80;
    for (const m of rows) {
      if (m.id <= this._lastId) continue;
      this._lastId = m.id;
      const mine = m.user_id === this._me;
      const showAuthor = this._thread === 'group' && !mine;
      this._list.append(el('div', { class: `fc-msg${mine ? ' mine' : ''}` },
        showAuthor ? el('strong', { text: m.author }) : null,
        showAuthor ? document.createElement('br') : null,
        document.createTextNode(m.body),
        el('div', { class: 'fc-meta', text: fmtTime(m.created_at) })));
    }
    if (forceScroll || nearBottom) this._list.scrollTop = this._list.scrollHeight;
  }

  async _send() {
    const body = this._input.value.trim();
    if (!body || this._sendBtn.disabled) return;
    this._sendBtn.disabled = true;
    try {
      const res = await api.post('/chat/messages', { thread: this._thread, body });
      this._input.value = '';
      this._err.hidden = true;
      if (res?.data) this._append([res.data], true);
    } catch (e) {
      this._err.textContent = e?.message || 'Nie udało się wysłać wiadomości.';
      this._err.hidden = false;
    } finally {
      this._sendBtn.disabled = false;
    }
  }
}

if (!customElements.get('dworak-family-chat')) customElements.define('dworak-family-chat', FamilyChat);
