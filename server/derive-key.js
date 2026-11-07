// Wypisuje stały klucz szyfrowania bazy wyliczony z klucza Supabase (nic, gdy go brak).
// Na Render Free folder /data znika przy restarcie, więc klucz generowany losowo ginął razem z nim
// i backup z Supabase stawał się nieczytelny.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

let key = process.env.SUPABASE_SERVICE_KEY;
if (!key && process.env.SUPABASE_SERVICE_KEY_FILE) {
  try { key = readFileSync(process.env.SUPABASE_SERVICE_KEY_FILE, 'utf8').trim(); } catch { /* brak pliku */ }
}
if (key) process.stdout.write(createHmac('sha256', key).update('yuvomi-db-encryption-v1').digest('hex'));
