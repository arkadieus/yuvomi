/**
 * Modul: Program stymulacyjny (moduł „Masaż / ćwiczenia z dzieckiem")
 * Zweck: dzieci, biblioteka ćwiczeń, plany, codzienne sesje (rano/wieczór), oceny i notatki.
 * Abhängigkeiten: express, server/db.js, server/permissions.js
 *
 * Dostęp: klucz uprawnień `ext:stim` (moduł dodatkowy z modules/stim). Czytanie wymaga
 * co najmniej „odczyt", każda zmiana „zapis". Tokeny API z zakresami nie mają tu dostępu.
 * Dane dzieci to dane o zdrowiu — nie ma żadnych publicznych ani udostępnianych ścieżek.
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { moduleAccessVerdict, MODULE_ACCESS_ALLOW, MODULE_ACCESS_DENIED } from '../permissions.js';
import { todayKey } from '../utils/timezone.js';

const log = createLogger('Stim');
const router = express.Router();
const KEY = 'ext:stim';
const SLOTS = ['morning', 'evening'];

const me = (req) => req.authUserId || req.session?.userId || null;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg, code });
const toInt = (v) => {
  const n = Number.parseInt(String(v), 10);
  return Number.isInteger(n) ? n : null;
};
const clampText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Jedna brama dostępu dla całego routera.
router.use((req, res, next) => {
  if (req.authScopes != null) return bad(res, 'API tokens cannot access this module.', 403);
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const verdict = moduleAccessVerdict(req.sessionModuleAccess, KEY, write ? 'write' : 'read');
  if (verdict === MODULE_ACCESS_DENIED) {
    return res.status(403).json({ error: 'You do not have access to this module.', code: 403, reason: 'module_access_denied' });
  }
  if (verdict !== MODULE_ACCESS_ALLOW) {
    return res.status(403).json({ error: 'You have read-only access to this module.', code: 403, reason: 'module_read_only' });
  }
  return next();
});

const childExists = (id) => !!db.get().prepare('SELECT 1 FROM stim_children WHERE id = ?').get(id);

// --------------------------------------------------------
// Dzieci
// --------------------------------------------------------
router.get('/children', (_req, res) => {
  const date = todayKey(db.get());
  const children = db.get().prepare(`
    SELECT c.id, c.name, c.birth_date,
      (SELECT COUNT(*) FROM stim_plan p WHERE p.child_id = c.id) AS plan_count
    FROM stim_children c ORDER BY c.name COLLATE NOCASE
  `).all();
  const todays = db.get().prepare(`
    SELECT s.child_id, s.slot, s.avg_engagement, u.display_name AS by_name
    FROM stim_sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.session_date = ?
  `).all(date);
  for (const c of children) {
    for (const slot of SLOTS) {
      const s = todays.find((x) => x.child_id === c.id && x.slot === slot);
      c[slot] = s ? { done: true, avg_engagement: s.avg_engagement, by_name: s.by_name } : { done: false };
    }
  }
  res.json({ data: children, date });
});

router.post('/children', (req, res) => {
  const name = clampText(req.body?.name, 100);
  if (!name) return bad(res, 'Podaj imię dziecka.');
  const birth = clampText(req.body?.birth_date, 10) || null;
  if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return bad(res, 'Data urodzenia ma format RRRR-MM-DD.');
  const info = db.get().prepare('INSERT INTO stim_children (name, birth_date, created_by) VALUES (?, ?, ?)')
    .run(name, birth, me(req));
  res.status(201).json({ data: { id: Number(info.lastInsertRowid), name, birth_date: birth } });
});

router.patch('/children/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!id || !childExists(id)) return bad(res, 'Nie znaleziono dziecka.', 404);
  const name = clampText(req.body?.name, 100);
  if (!name) return bad(res, 'Podaj imię dziecka.');
  const birth = clampText(req.body?.birth_date, 10) || null;
  if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return bad(res, 'Data urodzenia ma format RRRR-MM-DD.');
  db.get().prepare('UPDATE stim_children SET name = ?, birth_date = ? WHERE id = ?').run(name, birth, id);
  res.json({ data: { id, name, birth_date: birth } });
});

router.delete('/children/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!id || !childExists(id)) return bad(res, 'Nie znaleziono dziecka.', 404);
  db.get().prepare('DELETE FROM stim_children WHERE id = ?').run(id); // plan, sesje i oceny: CASCADE
  res.json({ ok: true });
});

// --------------------------------------------------------
// Biblioteka ćwiczeń
// --------------------------------------------------------
router.get('/exercises', (_req, res) => {
  const rows = db.get().prepare(
    'SELECT id, name, instructions, tip, default_seconds, active FROM stim_exercises ORDER BY sort_order, id'
  ).all();
  res.json({ data: rows });
});

function exerciseFields(body) {
  const name = clampText(body?.name, 120);
  if (!name) return { error: 'Podaj nazwę ćwiczenia.' };
  const seconds = toInt(body?.default_seconds);
  if (seconds === null || seconds < 5 || seconds > 3600) return { error: 'Czas ćwiczenia: od 5 do 3600 sekund.' };
  return {
    name,
    instructions: clampText(body?.instructions, 2000),
    tip: clampText(body?.tip, 500) || null,
    seconds,
  };
}

router.post('/exercises', (req, res) => {
  const f = exerciseFields(req.body);
  if (f.error) return bad(res, f.error);
  const last = db.get().prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM stim_exercises').get().n;
  const info = db.get().prepare(
    'INSERT INTO stim_exercises (name, instructions, tip, default_seconds, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(f.name, f.instructions, f.tip, f.seconds, last + 1);
  res.status(201).json({ data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/exercises/:id', (req, res) => {
  const id = toInt(req.params.id);
  const cur = id && db.get().prepare('SELECT id FROM stim_exercises WHERE id = ?').get(id);
  if (!cur) return bad(res, 'Nie znaleziono ćwiczenia.', 404);
  const f = exerciseFields(req.body);
  if (f.error) return bad(res, f.error);
  const active = req.body?.active === false || req.body?.active === 0 ? 0 : 1;
  db.get().prepare(
    'UPDATE stim_exercises SET name = ?, instructions = ?, tip = ?, default_seconds = ?, active = ? WHERE id = ?'
  ).run(f.name, f.instructions, f.tip, f.seconds, active, id);
  res.json({ ok: true });
});

// --------------------------------------------------------
// Plan dziecka
// --------------------------------------------------------
function loadPlan(childId) {
  return db.get().prepare(`
    SELECT p.id AS plan_id, p.exercise_id, p.duration_seconds, p.sort_order,
           e.name, e.instructions, e.tip
    FROM stim_plan p JOIN stim_exercises e ON e.id = p.exercise_id
    WHERE p.child_id = ? ORDER BY p.sort_order, p.id
  `).all(childId);
}

router.get('/children/:id/plan', (req, res) => {
  const id = toInt(req.params.id);
  if (!id || !childExists(id)) return bad(res, 'Nie znaleziono dziecka.', 404);
  res.json({ data: loadPlan(id) });
});

router.post('/children/:id/plan', (req, res) => {
  const id = toInt(req.params.id);
  if (!id || !childExists(id)) return bad(res, 'Nie znaleziono dziecka.', 404);
  const exerciseId = toInt(req.body?.exercise_id);
  const ex = exerciseId && db.get().prepare('SELECT default_seconds FROM stim_exercises WHERE id = ?').get(exerciseId);
  if (!ex) return bad(res, 'Wybierz ćwiczenie z biblioteki.');
  const seconds = toInt(req.body?.duration_seconds) ?? ex.default_seconds;
  if (seconds < 5 || seconds > 3600) return bad(res, 'Czas ćwiczenia: od 5 do 3600 sekund.');
  const last = db.get().prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM stim_plan WHERE child_id = ?').get(id).n;
  const info = db.get().prepare(
    'INSERT INTO stim_plan (child_id, exercise_id, duration_seconds, sort_order) VALUES (?, ?, ?, ?)'
  ).run(id, exerciseId, seconds, last + 1);
  res.status(201).json({ data: { plan_id: Number(info.lastInsertRowid) } });
});

router.patch('/plan/:planId', (req, res) => {
  const planId = toInt(req.params.planId);
  const row = planId && db.get().prepare('SELECT id, child_id, sort_order FROM stim_plan WHERE id = ?').get(planId);
  if (!row) return bad(res, 'Nie znaleziono pozycji planu.', 404);
  if (req.body?.duration_seconds !== undefined) {
    const seconds = toInt(req.body.duration_seconds);
    if (seconds === null || seconds < 5 || seconds > 3600) return bad(res, 'Czas ćwiczenia: od 5 do 3600 sekund.');
    db.get().prepare('UPDATE stim_plan SET duration_seconds = ? WHERE id = ?').run(seconds, planId);
  }
  // move: 'up' | 'down' — zamiana miejscami z sąsiadem
  if (req.body?.move === 'up' || req.body?.move === 'down') {
    const items = db.get().prepare('SELECT id FROM stim_plan WHERE child_id = ? ORDER BY sort_order, id').all(row.child_id);
    const i = items.findIndex((x) => x.id === planId);
    const j = req.body.move === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < items.length) {
      [items[i], items[j]] = [items[j], items[i]];
      const upd = db.get().prepare('UPDATE stim_plan SET sort_order = ? WHERE id = ?');
      db.get().transaction(() => items.forEach((it, idx) => upd.run(idx + 1, it.id)))();
    }
  }
  res.json({ ok: true });
});

router.delete('/plan/:planId', (req, res) => {
  const planId = toInt(req.params.planId);
  const info = planId ? db.get().prepare('DELETE FROM stim_plan WHERE id = ?').run(planId) : { changes: 0 };
  if (!info.changes) return bad(res, 'Nie znaleziono pozycji planu.', 404);
  res.json({ ok: true });
});

// --------------------------------------------------------
// Sesje
// --------------------------------------------------------
router.post('/children/:id/sessions', (req, res) => {
  try {
    const childId = toInt(req.params.id);
    if (!childId || !childExists(childId)) return bad(res, 'Nie znaleziono dziecka.', 404);
    const slot = req.body?.slot;
    if (!SLOTS.includes(slot)) return bad(res, 'Nieprawidłowa pora sesji.');
    const logs = Array.isArray(req.body?.logs) ? req.body.logs : [];
    if (!logs.length) return bad(res, 'Brak ocen ćwiczeń.');
    const clean = [];
    for (const l of logs.slice(0, 50)) {
      const eng = toInt(l?.engagement);
      if (eng === null || eng < 0 || eng > 100) return bad(res, 'Ocena zaangażowania: od 0 do 100.');
      const name = clampText(l?.exercise_name, 200);
      if (!name) return bad(res, 'Brak nazwy ćwiczenia.');
      clean.push({
        exercise_id: toInt(l?.exercise_id),
        exercise_name: name,
        engagement: eng,
        note: clampText(l?.note, 1000) || null,
      });
    }
    const avg = Math.round(clean.reduce((s, l) => s + l.engagement, 0) / clean.length);
    const date = todayKey(db.get());
    const d = db.get();
    let sessionId;
    try {
      d.transaction(() => {
        const info = d.prepare(
          'INSERT INTO stim_sessions (child_id, user_id, session_date, slot, avg_engagement) VALUES (?, ?, ?, ?, ?)'
        ).run(childId, me(req), date, slot, avg);
        sessionId = Number(info.lastInsertRowid);
        const ins = d.prepare(
          'INSERT INTO stim_session_logs (session_id, exercise_id, exercise_name, engagement, note) VALUES (?, ?, ?, ?, ?)'
        );
        for (const l of clean) ins.run(sessionId, l.exercise_id, l.exercise_name, l.engagement, l.note);
      })();
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return bad(res, slot === 'evening' ? 'Wieczorna sesja została już dziś ukończona.'
          : 'Poranna sesja została już dziś ukończona.', 409);
      }
      throw e;
    }
    res.status(201).json({ data: { id: sessionId, avg_engagement: avg } });
  } catch (err) {
    log.error('POST /children/:id/sessions', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/sessions', (req, res) => {
  const childId = toInt(req.query.child_id);
  const limit = Math.min(Math.max(toInt(req.query.limit) ?? 60, 1), 200);
  const rows = db.get().prepare(`
    SELECT s.id, s.child_id, c.name AS child_name, s.session_date, s.slot, s.avg_engagement,
           s.completed_at, u.display_name AS by_name
    FROM stim_sessions s
    JOIN stim_children c ON c.id = s.child_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE (? IS NULL OR s.child_id = ?)
    ORDER BY s.session_date DESC, s.completed_at DESC LIMIT ?
  `).all(childId, childId, limit);
  const ids = rows.map((r) => r.id);
  const logs = ids.length
    ? db.get().prepare(
      `SELECT id, session_id, exercise_name, engagement, note FROM stim_session_logs
       WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    ).all(...ids)
    : [];
  for (const r of rows) r.logs = logs.filter((l) => l.session_id === r.id);
  res.json({ data: rows });
});

router.patch('/logs/:id', (req, res) => {
  const id = toInt(req.params.id);
  const info = id
    ? db.get().prepare('UPDATE stim_session_logs SET note = ? WHERE id = ?')
      .run(clampText(req.body?.note, 2000) || null, id)
    : { changes: 0 };
  if (!info.changes) return bad(res, 'Nie znaleziono wpisu.', 404);
  res.json({ ok: true });
});

export default router;
