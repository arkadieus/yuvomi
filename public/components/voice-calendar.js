/**
 * Dworak Voice Calendar — głosowe dodawanie wydarzeń do kalendarza.
 * Web Speech API → parser (utils/voice-parse.js) → karta potwierdzenia (tytuł, data, godzina,
 * przypomnienie, status powiadomień) → zapis przez api.js.
 */

import { api } from '/api.js';
import { parseVoiceCommand, toLocalString } from '/utils/voice-parse.js';
import { pushStatus, enablePush } from '/push.js';

const STYLE = `
  :host { display: contents; }
  [hidden] { display: none !important; }
  .vc-toast, .vc-card { background: var(--color-surface, #fff); color: var(--color-text, #111);
    border: 1px solid var(--color-border, #ddd); border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.15);
    font-size: 13px; word-break: break-word; position: fixed; right: 12px; max-width: calc(100vw - 24px); }
  .vc-toast { padding: 10px 14px; max-width: 300px; opacity: 0; transform: translateY(8px);
    transition: opacity .2s, transform .2s; }
  .vc-toast.visible { opacity: 1; transform: translateY(0); }
  .vc-toast.error { border-color: #f87171; background: #fef2f2; color: #991b1b; }
  .vc-toast.success { border-color: #34d399; background: #f0fdf4; color: #065f46; }
  .vc-card { width: 320px; max-width: 100%; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .vc-card[hidden] { display: none; }
  .vc-heard { font-size: 12px; color: var(--color-text-secondary, #666); }
  .vc-row { display: flex; gap: 8px; }
  .vc-field { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; font-size: 12px;
    color: var(--color-text-secondary, #666); }
  .vc-field input, .vc-field select { font: inherit; font-size: 14px; padding: 8px; border-radius: 8px; min-width: 0;
    border: 1px solid var(--color-border, #ccc); background: var(--color-surface, #fff); color: var(--color-text, #111); }
  .vc-warn { color: #b45309; font-size: 12px; }
  .vc-push { font-size: 12px; padding: 8px 10px; border-radius: 8px; background: var(--color-surface-2, #f4f4f5); }
  .vc-push.ok { color: #065f46; } .vc-push.bad { color: #92400e; }
  .vc-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .vc-link { background: none; border: none; padding: 4px 0; font: inherit; font-size: 12px; cursor: pointer;
    color: var(--color-primary, #4f46e5); text-decoration: underline; }
  .vc-act { font: inherit; font-size: 14px; padding: 9px 14px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--color-border, #ccc); background: var(--color-surface, #fff); color: var(--color-text, #111); }
  .vc-act.primary { background: var(--color-primary, #4f46e5); border-color: transparent; color: #fff; }
  .vc-act:disabled { opacity: .6; cursor: default; }
  .vc-btn { position: fixed; touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0,0,0,.2);
    transition: background .2s, transform .1s; background: var(--color-primary, #4f46e5); color: #fff;
    -webkit-tap-highlight-color: transparent; }
  .vc-btn:active { transform: scale(.93); cursor: grabbing; }
  .vc-btn.listening { background: #ef4444; animation: vc-pulse 1.2s ease-in-out infinite; }
  @keyframes vc-pulse { 0%,100% { box-shadow: 0 4px 16px rgba(239,68,68,.3); } 50% { box-shadow: 0 4px 24px rgba(239,68,68,.6); } }
`;

const MIC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>`;
const STOP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

class VoiceCalendar extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._recognition = null;
    this._listening = false;
    this._pos = null;
  }

  connectedCallback() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    this._toast = el('div', { class: 'vc-toast', role: 'status', 'aria-live': 'polite' });
    this._card = el('div', { class: 'vc-card', hidden: '' });
    this._btn = el('button', { class: 'vc-btn', type: 'button', 'aria-label': 'Dodaj wydarzenie głosowo', title: 'Dodaj wydarzenie głosowo' });
    this._btn.innerHTML = MIC_ICON;
    this._btn.addEventListener('click', () => { if (!this._justDragged) this._toggle(); });
    this._btn.title = 'Dodaj wydarzenie głosowo (przeciągnij, aby przesunąć)';
    this._shadow.append(style, this._toast, this._card, this._btn);

    this._pos = this._loadPos();
    this._layout();
    this._wireDrag();
    this._onResize = () => { this._clampPos(); this._layout(); };
    window.addEventListener('resize', this._onResize);
    // Mikrofon ma sens tylko po zalogowaniu: na stronach logowania i rejestracji jest ukryty.
    this._visTimer = setInterval(() => this._syncVisibility(), 500);
    this._syncVisibility();
  }

  _syncVisibility() {
    const onAuthPage = !!document.querySelector('main.auth-page');
    if (this._btn.hidden === onAuthPage) return;
    this._btn.hidden = onAuthPage;
    if (onAuthPage) { this._stop(); this._closeCard(); this._toast.classList.remove('visible'); }
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
    clearInterval(this._visTimer);
  }

  _loadPos() {
    try {
      const p = JSON.parse(localStorage.getItem('dworak-voice-pos') || 'null');
      if (p && Number.isFinite(p.right) && Number.isFinite(p.top)) return { right: p.right, top: p.top };
    } catch { /* brak dostępu do localStorage */ }
    return { right: 20, top: Math.max(4, window.innerHeight - 80 - 56) };
  }

  _clampPos() {
    this._pos.right = Math.min(Math.max(4, this._pos.right), Math.max(4, window.innerWidth - 60));
    this._pos.top = Math.min(Math.max(4, this._pos.top), Math.max(4, window.innerHeight - 60));
  }

  // Przycisk stoi tam, gdzie go zostawiono; karta i komunikat otwierają się nad nim lub pod nim.
  _layout() {
    this._clampPos();
    const { right, top } = this._pos;
    this._btn.style.right = `${right}px`;
    this._btn.style.top = `${top}px`;
    const above = top > window.innerHeight / 2;
    for (const box of [this._toast, this._card]) {
      box.style.right = `${Math.max(12, right)}px`;
      if (above) { box.style.top = 'auto'; box.style.bottom = `${window.innerHeight - top + 8}px`; }
      else { box.style.bottom = 'auto'; box.style.top = `${top + 56 + 8}px`; }
    }
  }

  _wireDrag() {
    let start = null;
    this._btn.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, right: this._pos.right, top: this._pos.top, moved: false };
      try { this._btn.setPointerCapture(e.pointerId); } catch { /* ignoruj */ }
    });
    this._btn.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true;
      this._pos = { right: start.right - dx, top: start.top + dy };
      this._layout();
    });
    const end = () => {
      if (start?.moved) {
        try { localStorage.setItem('dworak-voice-pos', JSON.stringify(this._pos)); } catch { /* ignoruj */ }
        this._justDragged = true;
        setTimeout(() => { this._justDragged = false; }, 0);
      }
      start = null;
    };
    this._btn.addEventListener('pointerup', end);
    this._btn.addEventListener('pointercancel', end);
  }

  _showToast(msg, type = '', ms = 4000) {
    this._toast.textContent = msg;
    this._toast.className = `vc-toast${type ? ' ' + type : ''} visible`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toast.classList.remove('visible'), ms);
  }

  _toggle() {
    if (this._listening) { this._stop(); return; }
    this._closeCard();
    this._start();
  }

  _start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._showToast('Ta przeglądarka nie obsługuje rozpoznawania mowy. Użyj Chrome lub Edge.', 'error', 6000);
      return;
    }
    const r = new SR();
    r.lang = 'pl-PL';
    r.interimResults = false;
    r.maxAlternatives = 1;

    r.onstart = () => {
      this._listening = true;
      this._btn.classList.add('listening');
      this._btn.innerHTML = STOP_ICON;
      this._showToast('Słucham… np. „jutro o 13:00 spotkanie w Rzeszowie”', '', 15000);
    };
    r.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim();
      this._stop();
      if (transcript) this._review(transcript);
    };
    r.onerror = (e) => {
      this._stop();
      const msgs = {
        'no-speech': 'Nic nie usłyszałem. Spróbuj jeszcze raz.',
        'not-allowed': 'Brak dostępu do mikrofonu. Zezwól na niego w ustawieniach przeglądarki.',
        network: 'Błąd sieci. Sprawdź połączenie.',
        'service-not-allowed': 'Ta przeglądarka nie udostępnia rozpoznawania mowy w zainstalowanej aplikacji. Otwórz Dworak Planer w Chrome (Android) lub Safari.',
        'audio-capture': 'Nie znaleziono mikrofonu.',
        'language-not-supported': 'Język polski nie jest obsługiwany przez rozpoznawanie mowy w tej przeglądarce.',
        aborted: '',
      };
      const msg = msgs[e.error] ?? `Błąd: ${e.error}`;
      if (msg) this._showToast(msg, 'error', 7000);
    };
    r.onend = () => { if (this._listening) this._stop(); };
    this._recognition = r;
    r.start();
  }

  _stop() {
    this._listening = false;
    this._btn.classList.remove('listening');
    this._btn.innerHTML = MIC_ICON;
    if (this._recognition) { try { this._recognition.stop(); } catch { /* już zatrzymane */ } this._recognition = null; }
  }

  _closeCard() {
    this._card.hidden = true;
    this._card.replaceChildren();
  }

  /** Karta potwierdzenia: pokazuje, jak aplikacja zrozumiała wypowiedź, i pozwala to poprawić. */
  async _review(text) {
    this._toast.classList.remove('visible');
    const p = parseVoiceCommand(text);

    const title = el('input', { type: 'text', value: p.title || text, maxlength: '200', 'aria-label': 'Tytuł' });
    const date = el('input', { type: 'date', value: toLocalString(p.start, true), 'aria-label': 'Data' });
    const time = el('input', { type: 'time', value: p.allDay ? '' : `${pad(p.start.getHours())}:${pad(p.start.getMinutes())}`, 'aria-label': 'Godzina' });
    const remind = el('select', { 'aria-label': 'Przypomnienie' });
    const warn = el('div', { class: 'vc-warn', hidden: '' });
    const pushLine = el('div', { class: 'vc-push', role: 'status' });
    const pushActions = el('div', { class: 'vc-actions' });

    const fillRemind = () => {
      const allDay = !time.value;
      const keep = remind.value;
      remind.replaceChildren();
      const opts = allDay
        ? [['allday', 'Przypomnij o 8:00 w tym dniu'], ['none', 'Bez przypomnienia']]
        : [['0', 'W chwili rozpoczęcia'], ['15', '15 minut przed'], ['60', '1 godzinę przed'], ['none', 'Bez przypomnienia']];
      for (const [v, label] of opts) remind.append(el('option', { value: v, text: label }));
      const wanted = allDay ? 'allday' : (p.remindAtStart ? '0' : '15');
      remind.value = [...remind.options].some((o) => o.value === keep) ? keep : wanted;
    };
    fillRemind();
    time.addEventListener('input', fillRemind);

    const compute = () => {
      const allDay = !time.value;
      if (!date.value) return null;
      const [y, mo, d] = date.value.split('-').map(Number);
      const [h, mi] = allDay ? [0, 0] : time.value.split(':').map(Number);
      const start = new Date(y, mo - 1, d, h, mi, 0, 0);
      let at = null;
      if (remind.value === 'allday') { at = new Date(y, mo - 1, d, 8, 0, 0, 0); }
      else if (remind.value !== 'none') { at = new Date(start.getTime() - Number(remind.value) * 60000); }
      return { start, allDay, remindAt: at };
    };
    const refreshWarn = () => {
      const c = compute();
      const past = c && (c.allDay ? c.start < new Date(new Date().setHours(0, 0, 0, 0)) : c.start < new Date());
      warn.hidden = !past;
      warn.textContent = past ? 'Ten termin już minął — sprawdź datę i godzinę.' : '';
    };
    for (const f of [date, time, remind]) f.addEventListener('input', refreshWarn);
    refreshWarn();

    const saveBtn = el('button', { class: 'vc-act primary', type: 'button', text: 'Zapisz' });
    const cancelBtn = el('button', { class: 'vc-act', type: 'button', text: 'Anuluj', onclick: () => this._closeCard() });

    const renderPush = async () => {
      pushActions.replaceChildren();
      let st;
      try { st = await pushStatus(); } catch { st = { supported: false }; }
      if (remind.value === 'none') {
        pushLine.className = 'vc-push';
        pushLine.textContent = 'Bez przypomnienia — powiadomienie nie zostanie wysłane.';
        return;
      }
      if (st.supported && st.subscribed && st.permission === 'granted') {
        pushLine.className = 'vc-push ok';
        pushLine.textContent = '✓ Powiadomienia włączone na tym urządzeniu — przypomnienie przyjdzie jako powiadomienie.';
        pushActions.append(el('button', { class: 'vc-link', type: 'button', text: 'Wyślij testowe powiadomienie', onclick: () => this._sendTest(pushLine) }));
      } else if (!st.supported) {
        pushLine.className = 'vc-push bad';
        pushLine.textContent = '⚠ Ta przeglądarka nie obsługuje powiadomień. Na iPhonie zainstaluj aplikację na ekranie głównym (Udostępnij → Dodaj do ekranu początkowego) i otwórz ją stamtąd.';
      } else if (st.permission === 'denied') {
        pushLine.className = 'vc-push bad';
        pushLine.textContent = '⚠ Powiadomienia są zablokowane w ustawieniach telefonu/przeglądarki. Odblokuj je dla tej aplikacji, a przypomnienia zaczną przychodzić.';
      } else {
        pushLine.className = 'vc-push bad';
        pushLine.textContent = '⚠ Powiadomienia są wyłączone — przypomnienie nie przyjdzie.';
        pushActions.append(el('button', {
          class: 'vc-act primary', type: 'button', text: 'Włącz powiadomienia',
          onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try { await enablePush(); } catch { /* status poniżej pokaże wynik */ }
            renderPush();
          },
        }));
      }
    };
    remind.addEventListener('input', renderPush);

    saveBtn.addEventListener('click', async () => {
      const c = compute();
      const t = title.value.trim();
      if (!t) { title.focus(); return; }
      if (!c) { date.focus(); return; }
      saveBtn.disabled = true;
      await this._save({ title: t, ...c });
      saveBtn.disabled = false;
    });

    const field = (label, input) => el('label', { class: 'vc-field' }, label, input);
    this._card.replaceChildren(
      el('div', { class: 'vc-heard', text: `Usłyszałem: „${text}”` }),
      field('Tytuł', title),
      el('div', { class: 'vc-row' }, field('Data', date), field('Godzina (puste = cały dzień)', time)),
      el('div', { class: 'vc-field' }, 'Przypomnienie', remind),
      warn,
      pushLine,
      pushActions,
      el('div', { class: 'vc-actions' }, cancelBtn, saveBtn),
    );
    this._card.hidden = false;
    renderPush();
  }

  async _sendTest(line) {
    line.textContent = 'Wysyłam test…';
    try {
      let endpoint;
      try {
        const reg = await navigator.serviceWorker.ready;
        endpoint = (await reg.pushManager.getSubscription())?.endpoint;
      } catch { /* brak subskrypcji */ }
      const res = await api.post('/push/test', {
        title: 'Dworak Planer',
        body: 'Test powiadomień — działa.',
        ...(endpoint ? { endpoint } : {}),
      });
      line.textContent = Number(res?.data?.sent) > 0
        ? '✓ Test wysłany — powiadomienie powinno pojawić się na telefonie za chwilę.'
        : '⚠ Serwer nie dostarczył testu. Wyłącz i włącz powiadomienia w Ustawienia → Powiadomienia.';
    } catch (err) {
      line.textContent = `⚠ Nie udało się wysłać testu: ${err.message}`;
    }
  }

  async _save({ title, start, allDay, remindAt }) {
    const startStr = toLocalString(start, allDay);
    const end = allDay ? start : new Date(start.getTime() + 60 * 60 * 1000);
    let id;
    try {
      const res = await api.post('/calendar', {
        title,
        start_datetime: startStr,
        end_datetime: toLocalString(end, allDay),
        all_day: allDay,
        visibility: 'all',
      });
      id = res?.data?.id;
    } catch (err) {
      this._showToast(`Nie udało się dodać: ${err.message}`, 'error', 7000);
      return;
    }

    const when = `${fmtDay(start)}${allDay ? ' (cały dzień)' : ` ${pad(start.getHours())}:${pad(start.getMinutes())}`}`;
    let remindMsg = '';
    if (remindAt && id) {
      const at = remindAt > new Date() ? remindAt : null;
      if (!at) remindMsg = ' Przypomnienie pominięte (termin już minął).';
      else {
        try {
          await api.put(`/reminders?entity_type=event&entity_id=${id}`, { remind_ats: [at.toISOString()] });
          remindMsg = ` Przypomnienie: ${fmtDay(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}.`;
        } catch (err) {
          remindMsg = ` Wydarzenie dodane, ale przypomnienia nie udało się ustawić (${err.message}).`;
        }
      }
    }
    this._closeCard();
    this._showToast(`✓ Dodano: „${title}” — ${when}.${remindMsg}`, 'success', 9000);
    window.dispatchEvent(new CustomEvent('calendar-changed'));
  }
}

customElements.define('dworak-voice-calendar', VoiceCalendar);
