import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceCommand, toLocalString } from '../public/utils/voice-parse.js';

// niedziela 8 listopada 2026, 14:00
const NOW = new Date(2026, 10, 8, 14, 0, 0);
const run = (text) => { const r = parseVoiceCommand(text, NOW); return { ...r, at: toLocalString(r.start, r.allDay) }; };

const cases = [
  ['jutro o 13:00 mam spotkanie w Rzeszowie', '2026-11-09T13:00', 'Spotkanie w Rzeszowie'],
  ['w środę o 9 rano dentysta', '2026-11-11T09:00', 'Dentysta'],
  ['przypomnij mi jutro o 10 żeby zadzwonić do mamy', '2026-11-09T10:00', 'Zadzwonić do mamy'],
  ['15 listopada urodziny Kasi', '2026-11-15', 'Urodziny Kasi'],
  ['za godzinę wyjście na spacer', '2026-11-08T15:00', 'Wyjście na spacer'],
  ['dzisiaj o 18:30 trening', '2026-11-08T18:30', 'Trening'],
  ['o 8 rano siłownia', '2026-11-09T08:00', 'Siłownia'],
  ['w sobotę o 20 kolacja', '2026-11-14T20:00', 'Kolacja'],
  ['w piątek wieczorem o 7 kino', '2026-11-13T19:00', 'Kino'],
  ['jutro o trzynastej wizyta u fryzjera', '2026-11-09T13:00', 'Wizyta u fryzjera'],
  ['20.11 o 14:30 wizyta u lekarza', '2026-11-20T14:30', 'Wizyta u lekarza'],
  ['za 2 godziny zadzwonić do Piotra', '2026-11-08T16:00', 'Zadzwonić do Piotra'],
  ['dodaj do kalendarza w niedzielę o 12 obiad u babci', '2026-11-15T12:00', 'Obiad u babci'],
];
for (const [text, at, title] of cases) {
  test(`„${text}”`, () => {
    const r = run(text);
    assert.equal(r.at, at);
    assert.equal(r.title, title);
  });
}

test('przypomnij → remindAtStart; samo wydarzenie → nie', () => {
  assert.equal(run('przypomnij mi jutro o 10 żeby zadzwonić').remindAtStart, true);
  assert.equal(run('jutro o 10 spotkanie').remindAtStart, false);
});
test('data bez godziny to wydarzenie całodzienne', () => {
  const r = run('15 listopada urodziny Kasi');
  assert.equal(r.allDay, true);
  assert.equal(r.hasTime, false);
});
