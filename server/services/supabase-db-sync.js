/**
 * Supabase Storage DB Sync — backup/restore yuvomi.db na Supabase Storage
 * Bucket: "db-backups", plik: "yuvomi.db"
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import * as db from '../db.js';

const log = createLogger('SupabaseSync');

const BUCKET = 'db-backups';
const FILE_NAME = 'yuvomi.db';
const UPLOAD_INTERVAL_MS = 60 * 1000; // 1 minuta

let supabaseUrl = null;
let serviceKey = null;
let dbPath = null;
let syncTimer = null;

function loadConfig() {
  supabaseUrl = process.env.SUPABASE_URL;
  serviceKey = process.env.SUPABASE_SERVICE_KEY;
  dbPath = process.env.DB_PATH || './data/yuvomi.db';
  return !!(supabaseUrl && serviceKey);
}

function storageUrl(path) {
  return `${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
  };
}

async function ensureBucket() {
  // Sprawdź czy bucket istnieje
  const res = await fetch(`${supabaseUrl}/storage/v1/bucket/${BUCKET}`, {
    headers: authHeaders(),
  });
  if (res.ok) return;

  // Utwórz bucket (private)
  const cr = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!cr.ok) {
    const err = await cr.text();
    // Ignoruj jeśli już istnieje (409)
    if (cr.status !== 409) throw new Error(`Bucket create: ${cr.status} ${err}`);
  }
  log.info(`Bucket "${BUCKET}" gotowy`);
}

export async function downloadFromSupabase() {
  if (!loadConfig()) {
    log.info('SUPABASE_URL/SUPABASE_SERVICE_KEY nie ustawione — pomijam sync');
    return false;
  }

  try {
    await ensureBucket();

    const res = await fetch(storageUrl(FILE_NAME), {
      headers: authHeaders(),
    });

    if (res.status === 404 || res.status === 400) {
      log.info('Brak pliku yuvomi.db w Supabase — startujemy od zera');
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const stagingPath = dbPath + '.supa-tmp';
    writeFileSync(stagingPath, buffer);
    log.info(`Pobrano bazę z Supabase (${buffer.length} bajtów) → ${stagingPath}`);
    return stagingPath;
  } catch (e) {
    log.error('Błąd pobierania z Supabase:', e.message);
    return false;
  }
}

export async function uploadToSupabase() {
  if (!supabaseUrl || !serviceKey || !dbPath) return;
  if (!existsSync(dbPath)) return;

  // Checkpoint WAL przed odczytem — bez tego nowe dane mogą nie trafić do backupu
  try {
    if (db.isDatabaseOpen()) db.get().pragma('wal_checkpoint(PASSIVE)');
  } catch { /* best effort */ }

  try {
    const content = readFileSync(dbPath);
    const size = content.length;

    // Upsert — Supabase Storage obsługuje PUT jako utwórz-lub-zastąp
    const res = await fetch(storageUrl(FILE_NAME), {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: content,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`PUT ${res.status}: ${err}`);
    }

    log.info(`Backup Supabase OK (${size} bajtów)`);
  } catch (e) {
    log.error('Błąd uploadu do Supabase:', e.message);
  }
}

export function startSupabaseSync() {
  if (!loadConfig()) return;

  log.info(`Supabase sync aktywny — backup co ${UPLOAD_INTERVAL_MS / 60000} min`);

  syncTimer = setInterval(() => {
    uploadToSupabase().catch((e) => log.error('Sync interval error:', e.message));
  }, UPLOAD_INTERVAL_MS);

  if (syncTimer.unref) syncTimer.unref();
}

export function stopSupabaseSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
