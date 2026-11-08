/**
 * Pre-startup DB restore from Supabase.
 * Run this BEFORE server/index.js so db.init() opens the correct file.
 * Always exits 0 — a restore failure means "start fresh", never "abort".
 */

import { writeFileSync, renameSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const DB_PATH = process.env.DB_PATH || '/data/yuvomi.db';
const BUCKET = 'db-backups';
const FILE_NAME = 'yuvomi.db';

function log(msg) { console.log(`[restore-db] ${msg}`); }

function resolveServiceKey() {
  const direct = process.env.SUPABASE_SERVICE_KEY;
  if (direct) return direct;
  const fromFile = process.env.SUPABASE_SERVICE_KEY_FILE;
  if (fromFile) {
    try { return readFileSync(fromFile, 'utf8').trim(); } catch {}
  }
  return null;
}

function resolveEncKey() {
  const direct = process.env.DB_ENCRYPTION_KEY;
  if (direct) return direct;
  const fromFile = process.env.DB_ENCRYPTION_KEY_FILE;
  if (fromFile) {
    try { return readFileSync(fromFile, 'utf8').trim(); } catch {}
  }
  // Try stored secrets file (same logic as auto-secrets.js)
  try {
    const secretsFile = `${dirname(DB_PATH)}/.secrets/DB_ENCRYPTION_KEY`;
    return readFileSync(secretsFile, 'utf8').trim();
  } catch {}
  return null;
}

const SERVICE_KEY = resolveServiceKey();

if (!SUPABASE_URL || !SERVICE_KEY) {
  log('SUPABASE_URL/SUPABASE_SERVICE_KEY not set — skipping restore');
  process.exit(0);
}

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });

  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FILE_NAME}`;
  log('Downloading backup from Supabase...');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
  });

  if (res.status === 404 || res.status === 400) {
    log('No backup in Supabase — starting fresh');
    process.exit(0);
  }
  if (!res.ok) {
    log(`HTTP ${res.status} from Supabase — starting fresh`);
    process.exit(0);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const staging = DB_PATH + '.restore-tmp';
  writeFileSync(staging, buffer);
  log(`Downloaded ${buffer.length} bytes — validating encryption key...`);

  // Validate key BEFORE placing the file, so db.init() always gets a valid file.
  try {
    const { default: Database } = await import('better-sqlite3-multiple-ciphers');
    const encKey = resolveEncKey();
    const testDb = new Database(staging);
    if (encKey) {
      // Dokładnie tak jak server/db.js (applyKeyBytes): cipher sqlcipher + klucz jako hex bajtów UTF-8.
      testDb.pragma("cipher = 'sqlcipher'");
      testDb.pragma(`key="x'${Buffer.from(encKey, 'utf8').toString('hex')}'"`);
    }
    testDb.prepare('SELECT count(*) FROM sqlite_master').get(); // rzuca "file is not a database" przy złym kluczu
    testDb.close();

    renameSync(staging, DB_PATH);
    log(`Restore OK (${buffer.length} bytes) → ${DB_PATH}`);
  } catch (keyErr) {
    log(`Key validation failed: ${keyErr.message} — discarding backup, starting fresh`);
    try { unlinkSync(staging); } catch { /* ignore */ }
    // Nie tracimy nieczytelnego backupu: kolejny upload nadpisze yuvomi.db, więc zachowujemy kopię.
    try {
      const keepName = `${FILE_NAME}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${keepName}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        body: buffer,
      });
      log(up.ok ? `Saved unreadable backup as ${keepName}` : `Could not save unreadable backup (HTTP ${up.status})`);
    } catch (e) { log(`Could not save unreadable backup: ${e.message}`); }
  }

  process.exit(0);
} catch (e) {
  log(`Unexpected error: ${e.message} — starting fresh`);
  process.exit(0);
}
