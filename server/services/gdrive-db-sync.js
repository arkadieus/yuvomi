/**
 * Google Drive DB Sync — backup/restore yuvomi.db na Google Drive
 * Używa Service Account (bez przeglądarki) + Google Drive REST API v3
 * Env: GOOGLE_SERVICE_ACCOUNT_JSON (cała zawartość pliku JSON jako string)
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createLogger } from '../logger.js';
import * as db from '../db.js';

const log = createLogger('GDriveSync');

const DB_FILENAME = 'yuvomi.db';
const FOLDER_NAME = 'yuvomi-backup';
const UPLOAD_INTERVAL_MS = 60 * 1000; // 1 minuta
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let serviceAccount = null;
let dbPath = null;
let syncTimer = null;
let folderId = null;
let fileId = null;

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.error('Nie można sparsować GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    return null;
  }
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  // Tworzymy JWT ręcznie (bez zewnętrznych bibliotek)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigInput = `${header}.${body}`;

  const { createSign } = await import('node:crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(sigInput);
  const sig = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${sigInput}.${sig}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findOrCreateFolder(token) {
  // Szukaj folderu
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.files?.length > 0) return data.files[0].id;

  // Utwórz folder
  const cr = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const folder = await cr.json();
  log.info(`Utworzono folder Drive: ${folder.id}`);
  return folder.id;
}

async function findDbFile(token, fId) {
  const q = encodeURIComponent(`name='${DB_FILENAME}' and '${fId}' in parents and trashed=false`);
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,size)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

export async function downloadFromDrive() {
  serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    log.info('GOOGLE_SERVICE_ACCOUNT_JSON nie ustawiony — pomijam sync Drive');
    return false;
  }

  const dbP = process.env.DB_PATH || './data/yuvomi.db';
  dbPath = dbP;

  try {
    const token = await getAccessToken();
    folderId = await findOrCreateFolder(token);
    fileId = await findDbFile(token, folderId);

    if (!fileId) {
      log.info('Brak pliku yuvomi.db w Drive — startujemy od zera lub lokalnej bazy');
      return false;
    }

    log.info(`Pobieranie bazy z Drive (file: ${fileId})...`);
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    // Zapisujemy do pliku tymczasowego — nie nadpisujemy żywego pliku SQLite,
    // który serwer już otworzył. Caller zamknie SQLite i atomicznie podmieni plik.
    const stagingPath = dbP + '.drive-tmp';
    writeFileSync(stagingPath, buffer);
    log.info(`Pobrano bazę z Drive (${buffer.length} bajtów) → ${stagingPath}`);
    return stagingPath;
  } catch (e) {
    log.error('Błąd pobierania z Drive:', e.message);
    return false;
  }
}

export async function uploadToDrive() {
  if (!serviceAccount || !dbPath) return;
  if (!existsSync(dbPath)) return;

  // Checkpoint WAL przed odczytem pliku — bez tego WAL nie jest scalony
  // z głównym plikiem .db i uploadujemy niekompletny backup (bez nowych danych).
  try {
    if (db.isDatabaseOpen()) db.get().pragma('wal_checkpoint(PASSIVE)');
  } catch { /* best effort */ }

  try {
    const token = await getAccessToken();
    if (!folderId) folderId = await findOrCreateFolder(token);
    if (!fileId) fileId = await findDbFile(token, folderId);

    const content = readFileSync(dbPath);
    const size = content.length;

    if (fileId) {
      // Aktualizuj istniejący plik
      const res = await fetch(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        body: content,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`PATCH ${res.status}: ${err}`);
      }
    } else {
      // Utwórz nowy plik (multipart)
      const boundary = 'boundary_yuvomi_db';
      const meta = JSON.stringify({ name: DB_FILENAME, parents: [folderId] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.from(meta),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
        },
        body,
      });
      const created = await res.json();
      if (!created.id) throw new Error(`Create failed: ${JSON.stringify(created)}`);
      fileId = created.id;
      log.info(`Plik utworzony w Drive: ${fileId}`);
    }
    log.info(`Backup Drive OK (${size} bajtów)`);
  } catch (e) {
    log.error('Błąd uploadu do Drive:', e.message);
  }
}

export function startDriveSync() {
  serviceAccount = loadServiceAccount();
  if (!serviceAccount) return;

  dbPath = process.env.DB_PATH || './data/yuvomi.db';
  log.info(`Drive sync aktywny — backup co ${UPLOAD_INTERVAL_MS / 60000} min`);

  syncTimer = setInterval(() => {
    uploadToDrive().catch((e) => log.error('Sync interval error:', e.message));
  }, UPLOAD_INTERVAL_MS);

  if (syncTimer.unref) syncTimer.unref();
}

export function stopDriveSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
