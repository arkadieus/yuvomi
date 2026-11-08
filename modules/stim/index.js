/**
 * Program stymulacyjny — moduł planera (przeniesiony z aplikacji Lovable „Program Stymulacyjny").
 * Widoki: Dzieci (sesje rano/wieczór) · Plan dziecka · Biblioteka ćwiczeń · Historia · Sesja z timerem.
 * Dostęp ogranicza serwer (klucz uprawnień ext:stim); ten plik tylko ukrywa przyciski, gdy ktoś ma „odczyt".
 */
import { api } from '/api.js';
import { renderPageHeader, renderPageTitle, renderPageBody } from '/utils/page-layout.js';

// ---------------------------------------------------------------- narzędzia DOM
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const btn = (text, onclick, cls = '') => h('button', { type: 'button', class: `stim-btn ${cls}`.trim(), text, onclick });

function toast(msg, tone = 'default') {
  try { window.yuvomi?.showToast?.(msg, tone); } catch { /* brak toasta */ }
}
const errText = (e) => e?.data?.error || e?.message || 'Coś poszło nie tak. Spróbuj ponownie.';

const SLOT_NAME = { morning: 'poranna', evening: 'wieczorna' };
const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`);
const fmtDate = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' });
};

// ---------------------------------------------------------------- dźwięk (Web Audio, bez plików)
let audioCtx = null;
function ctx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function ping(c, start, freq, dur, peak) {
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, start);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}
const playEnd = () => { const c = ctx(); if (c) { ping(c, c.currentTime, 1046.5, 0.18, 0.5); ping(c, c.currentTime + 0.16, 1568, 0.18, 0.5); } };
const playTick = () => { const c = ctx(); if (c) ping(c, c.currentTime, 1320, 0.22, 0.4); };

/** „40 sekund na każdą…" w instrukcji → sygnał co tyle sekund (zmiana strony ciała). */
function intervalFrom(instructions, total) {
  const text = String(instructions || '').toLowerCase();
  const sec = text.match(/(\d+)\s*sekund\w*\s+na\s+(każd|jedn)/);
  const min = text.match(/(\d+)\s*minut\w*\s+na\s+(każd|jedn)/);
  const s = sec ? Number(sec[1]) : min ? Number(min[1]) * 60 : 0;
  return s > 0 && s < total ? s : 0;
}

// ---------------------------------------------------------------- moduł
export async function render(container, context = {}) {
  const signal = context.signal;
  const S = { view: 'home', child: null, canWrite: true, children: [], exercises: [], session: null };

  // Poziom dostępu tylko do ukrycia przycisków; egzekwuje serwer.
  try {
    const me = await api.get('/auth/me');
    const p = me?.permissions ?? me?.data?.permissions;
    S.canWrite = p?.admin === true || (p?.modules?.['ext:stim'] ?? 'write') === 'write';
  } catch { /* zostaje domyślnie */ }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({ title: renderPageTitle('Program stymulacyjny') })
    + renderPageBody({ content: '<div class="stim" id="stim-root"></div>' }));
  const root = container.querySelector('#stim-root');
  let timers = [];
  let wakeLock = null;
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
  const releaseWake = () => { try { wakeLock?.release?.(); } catch { /* ignoruj */ } wakeLock = null; };
  signal?.addEventListener('abort', () => { clearTimers(); releaseWake(); });
  const alive = () => !signal?.aborted;

  const go = (view, extra = {}) => { clearTimers(); if (view !== 'session') releaseWake(); Object.assign(S, extra, { view }); draw(); };

  function nav() {
    const tab = (id, label) => h('button', {
      type: 'button', class: 'stim-tab', text: label, 'aria-current': S.view === id ? 'page' : null, onclick: () => go(id),
    });
    return h('div', { class: 'stim-tabs' }, tab('home', 'Dzieci'), tab('library', 'Biblioteka ćwiczeń'), tab('history', 'Historia'));
  }

  function draw() {
    if (!alive()) return;
    root.replaceChildren();
    const views = { home: drawHome, plan: drawPlan, library: drawLibrary, history: drawHistory, session: drawSession };
    if (S.view !== 'session') root.append(nav());
    (views[S.view] || drawHome)();
  }

  async function guard(promise, fallback) {
    try { return await promise; } catch (e) { toast(errText(e), 'danger'); return fallback; }
  }

  // ---------- Dzieci
  async function drawHome() {
    const list = h('div', { class: 'stim' });
    root.append(list);
    const res = await guard(api.get('/stim/children'), null);
    if (!alive()) return;
    S.children = res?.data ?? [];
    list.replaceChildren();
    if (!S.children.length) list.append(h('div', { class: 'stim-empty', text: S.canWrite ? 'Nie dodano jeszcze żadnego dziecka.' : 'Brak dzieci do wyświetlenia.' }));
    for (const c of S.children) list.append(childCard(c));
    if (S.canWrite) list.append(addChildForm());
  }

  function childCard(c) {
    const slot = (key) => {
      const s = c[key];
      return h('div', { class: `stim-slot${s.done ? ' done' : ''}` },
        h('strong', { text: `Sesja ${SLOT_NAME[key]}` }),
        s.done
          ? h('span', { class: 'stim-sub', text: `Ukończona${s.by_name ? ` · ${s.by_name}` : ''} · zaangażowanie ${s.avg_engagement}%` })
          : (S.canWrite && c.plan_count
            ? btn('Rozpocznij', () => startSession(c, key), 'primary')
            : h('span', { class: 'stim-sub', text: c.plan_count ? 'Czeka' : 'Brak planu' })));
    };
    return h('div', { class: 'stim-card' },
      h('div', { class: 'stim-child-head' },
        h('span', { class: 'stim-name', text: c.name }),
        h('span', { class: 'stim-sub', text: `Plan: ${c.plan_count} ćw.` })),
      h('div', { class: 'stim-slots' }, slot('morning'), slot('evening')),
      h('div', { class: 'stim-actions' },
        btn('Plan ćwiczeń', () => go('plan', { child: c })),
        btn('Historia', () => go('history', { child: c })),
        S.canWrite ? btn('Zmień imię', () => renameChild(c)) : null,
        S.canWrite ? btn('Usuń', () => deleteChild(c), 'danger') : null));
  }

  function addChildForm() {
    const name = h('input', { id: 'stim-new-name', type: 'text', maxlength: '100', placeholder: 'Imię dziecka' });
    const go2 = async () => {
      if (!name.value.trim()) return;
      const r = await guard(api.post('/stim/children', { name: name.value.trim() }), null);
      if (r) { toast('Dziecko dodane.', 'success'); draw(); }
    };
    return h('div', { class: 'stim-card' },
      h('div', { class: 'stim-field' }, h('label', { for: 'stim-new-name', text: 'Dodaj dziecko' }), name),
      btn('Dodaj dziecko', go2, 'primary'));
  }

  async function renameChild(c) {
    const input = h('input', { type: 'text', maxlength: '100', value: c.name, 'aria-label': 'Imię dziecka' });
    const wrap = h('div', { class: 'stim-card' }, h('div', { class: 'stim-field' }, h('label', { text: `Zmień imię: ${c.name}` }), input),
      h('div', { class: 'stim-actions' },
        btn('Zapisz', async () => {
          if (!input.value.trim()) return;
          const r = await guard(api.patch(`/stim/children/${c.id}`, { name: input.value.trim(), birth_date: c.birth_date }), null);
          if (r) draw();
        }, 'primary'),
        btn('Anuluj', () => draw())));
    root.replaceChildren(wrap);
    input.focus();
  }

  function deleteChild(c) {
    const wrap = h('div', { class: 'stim-card' },
      h('p', { text: `Usunąć ${c.name} wraz z planem, sesjami i ocenami? Tego nie można cofnąć.` }),
      h('div', { class: 'stim-actions' },
        btn('Tak, usuń', async () => { const r = await guard(api.delete(`/stim/children/${c.id}`), null); if (r) { toast('Dziecko usunięte.'); draw(); } }, 'danger'),
        btn('Anuluj', () => draw())));
    root.replaceChildren(wrap);
  }

  // ---------- Plan dziecka
  async function drawPlan() {
    const c = S.child;
    if (!c) return go('home');
    const box = h('div', { class: 'stim' });
    root.append(box);
    const [plan, ex] = await Promise.all([guard(api.get(`/stim/children/${c.id}/plan`), null), guard(api.get('/stim/exercises'), null)]);
    if (!alive()) return;
    const items = plan?.data ?? [];
    S.exercises = ex?.data ?? [];
    box.replaceChildren(h('h2', { text: `Plan: ${c.name}` }));
    const card = h('div', { class: 'stim-card' });
    if (!items.length) card.append(h('div', { class: 'stim-empty', text: 'Plan jest pusty. Dodaj ćwiczenia poniżej.' }));
    items.forEach((it, i) => {
      const secs = h('input', { type: 'number', min: '5', max: '3600', value: String(it.duration_seconds), 'aria-label': `Czas w sekundach: ${it.name}`, disabled: !S.canWrite });
      const save = async () => {
        const r = await guard(api.patch(`/stim/plan/${it.plan_id}`, { duration_seconds: Number(secs.value) }), null);
        if (r) toast('Czas zapisany.', 'success');
      };
      card.append(h('div', { class: 'stim-row' },
        h('div', {}, h('strong', { text: `${i + 1}. ${it.name}` }), h('div', { class: 'stim-sub', text: `${fmtSecs(it.duration_seconds)} · ${it.instructions}` })),
        S.canWrite ? h('div', { class: 'tools' },
          secs, h('span', { class: 'stim-sub', text: 's' }),
          btn('Zapisz', save),
          btn('↑', async () => { await guard(api.patch(`/stim/plan/${it.plan_id}`, { move: 'up' }), null); draw(); }),
          btn('↓', async () => { await guard(api.patch(`/stim/plan/${it.plan_id}`, { move: 'down' }), null); draw(); }),
          btn('Usuń', async () => { await guard(api.delete(`/stim/plan/${it.plan_id}`), null); draw(); }, 'danger')) : null));
    });
    box.append(card);
    if (S.canWrite) {
      const sel = h('select', { id: 'stim-add-ex' }, ...S.exercises.filter((e) => e.active).map((e) => h('option', { value: String(e.id), text: `${e.name} (${fmtSecs(e.default_seconds)})` })));
      box.append(h('div', { class: 'stim-card' },
        h('div', { class: 'stim-field' }, h('label', { for: 'stim-add-ex', text: 'Dodaj ćwiczenie do planu' }), sel),
        btn('Dodaj do planu', async () => {
          const r = await guard(api.post(`/stim/children/${c.id}/plan`, { exercise_id: Number(sel.value) }), null);
          if (r) draw();
        }, 'primary')));
    }
    box.append(btn('← Wróć do dzieci', () => go('home')));
  }

  // ---------- Biblioteka
  async function drawLibrary() {
    const box = h('div', { class: 'stim' });
    root.append(box);
    const res = await guard(api.get('/stim/exercises'), null);
    if (!alive()) return;
    const items = res?.data ?? [];
    box.replaceChildren(h('h2', { text: 'Biblioteka ćwiczeń' }));
    for (const e of items) box.append(exerciseCard(e));
    if (S.canWrite) box.append(exerciseCard({ id: null, name: '', instructions: '', tip: '', default_seconds: 60, active: 1 }));
  }

  function exerciseCard(e) {
    const name = h('input', { type: 'text', maxlength: '120', value: e.name, disabled: !S.canWrite, id: `ex-n-${e.id ?? 'new'}` });
    const ins = h('textarea', { rows: '3', maxlength: '2000', disabled: !S.canWrite, id: `ex-i-${e.id ?? 'new'}` });
    ins.value = e.instructions;
    const tip = h('input', { type: 'text', maxlength: '500', value: e.tip || '', disabled: !S.canWrite, id: `ex-t-${e.id ?? 'new'}` });
    const secs = h('input', { type: 'number', min: '5', max: '3600', value: String(e.default_seconds), disabled: !S.canWrite, id: `ex-s-${e.id ?? 'new'}` });
    const body = () => ({ name: name.value, instructions: ins.value, tip: tip.value, default_seconds: Number(secs.value) });
    return h('div', { class: 'stim-card' },
      h('div', { class: 'stim-field' }, h('label', { for: name.id, text: e.id ? 'Nazwa' : 'Nowe ćwiczenie: nazwa' }), name),
      h('div', { class: 'stim-field' }, h('label', { for: ins.id, text: 'Instrukcja' }), ins),
      h('div', { class: 'stim-field' }, h('label', { for: tip.id, text: 'Wskazówka' }), tip),
      h('div', { class: 'stim-field' }, h('label', { for: secs.id, text: 'Domyślny czas (sekundy)' }), secs),
      S.canWrite ? h('div', { class: 'stim-actions' },
        btn(e.id ? 'Zapisz' : 'Dodaj ćwiczenie', async () => {
          const r = await guard(e.id ? api.patch(`/stim/exercises/${e.id}`, { ...body(), active: e.active }) : api.post('/stim/exercises', body()), null);
          if (r) { toast('Zapisane.', 'success'); draw(); }
        }, 'primary'),
        e.id ? btn(e.active ? 'Ukryj w bibliotece' : 'Przywróć', async () => {
          const r = await guard(api.patch(`/stim/exercises/${e.id}`, { ...body(), active: !e.active }), null);
          if (r) draw();
        }) : null) : null);
  }

  // ---------- Historia
  async function drawHistory() {
    const c = S.child;
    const box = h('div', { class: 'stim' });
    root.append(box);
    const res = await guard(api.get(`/stim/sessions${c ? `?child_id=${c.id}` : ''}`), null);
    if (!alive()) return;
    const rows = res?.data ?? [];
    box.replaceChildren(h('h2', { text: c ? `Historia: ${c.name}` : 'Historia sesji' }));
    if (c) box.append(btn('Pokaż wszystkie dzieci', () => go('history', { child: null })));
    if (!rows.length) box.append(h('div', { class: 'stim-empty', text: 'Brak ukończonych sesji.' }));
    for (const s of rows) {
      const card = h('div', { class: 'stim-card' },
        h('div', { class: 'stim-child-head' },
          h('span', { class: 'stim-name', text: `${fmtDate(s.session_date)} · sesja ${SLOT_NAME[s.slot]}` }),
          h('span', { class: 'stim-sub', text: `${s.child_name}${s.by_name ? ` · ${s.by_name}` : ''} · średnio ${s.avg_engagement}%` })));
      for (const l of s.logs) {
        const note = h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Notatka…', 'aria-label': `Notatka: ${l.exercise_name}`, disabled: !S.canWrite });
        note.value = l.note || '';
        card.append(h('div', { class: 'stim-log' },
          h('div', {}, h('strong', { text: l.exercise_name }), h('span', { class: 'stim-sub', text: ` · zaangażowanie ${l.engagement}%` })),
          note,
          S.canWrite ? btn('Zapisz notatkę', async () => {
            const r = await guard(api.patch(`/stim/logs/${l.id}`, { note: note.value }), null);
            if (r) toast('Notatka zapisana.', 'success');
          }) : null));
      }
      box.append(card);
    }
  }

  // ---------- Sesja
  async function startSession(c, slot) {
    const res = await guard(api.get(`/stim/children/${c.id}/plan`), null);
    const items = res?.data ?? [];
    if (!items.length) { toast('Ten plan jest pusty.', 'danger'); return; }
    S.session = { child: c, slot, items, idx: 0, phase: 'ready', logs: [], engagement: 50 };
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ekran może zgasnąć */ }
    go('session');
  }

  function drawSession() {
    const s = S.session;
    if (!s) return go('home');
    const it = s.items[s.idx];
    const last = s.idx === s.items.length - 1;
    const top = h('div', { style: 'width:100%' },
      h('div', { class: 'stim-sub', text: `${s.child.name} · sesja ${SLOT_NAME[s.slot]} · ćwiczenie ${s.idx + 1} z ${s.items.length}` }),
      h('div', { class: 'stim-progress' }, h('i', { style: `width:${((s.idx + (s.phase === 'rate' ? 0.5 : 0)) / s.items.length) * 100}%` })));
    const wrap = h('div', { class: 'stim-session' }, top);
    root.append(wrap);

    if (s.phase === 'ready' || s.phase === 'run') {
      wrap.append(h('div', { class: 'stim-ex-title', text: it.name }),
        h('div', { class: 'stim-card stim-ex-box' },
          h('p', { text: it.instructions }),
          it.tip ? h('div', { class: 'stim-tip', text: `💡 ${it.tip}` }) : null));
      if (s.phase === 'ready') {
        wrap.append(h('button', { type: 'button', class: 'stim-start', text: 'START', 'aria-label': 'Start', onclick: () => { ctx(); s.phase = 'run'; draw(); } }),
          btn('Przerwij sesję', () => go('home')));
      } else {
        runTimer(wrap, it, () => { s.phase = 'rate'; s.engagement = 50; draw(); });
      }
    } else {
      const val = h('div', { class: 'stim-eng', text: '50%' });
      const slider = h('input', { type: 'range', class: 'stim-slider', min: '0', max: '100', step: '5', value: String(s.engagement), 'aria-label': 'Zaangażowanie dziecka w procentach' });
      slider.addEventListener('input', () => { s.engagement = Number(slider.value); val.textContent = `${s.engagement}%`; });
      val.textContent = `${s.engagement}%`;
      const msg = h('div', { class: 'stim-msg err', hidden: true });
      const next = btn(last ? '✅ Zakończ sesję' : '➡ Następne ćwiczenie', async () => {
        s.logs.push({ exercise_id: it.exercise_id, exercise_name: it.name, engagement: s.engagement, note: '' });
        if (!last) { s.idx += 1; s.phase = 'ready'; draw(); return; }
        next.disabled = true;
        try {
          await api.post(`/stim/children/${s.child.id}/sessions`, { slot: s.slot, logs: s.logs });
          toast('Sesja zapisana.', 'success');
          S.session = null;
          go('home');
        } catch (e) {
          next.disabled = false;
          s.logs.pop();
          msg.textContent = errText(e);
          msg.hidden = false;
        }
      }, 'primary');
      wrap.append(h('h2', { text: 'Jak poszło?' }), h('div', { class: 'stim-sub', text: it.name }),
        h('div', { class: 'stim-card', style: 'width:100%' }, val, slider,
          h('div', { class: 'stim-sub', text: '0% — brak zaangażowania, 100% — pełne zaangażowanie. Notatki dopiszesz później w Historii.' })),
        msg, next);
    }
  }

  /** Odliczanie oparte na znacznikach czasu (nie dryfuje), z pauzą, sygnałem co N sekund i dźwiękiem na koniec. */
  function runTimer(wrap, it, onDone) {
    const total = it.duration_seconds;
    const interval = intervalFrom(it.instructions, total);
    const R = 45, C = 2 * Math.PI * R;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'stim-ring');
    svg.setAttribute('aria-hidden', 'true');
    const mk = (cls) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', String(R)); c.setAttribute('class', cls);
      return c;
    };
    const fg = mk('fg');
    fg.setAttribute('stroke-dasharray', String(C));
    fg.setAttribute('transform', 'rotate(-90 50 50)');
    svg.append(mk('bg'), fg);
    const clock = h('div', { class: 'stim-clock', role: 'timer', 'aria-live': 'off' });
    const pauseBtn = btn('Pauza', () => toggle());
    wrap.append(svg, clock, pauseBtn, h('div', { class: 'stim-sub', text: 'Timer musi się skończyć — ćwiczenie wymaga pełnego czasu.' }));

    let endAt = Date.now() + total * 1000;
    let left = total, running = true, fired = false, lastChime = 0;
    function toggle() {
      ctx();
      if (running) { left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000)); running = false; pauseBtn.textContent = 'Wznów'; }
      else { endAt = Date.now() + left * 1000; running = true; pauseBtn.textContent = 'Pauza'; }
    }
    const tick = () => {
      if (!alive()) return;
      const ms = running ? endAt - Date.now() : left * 1000;
      const sec = Math.max(0, Math.ceil(ms / 1000));
      clock.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      fg.setAttribute('stroke-dashoffset', String(C * (1 - (total - sec) / total)));
      if (running && interval && ms > 1000) {
        const elapsed = total - sec;
        const crossed = Math.floor(elapsed / interval);
        if (elapsed > 0 && crossed > lastChime && elapsed % interval <= 1) { lastChime = crossed; playTick(); }
      }
      if (running && ms <= 0 && !fired) { fired = true; playEnd(); clearTimers(); setTimeout(() => { if (alive()) onDone(); }, 300); }
    };
    tick();
    timers.push(setInterval(tick, 250));
  }

  draw();
}
