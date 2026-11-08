/**
 * Parser polskich poleceń głosowych: „jutro o 13:30 spotkanie w Rzeszowie”.
 * Czysta funkcja bez dostępu do DOM (testowana w test/test-voice-parse.js).
 */

const L = '\\p{L}\\p{N}';
// \b nie działa z polskimi literami (ś, ą...), dlatego własne granice słów.
const word = (src) => new RegExp(`(?<![${L}])(?:${src})(?![${L}])`, 'iu');
const wordG = (src) => new RegExp(`(?<![${L}])(?:${src})(?![${L}])`, 'giu');

const WEEKDAYS = [
  [1, 'poniedzia[łl]\\p{L}*'], [2, 'wtor\\p{L}*'], [3, '[śs]rod\\p{L}*'], [4, 'czwart\\p{L}*'],
  [5, 'pi[ąa]t\\p{L}*'], [6, 'sobot\\p{L}*'], [0, 'niedziel\\p{L}*'],
];
const MONTHS = [
  'stycz\\p{L}*', 'lut\\p{L}*', 'marc\\p{L}*', 'kwie\\p{L}*', 'maj\\p{L}*', 'czerw\\p{L}*',
  'lip\\p{L}*', 'sierp\\p{L}*', 'wrze\\p{L}*', 'pa[źz]dziernik\\p{L}*', 'listopad\\p{L}*', 'grud\\p{L}*',
];
const HOUR_WORDS = {
  pierwszej: 1, drugiej: 2, trzeciej: 3, czwartej: 4, piątej: 5, szóstej: 6, siódmej: 7, ósmej: 8,
  dziewiątej: 9, dziesiątej: 10, jedenastej: 11, dwunastej: 12, trzynastej: 13, czternastej: 14,
  piętnastej: 15, szesnastej: 16, siedemnastej: 17, osiemnastej: 18, dziewiętnastej: 19,
};

const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ title: string, start: Date, allDay: boolean, hasDate: boolean, hasTime: boolean, remindAtStart: boolean }}
 */
export function parseVoiceCommand(text, now = new Date()) {
  let rest = ` ${String(text).trim()} `;
  const take = (re) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(re, ' ');
    return m;
  };

  let day = null; // Date (północ) albo null
  let hasDate = false;
  let time = null; // { h, m }
  let offsetMs = null; // „za godzinę”

  // --- względne odstępy: za godzinę / za 2 godziny / za 30 minut / za kwadrans / za pół godziny
  let m;
  if ((m = take(word('za\\s+(?:pó[łl]\\s+godzin\\p{L}*)')))) offsetMs = 30 * 60000;
  else if ((m = take(word('za\\s+kwadrans')))) offsetMs = 15 * 60000;
  else if ((m = take(word('za\\s+godzin[ęe]')))) offsetMs = 60 * 60000;
  else if ((m = take(word('za\\s+(\\d+)\\s+(godzin\\p{L}*|minut\\p{L}*)'))))
    offsetMs = Number(m[1]) * (/^godz/i.test(m[2]) ? 60 : 1) * 60000;

  // --- dzień
  if (take(word('pojutrze'))) { day = addDays(startOfDay(now), 2); hasDate = true; }
  else if (take(word('jutro'))) { day = addDays(startOfDay(now), 1); hasDate = true; }
  else if (take(word('dzi[śs]|dzisiaj'))) { day = startOfDay(now); hasDate = true; }
  else if ((m = take(word('za\\s+(\\d+)\\s+(?:dni|dzie[ńn]|tydzie[ńn]|tygodni|tygodnie)')))) {
    const n = Number(m[1]);
    day = addDays(startOfDay(now), /tyg/i.test(m[0]) ? n * 7 : n); hasDate = true;
  } else {
    // „15 listopada”, „15.11”, „15.11.2026”
    const monthRe = word(`(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`);
    const numRe = word('(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?');
    let dd = null; let mm = null; let yy = null;
    if ((m = take(monthRe))) {
      dd = Number(m[1]);
      mm = MONTHS.findIndex((src) => new RegExp(`^(?:${src})$`, 'iu').test(m[2]));
      yy = m[3] ? Number(m[3]) : null;
    } else if ((m = rest.match(numRe))) {
      // „13.30” to godzina, nie data: data tylko z rokiem albo bez „o” tuż przed liczbą i z miesiącem 1-12
      const a = Number(m[1]); const b = Number(m[2]);
      const afterO = /(?<![\p{L}\p{N}])o\s+$/iu.test(rest.slice(0, m.index));
      if (a >= 1 && a <= 31 && b >= 1 && b <= 12 && (m[3] || !afterO)) {
        rest = rest.replace(numRe, ' ');
        dd = a; mm = b - 1; yy = m[3] ? Number(m[3]) : null;
        if (yy !== null && yy < 100) yy += 2000;
      }
    }
    if (dd !== null && mm >= 0) {
      let year = yy ?? now.getFullYear();
      let cand = new Date(year, mm, dd);
      if (yy === null && cand < startOfDay(now)) cand = new Date(year + 1, mm, dd);
      day = cand; hasDate = true;
    } else {
      for (const [dow, src] of WEEKDAYS) {
        if (take(word(src))) {
          const diff = (dow - now.getDay() + 7) % 7 || 7;
          day = addDays(startOfDay(now), diff); hasDate = true;
          break;
        }
      }
    }
  }
  take(word('w\\s+przysz\\p{L}*\\s+tygodniu|w\\s+nast[ęe]pn\\p{L}*\\s+tygodniu')); // szum

  // --- pora dnia
  const evening = !!take(word('wieczor\\p{L}*|po\\s+po[łl]udniu'));
  const morning = !!take(word('rano|z\\s+rana|przed\\s+po[łl]udniem'));
  const noon = !!take(word('w\\s+po[łl]udnie'));
  const midnight = !!take(word('o\\s+p[óo][łl]nocy'));

  // --- godzina
  const hourWordRe = word(`o\\s+(${Object.keys(HOUR_WORDS).join('|')})(?:\\s+(?:pi[ęe]tna[śs]cie|trzydzie[śs]ci|czterdzie[śs]ci|pi[ęe][ćc]dziesi[ąa]t)|\\s+\\d{2})?`);
  if ((m = take(word('o\\s+(?:godzinie|godz\\.?)?\\s*(\\d{1,2})(?:[:.\\s](\\d{2}))?')))) {
    time = { h: Number(m[1]), m: m[2] ? Number(m[2]) : 0 };
  } else if ((m = take(word('(\\d{1,2})[:.](\\d{2})')))) {
    time = { h: Number(m[1]), m: Number(m[2]) };
  } else if ((m = take(word('godzina\\s+(\\d{1,2})(?:[:.](\\d{2}))?')))) {
    time = { h: Number(m[1]), m: m[2] ? Number(m[2]) : 0 };
  } else if ((m = take(word('o\\s+dwudziestej\\s+(pierwszej|drugiej|trzeciej|czwartej)')))) {
    time = { h: { pierwszej: 21, drugiej: 22, trzeciej: 23, czwartej: 24 }[m[1].toLowerCase()] % 24, m: 0 };
  } else if ((m = take(word('o\\s+dwudziestej')))) {
    time = { h: 20, m: 0 };
  } else if ((m = take(hourWordRe))) {
    const h = HOUR_WORDS[m[1].toLowerCase()];
    const tail = m[0].match(/(\d{2})$/);
    time = { h, m: tail ? Number(tail[1]) : 0 };
  } else if (noon) time = { h: 12, m: 0 };
  else if (midnight) time = { h: 0, m: 0 };

  if (time) {
    if (evening && time.h < 12) time.h += 12;
    if (morning && time.h === 12) time.h = 0;
    if (time.h > 23 || time.m > 59) time = null;
  }

  // --- złożenie terminu
  let start; let allDay = false; let hasTime = !!time;
  if (offsetMs !== null) {
    start = new Date(now.getTime() + offsetMs); start.setSeconds(0, 0); hasTime = true; hasDate = true;
  } else if (day && time) {
    start = new Date(day); start.setHours(time.h, time.m, 0, 0);
  } else if (day) {
    start = new Date(day); allDay = true;
  } else if (time) {
    // sama godzina: najbliższe wystąpienie (dziś, a jeśli minęła — jutro)
    start = startOfDay(now); start.setHours(time.h, time.m, 0, 0);
    if (start <= now) start = addDays(start, 1);
  } else {
    // ani daty, ani godziny: dziś, całodniowo
    start = startOfDay(now); allDay = true;
  }

  // --- tytuł: usuń komendy i spójniki, zostaw treść
  const remindAtStart = !!word('przypomnij|przypomnienie|przypominaj|alarm').exec(rest);
  rest = rest
    .replace(wordG('dodaj|dopisz|wpisz|zapisz|stw[óo]rz|utw[óo]rz|ustaw|zaplanuj|zr[óo]b'), ' ')
    .replace(wordG('przypomnij(?:\\s+mi)?|przypomnienie|przypominaj(?:\\s+mi)?|alarm'), ' ')
    .replace(wordG('do\\s+kalendarza|w\\s+kalendarzu|wydarzenie|termin|prosz[ęe]'), ' ')
    .replace(wordG('mam|musz[ęe]|[żz]eby|[żz]e|bym'), ' ')
    .replace(/[,;.!?]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // wiszące przyimki na brzegach („w”, „na”, „o”, „we”, „dnia”)
  let prev;
  do {
    prev = rest;
    rest = rest.replace(new RegExp(`^(?:w|we|na|o|dnia|do|po)(?![${L}])\\s*`, 'iu'), '')
      .replace(new RegExp(`\\s*(?<![${L}])(?:w|we|na|o|dnia|do|po)$`, 'iu'), '').trim();
  } while (rest !== prev);

  const title = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : '';
  return { title, start, allDay, hasDate, hasTime, remindAtStart };
}

/** Lokalny zapis jak w formularzu kalendarza: `YYYY-MM-DD` albo `YYYY-MM-DDTHH:MM`. */
export function toLocalString(date, allDay = false) {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return allDay ? d : `${d}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
