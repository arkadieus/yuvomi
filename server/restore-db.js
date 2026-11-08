/**
 * Pre-startup DB restore from Supabase.
 * Run this BEFORE server/index.js so db.init() opens the correct file.
 * Exits 0 when there is no backup / backup is unreadable (start fresh).
 * Exits 1 when Supabase is unreachable, so an empty DB never overwrites a good backup.
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
  // Błąd przejściowy (sieć tuż po wybudzeniu Rendera, 5xx) NIE może oznaczać „start od zera”:
  // pusta baza zostałaby po minucie wysłana na Supabase i nadpisałaby dobrą kopię (znikają konta).
  // Dlatego ponawiamy, a po wyczerpaniu prób kończymy z błędem (Render zrestartuje kontener).
  let res = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok || res.status === 404 || res.status === 400) break;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    res = null;
    log(`Attempt ${attempt}/8 failed (${lastErr}) — retrying`);
    await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 12000)));
  }

  if (!res) {
    log(`Supabase unreachable (${lastErr}) — refusing to start with empty DB, exiting 1`);
    process.exit(1);
  }
  if (res.status === 404 || res.status === 400) {
    log('No backup in Supabase — starting fresh');
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
  log(`Unexpected error: ${e.message} — refusing to start with empty DB, exiting 1`);
  process.exit(1);
}
