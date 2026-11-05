/**
 * Dworak Voice Calendar — głosowe dodawanie wydarzeń do kalendarza
 * Używa Web Speech API (przeglądarkowe, bezpłatne) + polski parser dat
 */

const STYLE = `
  :host {
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    pointer-events: none;
  }
  .vc-toast {
    background: var(--color-surface, #fff);
    color: var(--color-text, #111);
    border: 1px solid var(--color-border, #ddd);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 280px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    pointer-events: auto;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.2s, transform 0.2s;
    word-break: break-word;
  }
  .vc-toast.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .vc-toast.error {
    border-color: #f87171;
    background: #fef2f2;
    color: #991b1b;
  }
  .vc-toast.success {
    border-color: #34d399;
    background: #f0fdf4;
    color: #065f46;
  }
  .vc-btn {
    pointer-events: auto;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    transition: background 0.2s, transform 0.1s;
    background: var(--color-primary, #4f46e5);
    color: #fff;
    -webkit-tap-highlight-color: transparent;
  }
  .vc-btn:active { transform: scale(0.93); }
  .vc-btn.listening {
    background: #ef4444;
    animation: vc-pulse 1.2s ease-in-out infinite;
  }
  @keyframes vc-pulse {
    0%,100% { box-shadow: 0 4px 16px rgba(239,68,68,0.3); }
    50%      { box-shadow: 0 4px 24px rgba(239,68,68,0.6); }
  }
`;

/* ---- Parser polskich dat i godzin ---- */
function parsePolishDate(text) {
  const now = new Date();
  let base = new Date(now);
  base.setSeconds(0, 0);

  const lower = text.toLowerCase();

  // Względne dni
  if (/\bjutro\b/.test(lower))     base.setDate(base.getDate() + 1);
  else if (/\bpojutrze\b/.test(lower)) base.setDate(base.getDate() + 2);
  else if (/\bwczoraj\b/.test(lower))  base.setDate(base.getDate() - 1);
  else {
    // Konkretny dzień tygodnia
    const days = { poniedziałek:1, wtorek:2, środa:3, czwartek:4, piątek:5, sobota:6, niedziela:0 };
    for (const [name, dow] of Object.entries(days)) {
      if (lower.includes(name)) {
        const diff = (dow - base.getDay() + 7) % 7 || 7;
        base.setDate(base.getDate() + diff);
        break;
      }
    }
    // "za N dni/tygodni"
    const zaM = lower.match(/za\s+(\d+)\s+(dni|tydzi[eę]|tygo[dt])/);
    if (zaM) {
      const n = parseInt(zaM[1], 10);
      if (/tydzi|tygo/.test(zaM[2])) base.setDate(base.getDate() + n * 7);
      else base.setDate(base.getDate() + n);
    }
  }

  // Godzina: "o 13", "o 13:30", "13:00", "13.00"
  const timeM = lower.match(/\bo\s+(\d{1,2})(?:[:\.](\d{2}))?\b/) ||
                lower.match(/\b(\d{1,2})[:\.](\d{2})\b/);
  if (timeM) {
    const h = parseInt(timeM[1], 10);
    const m = timeM[2] ? parseInt(timeM[2], 10) : 0;
    if (h >= 0 && h <= 23) {
      base.setHours(h, m, 0, 0);
    }
  } else {
    base.setHours(12, 0, 0, 0);
  }

  return base;
}

/* ---- Wyciągnij tytuł (usuń markery czasu) ---- */
function extractTitle(text) {
  return text
    .replace(/\b(jutro|pojutrze|wczoraj|poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela)\b/gi, '')
    .replace(/\bza\s+\d+\s+(dni|tydzi[eę]|tygo[dt]\w*)\b/gi, '')
    .replace(/\bo\s+\d{1,2}(?:[:.]\d{2})?\b/gi, '')
    .replace(/\b\d{1,2}[:.]\d{2}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ---- Web Component ---- */
class VoiceCalendar extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._recognition = null;
    this._listening = false;
  }

  connectedCallback() {
    const style = document.createElement('style');
    style.textContent = STYLE;

    this._toast = document.createElement('div');
    this._toast.className = 'vc-toast';

    this._btn = document.createElement('button');
    this._btn.className = 'vc-btn';
    this._btn.setAttribute('aria-label', 'Dodaj wydarzenie głosowo');
    this._btn.setAttribute('title', 'Dodaj wydarzenie głosowo');
    this._btn.innerHTML = MIC_ICON;

    this._btn.addEventListener('click', () => this._toggle());

    this._shadow.append(style, this._toast, this._btn);
  }

  _showToast(msg, type = '', ms = 4000) {
    this._toast.textContent = msg;
    this._toast.className = `vc-toast${type ? ' ' + type : ''} visible`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, ms);
  }

  _toggle() {
    if (this._listening) { this._stop(); return; }
    this._start();
  }

  _start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._showToast('Twoja przeglądarka nie obsługuje rozpoznawania mowy. Użyj Chrome lub Edge.', 'error', 6000);
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
      this._showToast('Słucham… powiedz np. „jutro o 13:00 mam spotkanie w Rzeszowie"', '', 15000);
    };

    r.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim();
      this._stop();
      this._handleTranscript(transcript);
    };

    r.onerror = (e) => {
      this._stop();
      const msgs = {
        'no-speech': 'Nie usłyszałem nic. Spróbuj jeszcze raz.',
        'not-allowed': 'Brak dostępu do mikrofonu. Zezwól w ustawieniach przeglądarki.',
        'network': 'Błąd sieci. Sprawdź połączenie.',
      };
      this._showToast(msgs[e.error] || `Błąd: ${e.error}`, 'error');
    };

    r.onend = () => { if (this._listening) this._stop(); };

    this._recognition = r;
    r.start();
  }

  _stop() {
    this._listening = false;
    this._btn.classList.remove('listening');
    this._btn.innerHTML = MIC_ICON;
    if (this._recognition) { try { this._recognition.stop(); } catch (_) {} this._recognition = null; }
  }

  async _handleTranscript(text) {
    this._showToast(`Rozpoznano: „${text}"`, '', 6000);

    const start = parsePolishDate(text);
    const title = extractTitle(text) || text;
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

    try {
      const res = await fetch('/api/v1/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          title,
          start_datetime: fmt(start),
          end_datetime: fmt(end),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._showToast(`✓ Dodano: „${title}" — ${start.toLocaleDateString('pl-PL', {weekday:'short',day:'numeric',month:'short'})} ${pad(start.getHours())}:${pad(start.getMinutes())}`, 'success', 5000);
    } catch (err) {
      this._showToast(`Nie udało się dodać: ${err.message}`, 'error');
    }
  }
}

const MIC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>`;
const STOP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

customElements.define('dworak-voice-calendar', VoiceCalendar);
