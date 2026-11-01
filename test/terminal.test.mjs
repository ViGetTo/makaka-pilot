import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { formatStatus, createConsoleView, displayWidth } from '../lib/terminal.mjs';

const sample = () => ({ version: '2.10.0', checkedAt: '2026-11-01T12:00:00Z', active: true,
  server: { wave: 65, bestWave: 64, bananas: 525059, damage: 5520, damageLevel: 27, damageCost: 750000 },
  battle: { wave: 65, killed: 15, total: 18 }, serverKills: { counted: 11, target: 15 },
  incomePerMinute: 55094, message: 'Фарм: сервер подтвердил 11/15 убийств.',
  automation: { stage: 'farm', attempts: 2, nextAttemptSeconds: 179 },
  rankings: { wave: { rank: 42, leaders: [{ place: 1, name: 'Альфа', value: 300 }] }, bananas: { rank: 99 } } });

test('console cards fit a narrow phone terminal and distinguish local kills, server progress, damage and ranks', () => {
  const output = formatStatus(sample(), { columns: 40 });
  for (const line of output.split('\n')) assert.equal(displayWidth(line), 39);
  assert.match(output, /525 059/); assert.match(output, /55 094/);
  assert.match(output, /11\/15/); assert.match(output, /15\/18/);
  assert.match(output, /02:59/); assert.match(output, /#42/); assert.match(output, /#99/);
  assert.match(output, /уровень 27/); assert.match(output, /300/);
  const colored = formatStatus(sample(), { columns: 40, color: true });
  assert.ok(new Set(colored.match(/\x1b\[[\d;]+m/g)).size >= 5);
  assert.equal(stripVTControlCharacters(colored), output);
});

test('player names cannot inject terminal controls and wide Unicode names do not break the frame', () => {
  const s = sample(); s.rankings.wave.leaders[0].name = '猫🐒\x1b[2J\x1b[31m\nBAD';
  const output = formatStatus(s, { columns: 30 });
  assert.equal(output.includes('\x1b'), false);
  for (const line of output.split('\n')) assert.equal(displayWidth(line), 29);
});

test('interactive output redraws its previous card and always restores the cursor', () => {
  const writes = [], stream = { isTTY: true, columns: 45, write: value => writes.push(value) };
  const view = createConsoleView(stream, { TERM: 'xterm-256color' });
  view.update(sample()); view.update({ ...sample(), battle: null }); view.close(); view.close();
  const output = writes.join('');
  assert.match(output, /\x1b\[\d+F/); assert.match(output, /\x1b\[2K/);
  assert.equal(output.includes('\x1b[2J'), false, 'scrollback must not be cleared');
  assert.equal((output.match(/\x1b\[\?25l/g) || []).length, 1);
  assert.equal((output.match(/\x1b\[\?25h/g) || []).length, 1);
});

test('plain logs contain no escape codes and are throttled while important state changes print immediately', () => {
  let now = 0;
  const writes = [], stream = { isTTY: false, write: value => writes.push(value) };
  const view = createConsoleView(stream, { NO_COLOR: '' }, () => now);
  view.update(sample()); now = 1000; view.update(sample());
  assert.equal(writes.length, 1);
  now = 5000; view.update(sample()); assert.equal(writes.length, 2);
  view.update({ ...sample(), active: false }); assert.equal(writes.length, 3);
  view.close(); assert.equal(writes.join('').includes('\x1b'), false);
});
