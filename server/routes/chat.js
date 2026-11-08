/**
 * Modul: Czat rodzinny (tylko tekst, bez załączników)
 * Zweck: wiadomości grupowe (wszyscy domownicy) i prywatne (1:1) + licznik nieprzeczytanych.
 * Abhängigkeiten: express, server/db.js, server/services/push.js
 *
 * Nie jest modułem uprawnień: każdy zalogowany domownik widzi czat. Wątek to `group`
 * albo identyfikator użytkownika (rozmowa prywatna).
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { pushService } from '../services/push.js';

const log = createLogger('Chat');
const router = express.Router();

const MAX_BODY = 2000;
const PAGE = 100;

const actingUser = (req) => req.authUserId || req.session?.userId || null;

/** 'group' | id użytkownika (≠ ja, istnieje) → { kind, peerId } albo null */
function parseThread(raw, meId) {
  if (raw === 'group') return { kind: 'group', peerId: null };
  const id = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(id) || id <= 0 || id === meId) return null;
  const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(id);
  return exists ? { kind: 'direct', peerId: id } : null;
}

const threadKey = (t) => (t.kind === 'group' ? 'group' : `u${t.peerId}`);

function markRead(meId, key, lastId) {
  db.get().prepare(`
    INSERT INTO chat_reads (user_id, thread, last_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, thread) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)
  `).run(meId, key, lastId);
}

router.get('/members', (req, res) => {
  const me = actingUser(req);
  const rows = db.get()
    .prepare('SELECT id, display_name, avatar_color FROM users WHERE id != ? ORDER BY display_name COLLATE NOCASE')
    .all(me);
  res.json({ data: rows });
});

router.get('/summary', (req, res) => {
  const me = actingUser(req);
  const d = db.get();
  const group = d.prepare(`
    SELECT COUNT(*) AS n FROM chat_messages m
    WHERE m.recipient_id IS NULL AND m.user_id != ?
      AND m.id > COALESCE((SELECT last_id FROM chat_reads WHERE user_id = ? AND thread = 'group'), 0)
  `).get(me, me).n;
  const direct = d.prepare(`
    SELECT m.user_id AS sender, COUNT(*) AS n FROM chat_messages m
    LEFT JOIN chat_reads r ON r.user_id = ? AND r.thread = 'u' || m.user_id
    WHERE m.recipient_id = ? AND m.id > COALESCE(r.last_id, 0)
    GROUP BY m.user_id
  `).all(me, me);
  const unread = { group };
  let total = group;
  for (const row of direct) { unread[`u${row.sender}`] = row.n; total += row.n; }
  res.json({ data: { unread, total } });
});

router.get('/messages', (req, res) => {
  const me = actingUser(req);
  const thread = parseThread(req.query.thread, me);
  if (!thread) return res.status(400).json({ error: 'Nieprawidłowa rozmowa.', code: 400 });
  const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
  const d = db.get();

  const rows = thread.kind === 'group'
    ? d.prepare(`
        SELECT m.id, m.user_id, u.display_name AS author, u.avatar_color, m.body, m.created_at
        FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.recipient_id IS NULL AND m.id > ?
        ORDER BY m.id DESC LIMIT ?`).all(after, PAGE)
    : d.prepare(`
        SELECT m.id, m.user_id, u.display_name AS author, u.avatar_color, m.body, m.created_at
        FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE ((m.user_id = ? AND m.recipient_id = ?) OR (m.user_id = ? AND m.recipient_id = ?)) AND m.id > ?
        ORDER BY m.id DESC LIMIT ?`).all(me, thread.peerId, thread.peerId, me, after, PAGE);

  rows.reverse();
  if (rows.length) markRead(me, threadKey(thread), rows[rows.length - 1].id);
  res.json({ data: rows, me });
});

router.post('/messages', (req, res) => {
  const me = actingUser(req);
  const thread = parseThread(req.body?.thread, me);
  if (!thread) return res.status(400).json({ error: 'Nieprawidłowa rozmowa.', code: 400 });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Wiadomość jest pusta.', code: 400 });
  if (body.length > MAX_BODY) {
    return res.status(400).json({ error: `Wiadomość może mieć najwyżej ${MAX_BODY} znaków.`, code: 400 });
  }

  const d = db.get();
  const info = d.prepare('INSERT INTO chat_messages (user_id, recipient_id, body) VALUES (?, ?, ?)')
    .run(me, thread.peerId, body);
  const id = Number(info.lastInsertRowid);
  markRead(me, threadKey(thread), id);

  const row = d.prepare(`
    SELECT m.id, m.user_id, u.display_name AS author, u.avatar_color, m.body, m.created_at
    FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(id);

  // Powiadomienia push do adresatów — nie blokują odpowiedzi, błąd nie psuje wysyłki.
  const recipients = thread.kind === 'group'
    ? d.prepare('SELECT id FROM users WHERE id != ?').all(me).map((r) => r.id)
    : [thread.peerId];
  const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  const title = thread.kind === 'group' ? `${row.author} · Rodzina` : row.author;
  for (const uid of recipients) {
    Promise.resolve()
      .then(() => pushService.sendPushToUser(uid, { title, body: preview, url: '/?chat=1', tag: `chat-${threadKey(thread)}` }))
      .catch((e) => log.warn(`push do ${uid}: ${e.message}`));
  }

  res.status(201).json({ data: row });
});

export default router;
